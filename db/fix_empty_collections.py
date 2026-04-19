"""
Repuebla collection_albums para colecciones que quedaron vacías tras la deduplicación.
Lee los rym_chart_cache.json y busca cada álbum en la BD por normalización artist+title.
"""
import sqlite3
import json
import re
import sys
from pathlib import Path

DB   = Path(__file__).parent / "must_hear_rym_new.db"
CHARTS = Path.home() / "gits/pollo/rym_lastfm/docs/must_hear/rym_charts"

def norm(s):
    return re.sub(r"[^\w]", "", (s or "").lower())

def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # Colecciones vacías
    empty = conn.execute("""
        SELECT c.id, c.slug FROM collections c
        LEFT JOIN collection_albums ca ON ca.collection_id = c.id
        WHERE c.slug LIKE 'rym_chart_all_time_%'
        GROUP BY c.id HAVING COUNT(ca.album_id) = 0
        ORDER BY c.slug
    """).fetchall()

    print(f"Colecciones vacías: {len(empty)}")

    # Construir índice norm(artist)+norm(title) → album_id
    print("Construyendo índice de álbumes...", end=" ", flush=True)
    rows = conn.execute("""
        SELECT al.id, ar.name AS artist, al.name AS title
        FROM albums al JOIN artists ar ON ar.id = al.artist_id
    """).fetchall()
    idx = {}
    for r in rows:
        # Cada línea del nombre (nombres dobles con \n) genera variantes
        artists = [r["artist"]] + r["artist"].split("\n")
        titles  = [r["title"]]  + r["title"].split("\n")
        for a in artists:
            for t in titles:
                key = (norm(a), norm(t))
                if key not in idx:
                    idx[key] = r["id"]
    print(f"{len(idx)} entradas")

    total_linked = 0
    total_missing = 0

    for coll in empty:
        slug = coll["slug"]
        coll_id = coll["id"]
        chart_dir = CHARTS / slug
        cache_file = chart_dir / "rym_chart_cache.json"

        if not cache_file.exists():
            print(f"  ⚠️  JSON no encontrado: {cache_file}")
            continue

        albums = json.loads(cache_file.read_text(encoding="utf-8"))
        linked = 0
        missing = []

        for entry in albums:
            rank    = entry.get("number")
            artists = [entry["artist"]] + entry["artist"].split("\n")
            titles  = [entry["title"]]  + entry["title"].split("\n")

            album_id = None
            for a in artists:
                for t in titles:
                    album_id = idx.get((norm(a), norm(t)))
                    if album_id:
                        break
                if album_id:
                    break

            if album_id:
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO collection_albums (collection_id, album_id, rank) VALUES (?,?,?)",
                        (coll_id, album_id, rank)
                    )
                    linked += 1
                except Exception as e:
                    print(f"    DB error: {e}")
            else:
                missing.append(f"{entry['artist']} — {entry['title']}")

        conn.commit()
        total_linked  += linked
        total_missing += len(missing)
        print(f"  ✓ {slug}: {linked}/{len(albums)} enlazados, {len(missing)} no encontrados")
        if missing and len(missing) <= 5:
            for m in missing:
                print(f"      ✗ {m}")

    print(f"\nResumen: {total_linked} enlaces creados, {total_missing} álbumes no encontrados en BD")
    conn.close()

if __name__ == "__main__":
    main()
