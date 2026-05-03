"""
Resuelve los redirects de CoverArtArchive para álbumes con release_group_mbid
pero sin URL directa de archive.org en cover_url.

Corre en local (heavy-lifting). Usa threads con rate-limiting por thread.
Actualiza albums.cover_url con la URL directa de archive.org.

Uso:
    python3 db/resolve_caa_covers.py
    python3 db/resolve_caa_covers.py --threads 4 --limit 5000
    python3 db/resolve_caa_covers.py --only-in-collections   # solo álbumes usados
"""
import sqlite3
import ssl
import time
import argparse
import itertools
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
import urllib.request
import urllib.error

DB = "db/must_hear.db"
CAA = "https://coverartarchive.org/release-group"
RATE_LIMIT = 1.2   # segundos entre requests por thread
db_lock = Lock()

HEADERS = {"User-Agent": "cover-resolver/1.0 (frodobolson@disroot.org)"}

_SSL_CTX = ssl.create_default_context()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


_opener = urllib.request.build_opener(_NoRedirect())


def resolve_caa(mbid: str) -> str:
    """HEAD a CAA, devuelve la URL de archive.org del redirect 307, o '' si falla."""
    url = f"{CAA}/{mbid}/front-500"
    try:
        req = urllib.request.Request(url, headers=HEADERS, method="HEAD")
        _opener.open(req, timeout=10)
        return url   # sin redirect → URL ya directa
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "")
        return loc if loc and "archive.org" in loc else ""
    except Exception:
        return ""


def _needs_resolve(cover_url: str | None) -> bool:
    if not cover_url:
        return True
    if cover_url.startswith("data:"):
        return True
    blocked = ("snmc.io", "sputnikmusic", "albumoftheyear", "aoty.org",
               "cdn2.alb", "bandcamp", "coverartarchive.org")
    return any(b in cover_url for b in blocked)


def process_batch(batch: list[tuple]) -> dict:
    counts = {"updated": 0, "not_found": 0, "error": 0}
    conn = sqlite3.connect(DB, timeout=30)
    for album_id, mbid in batch:
        time.sleep(RATE_LIMIT)
        try:
            url = resolve_caa(mbid)
            with db_lock:
                if url:
                    conn.execute("UPDATE albums SET cover_url=? WHERE id=?", (url, album_id))
                    conn.commit()
                    counts["updated"] += 1
                else:
                    counts["not_found"] += 1
        except Exception as e:
            counts["error"] += 1
    conn.close()
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--limit",   type=int, default=0, help="0 = sin límite")
    parser.add_argument("--start-from", type=int, default=0)
    parser.add_argument("--only-in-collections", action="store_true",
                        help="Solo álbumes que aparecen en al menos una colección")
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    if args.only_in_collections:
        rows = conn.execute("""
            SELECT DISTINCT al.id, al.release_group_mbid
            FROM albums al
            JOIN collection_albums ca ON ca.album_id = al.id
            WHERE al.release_group_mbid IS NOT NULL
        """).fetchall()
    else:
        rows = conn.execute("""
            SELECT id, release_group_mbid FROM albums
            WHERE release_group_mbid IS NOT NULL
        """).fetchall()
    conn.close()

    conn = sqlite3.connect(DB)
    query = """
        SELECT al.id, al.release_group_mbid, al.cover_url
        FROM albums al
        {join}
        WHERE al.release_group_mbid IS NOT NULL
    """
    if args.only_in_collections:
        q = query.format(join="JOIN collection_albums ca ON ca.album_id = al.id")
        rows_with_cover = conn.execute(q).fetchall()
        # deduplicar
        seen = set()
        rows_with_cover = [r for r in rows_with_cover if r[0] not in seen and not seen.add(r[0])]
    else:
        rows_with_cover = conn.execute(query.format(join="")).fetchall()
    conn.close()

    rows = [(r[0], r[1]) for r in rows_with_cover if _needs_resolve(r[2])]

    if args.start_from:
        rows = rows[args.start_from:]
        print(f"⏩ Saltando {args.start_from}, empezando desde #{args.start_from + 1}")

    if args.limit:
        rows = rows[:args.limit]

    print(f"📀 {len(rows)} álbumes a resolver con {args.threads} threads")
    print(f"   Tiempo estimado: ~{len(rows) * RATE_LIMIT / args.threads / 3600:.1f}h")

    # Dividir en batches por thread
    batches = [rows[i::args.threads] for i in range(args.threads)]
    totals = {"updated": 0, "not_found": 0, "error": 0}
    done = [0]

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        futures = {executor.submit(process_batch, b): b for b in batches if b}
        for future in as_completed(futures):
            result = future.result()
            for k in totals:
                totals[k] += result[k]

    print(f"\n✨ Completado:")
    print(f"   updated:   {totals['updated']}")
    print(f"   not_found: {totals['not_found']}")
    print(f"   errors:    {totals['error']}")


if __name__ == "__main__":
    main()
