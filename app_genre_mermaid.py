"""
html_genre_mermaid.py — Standalone RYM Genre Tree visualizer.

Generates docs/must_hear/genre_tree.html (or --output path).

Usage:
    python3 html_genre_mermaid.py --mh-db db/must_hear_rym_new.db
    python3 html_genre_mermaid.py --mh-db db/must_hear_rym_new.db \\
        --genres-json db/genres.json \\
        --output genre_tree.html

Can also be called from html_must_hear.py via --rym-genre-mermaid.

Tree behaviour:
  - Left sidebar: main genres. Selecting one shows root + direct children.
  - Click a node body → expand its children one level at a time.
  - Click the "+" button on any node → open info panel (desc + YouTube).
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path


# ── helpers ────────────────────────────────────────────────────────────────

def _chart_slug(genre_slug: str) -> str:
    return "genre_" + genre_slug.replace("-", "_")


def _count_all(node: dict) -> int:
    return sum(1 + _count_all(s) for s in node.get("subgenres", []))


# ── data gathering ─────────────────────────────────────────────────────────

def load_genre_tree(genres_json: Path) -> list[dict]:
    return json.loads(genres_json.read_text(encoding="utf-8"))


def get_scraped_collections(
    mh_conn: sqlite3.Connection,
    charts_dir: Path | None = None,
) -> dict[str, dict]:
    rows = mh_conn.execute("""
        SELECT c.slug, COUNT(ca.album_id) AS total
        FROM collections c
        JOIN collection_albums ca ON ca.collection_id = c.id
        WHERE c.slug LIKE 'genre_%'
        GROUP BY c.id
    """).fetchall()
    result = {r[0]: {"total": r[1]} for r in rows}

    # Also scan charts_dir for cache JSONs not yet imported into DB
    if charts_dir and charts_dir.is_dir():
        for d in charts_dir.iterdir():
            if not (d.is_dir() and d.name.startswith("genre_")):
                continue
            if d.name in result:
                continue
            cache = d / "chart_cache.json"
            if cache.exists():
                try:
                    albums = json.loads(cache.read_text(encoding="utf-8"))
                    result[d.name] = {"total": len(albums)}
                except Exception:
                    pass
    return result


def get_all_album_pairs_per_collection(
    mh_conn: sqlite3.Connection,
    collection_slugs: list[str],
    charts_dir: Path | None = None,
) -> dict[str, list[list[str]]]:
    """Return [[artist_lower, title_lower], ...] for all albums (no yt_id filter) per slug."""
    result: dict[str, list[list[str]]] = {}
    db_slugs: set[str] = set()

    for slug in collection_slugs:
        rows = mh_conn.execute("""
            SELECT LOWER(TRIM(ar.name)), LOWER(TRIM(al.name))
            FROM collection_albums ca
            JOIN collections c  ON c.id  = ca.collection_id
            JOIN albums al      ON al.id = ca.album_id
            JOIN artists ar     ON ar.id = al.artist_id
            WHERE c.slug = ?
        """, (slug,)).fetchall()
        if rows:
            db_slugs.add(slug)
            result[slug] = [[r[0], r[1]] for r in rows]

    if charts_dir and charts_dir.is_dir():
        for slug in collection_slugs:
            if slug in db_slugs:
                continue
            cache = charts_dir / slug / "chart_cache.json"
            if not cache.exists():
                continue
            try:
                raw = json.loads(cache.read_text(encoding="utf-8"))
                result[slug] = [
                    [a.get("artist", "").lower().strip(),
                     a.get("title", "").lower().strip()]
                    for a in raw
                    if a.get("artist") or a.get("title")
                ]
            except Exception:
                pass
    return result


def get_top_albums_per_collection(
    mh_conn: sqlite3.Connection,
    collection_slugs: list[str],
    n_yt: int = 15,
    n_fetch: int = 40,
    charts_dir: Path | None = None,
) -> dict[str, list[dict]]:
    """Return up to n_yt albums WITH yt_id per collection, preserving original rank."""
    result: dict[str, list[dict]] = {}

    # Batch yt_id lookup by (artist_lower, title_lower) for cache-JSON enrichment
    yt_lookup: dict[tuple, str] = {}
    if charts_dir:
        for row in mh_conn.execute("""
            SELECT LOWER(TRIM(ar.name)), LOWER(TRIM(al.name)), al.yt_id
            FROM albums al JOIN artists ar ON ar.id = al.artist_id
            WHERE al.yt_id IS NOT NULL AND al.yt_id != ''
        """).fetchall():
            yt_lookup[(row[0], row[1])] = row[2]

    db_slugs: set[str] = set()
    for slug in collection_slugs:
        rows = mh_conn.execute("""
            SELECT ar.name, al.name, al.year, al.release_group_mbid, al.yt_id,
                   COALESCE(ca.rank, 0) AS rank
            FROM collection_albums ca
            JOIN collections c  ON c.id  = ca.collection_id
            JOIN albums al      ON al.id = ca.album_id
            JOIN artists ar     ON ar.id = al.artist_id
            WHERE c.slug = ? AND al.yt_id IS NOT NULL AND al.yt_id != ''
            ORDER BY ca.rank ASC NULLS LAST
            LIMIT ?
        """, (slug, n_yt)).fetchall()
        if rows:
            db_slugs.add(slug)
            result[slug] = [
                {"artist": r[0], "title": r[1], "year": r[2] or "",
                 "mbid": r[3] or "", "yt_id": r[4], "rank": r[5] or 0}
                for r in rows
            ]

    # For slugs not in DB, read from cache JSON + enrich yt_ids
    if charts_dir and charts_dir.is_dir():
        for slug in collection_slugs:
            if slug in db_slugs:
                continue
            cache = charts_dir / slug / "chart_cache.json"
            if not cache.exists():
                continue
            try:
                raw = json.loads(cache.read_text(encoding="utf-8"))
            except Exception:
                continue
            enriched = []
            for a in raw[:n_fetch]:
                yt_id = a.get("yt_id") or ""
                if not yt_id:
                    key = (a.get("artist", "").lower().strip(),
                           a.get("title", "").lower().strip())
                    yt_id = yt_lookup.get(key, "")
                if yt_id:
                    enriched.append({
                        "artist": a.get("artist", ""),
                        "title":  a.get("title", ""),
                        "year":   a.get("year", "") or "",
                        "mbid":   a.get("mbid", "") or "",
                        "yt_id":  yt_id,
                        "rank":   a.get("number", 0),
                    })
                    if len(enriched) >= n_yt:
                        break
            if enriched:
                result[slug] = enriched
    return result


def build_panel_data(
    genre_tree: list[dict],
    scraped_map: dict[str, dict],
    top_albums: dict[str, list[dict]],
) -> dict[str, dict]:
    data: dict[str, dict] = {}

    def walk(nodes: list[dict]) -> None:
        for n in nodes:
            slug  = n["slug"]
            cslug = _chart_slug(slug)
            data[slug] = {
                "name":   n["name"],
                "desc":   n.get("desc", ""),
                "total":  scraped_map.get(cslug, {}).get("total", 0),
                "cslug":  cslug if cslug in scraped_map else "",
                "albums": top_albums.get(cslug, []),
            }
            walk(n.get("subgenres", []))

    walk(genre_tree)
    return data


# ── HTML rendering ─────────────────────────────────────────────────────────

def render_html(
    genre_tree: list[dict],
    panel_data: dict[str, dict],
    scraped_map: dict[str, dict],
    generated: str,
    all_pairs: dict[str, list] = None,
) -> str:
    # Compact tree for JS: {s, n, c[]}
    def _compact(nodes: list[dict]) -> list[dict]:
        return [{"s": n["slug"], "n": n["name"],
                 "c": _compact(n.get("subgenres", []))} for n in nodes]

    combined_data = {
        "tree":      _compact(genre_tree),
        "charts":    {cs: d["total"] for cs, d in scraped_map.items()},
        "panelData": panel_data,
        "allPairs":  all_pairs or {},
    }
    combined_json = json.dumps(combined_data, ensure_ascii=False, separators=(",", ":"))
    combined_json = combined_json.replace("</script>", r"<\/script>")

    n_scraped = len(scraped_map)
    n_total   = sum(1 + _count_all(g) for g in genre_tree)

    # Sidebar HTML: one entry per main genre
    sidebar_html = ""
    for g in genre_tree:
        cslug   = _chart_slug(g["slug"])
        scraped = cslug in scraped_map
        cls = "mg-link" + (" scraped" if scraped else "")
        sidebar_html += (
            f'<div class="{cls}" data-slug="{g["slug"]}">'
            f'<span class="dot{"" if not scraped else " dot-scraped"}"></span>'
            f'{g["name"]}'
            f'</div>\n'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Genre Tree</title>
<link rel="icon" type="image/png" href="/img/boar.png" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="icon" type="image/png" href="/images/discount.png" />
<script defer src="https://cloud.umami.is/script.js" data-website-id="c8ed5b67-0cf6-4b14-b498-a324fd4371ad"></script>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<link rel="stylesheet" href="/static/css/genre_mermaid.css">
</head>
<body>
<header>
  <div class="mh-title">Géneros</div>
  <nav class="mh-nav">
    <a class="mh-na on" href="genre_tree.html">Géneros</a>
  </nav>
  <div id="user-form">
    <input id="user-input" type="text" placeholder="usuario last.fm"
           autocomplete="off" spellcheck="false">
    <button id="user-load-btn">Cargar</button>
    <span id="user-status"></span>
  </div>
</header>

<div id="layout">
  <div id="tree-wrap">
    <svg id="tree-svg"></svg>
    <div id="tree-placeholder">Selecciona un género para ver su árbol</div>
    <div id="sb-bar">
      <div class="sb-wrap">
        <input id="sb-genre-inp" class="sb-inp" type="text" placeholder="Buscar género…" autocomplete="off">
        <div class="sb-dd" id="sb-genre-dd"></div>
      </div>
      <div class="sb-wrap">
        <input id="sb-artist-inp" class="sb-inp" type="text" placeholder="Buscar artista…" autocomplete="off">
        <div class="sb-dd" id="sb-artist-dd"></div>
      </div>
    </div>
    <div class="genre-picker" id="genrePicker">
      <button class="genre-picker-btn" id="gpBtn">
        <span id="gpLabel">Selecciona un género…</span>
        <span class="gp-caret">▾</span>
      </button>
      <div class="genre-picker-dd" id="gpDd">
{sidebar_html}      </div>
    </div>
  </div>

  <aside id="panel">
    <div id="panel-scroll">
      <button class="panel-close">✕</button>
      <div id="panel-body"></div>
    </div>
    <div id="panel-video-area">
      <div class="panel-pag-row">
        <button id="panelPrev" class="panel-pag-btn">&#8592;</button>
        <span id="panelPgInfo" style="font-family:'DM Mono',monospace;font-size:.56rem;color:var(--muted)"></span>
        <button id="panelNext" class="panel-pag-btn">&#8594;</button>
      </div>
      <div id="panel-alb-pages"></div>
    </div>
  </aside>
</div>

<script type="application/json" id="app-data">{combined_json}</script>
<script src="/static/js/genre_mermaid.js"></script>
</body>
</html>
"""


# ── entry point ────────────────────────────────────────────────────────────

def run(args: argparse.Namespace) -> None:
    mh_db = Path(args.mh_db)
    if not mh_db.exists():
        raise FileNotFoundError(f"must_hear DB not found: {mh_db}")

    if getattr(args, "genres_json", ""):
        genres_json = Path(args.genres_json)
    else:
        candidates = [
            mh_db.parent.parent / "genres.json",
            mh_db.parent / "genres.json",
        ]
        genres_json = next((p for p in candidates if p.exists()), None)
        if genres_json is None:
            raise FileNotFoundError(
                "genres.json not found; pass --genres-json explicitly"
            )

    out_path = Path(getattr(args, "output", "") or
                    str(mh_db.parent.parent / "genre_tree.html"))

    print(f"📂 genres JSON : {genres_json}")
    print(f"🗄  must_hear DB: {mh_db}")

    genre_tree = load_genre_tree(genres_json)
    print(f"🌳 {len(genre_tree)} main genres")

    charts_dir = out_path.parent / "genre_charts"

    n_yt = getattr(args, "yt_videos", 15)

    conn = sqlite3.connect(str(mh_db))
    scraped_map  = get_scraped_collections(conn, charts_dir=charts_dir)
    top_albums   = get_top_albums_per_collection(
        conn, list(scraped_map.keys()), n_yt=n_yt, n_fetch=max(n_yt * 3, 40), charts_dir=charts_dir
    )
    all_pairs    = get_all_album_pairs_per_collection(
        conn, list(scraped_map.keys()), charts_dir=charts_dir
    )
    conn.close()
    print(f"✅ {len(scraped_map)} scraped collections  (top {n_yt} vídeos por colección)")

    panel_data = build_panel_data(genre_tree, scraped_map, top_albums)
    generated  = datetime.now().strftime("%Y-%m-%d %H:%M")

    html = render_html(genre_tree, panel_data, scraped_map, generated, all_pairs=all_pairs)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    print(f"✨ {out_path}  ({len(html)//1024}KB)")


def main() -> None:
    p = argparse.ArgumentParser(description="Generate Genre Tree interactive page")
    p.add_argument("--mh-db",       required=True, help="Path to must_hear DB")
    p.add_argument("--genres-json", default="",    help="Path to genres.json")
    p.add_argument("--output",      default="",    help="Output HTML path")
    p.add_argument("--yt-videos",   type=int, default=15,
                   help="Max YouTube videos to embed per genre panel (default: 15)")
    run(p.parse_args())


if __name__ == "__main__":
    main()
