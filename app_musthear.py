#!/usr/bin/env python3
"""
musthear — Flask backend
Muestra colecciones (Scaruffi, AOTY, Pitchfork…) agrupadas por fuente.
Compatible con el formato de sesión de tumtumpa (app_discover.py).

Uso:
    python app_musthear.py --db path/to/must_hear.db --lastfm-api-key KEY [--port 5002]
"""
import os
import re
import json
import time
import random
import base64
import sqlite3
import argparse
import subprocess
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from functools import lru_cache

try:
    import yaml as _yaml
    _YAML_OK = True
except ImportError:
    _YAML_OK = False

from flask import Flask, jsonify, request, render_template_string, abort, Response, stream_with_context, send_from_directory

app = Flask(__name__, static_folder='static', static_url_path='/static')

# ── Config ────────────────────────────────────────────────────────────────────
DB_PATH     = os.environ.get("DB_PATH") or None
LFM_API_KEY = os.environ.get("LASTFM_API_KEY") or None
CAA         = "https://coverartarchive.org/release-group"

_LFM_NO_IMG = "2a96cbd8b46e442fc41c2b86b821562f"

# ── Genre index (para tags de álbumes) ────────
_SLUG_PATH: dict = {}
_SLUG_NAME: dict = {}

def _build_index(nodes: list, path: list) -> None:
    for n in nodes:
        p = path + [n["slug"]]
        _SLUG_PATH[n["slug"]] = p
        _SLUG_NAME[n["slug"]] = n["name"]
        _build_index(n.get("subgenres", []), p)

def _load() -> None:
    for candidate in [
        Path(__file__).parent / "db/genres.json",
        Path(__file__).parent / "docs/must_hear/charts/genres.json",
    ]:
        if candidate.exists():
            _build_index(json.loads(candidate.read_text(encoding="utf-8")), [])
            break

_load()

_ALLOWED_COVER_DOMAINS = (
    "coverartarchive.org", "archive.org",
    "discogs.com", "discogs-images.com",
    "lastfm.freetls.fastly.net", "lastfm.freetls",
)

def _is_allowed_cover(url: str) -> bool:
    if not url or url.startswith("data:"):
        return False
    return any(d in url for d in _ALLOWED_COVER_DOMAINS)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return re.sub(r"[^\w]", "", (s or "").lower())


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── Last.fm API ────────────────────────────────────────────────────────────────

def _lfm_image(images: list, size: str = "extralarge") -> str:
    for img in images:
        url = img.get("#text", "")
        if img.get("size") == size and url and _LFM_NO_IMG not in url:
            return url
    return ""


def lfm_get(method: str, params: dict) -> dict:
    base = "https://ws.audioscrobbler.com/2.0/"
    params = {**params, "method": method, "api_key": LFM_API_KEY, "format": "json"}
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "musthear/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {"error": f"HTTP {e.code}", "message": body[:300]}
    except Exception as e:
        return {"error": str(e)}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

_no_redirect_opener = urllib.request.build_opener(_NoRedirect())

def _resolve_caa(mbid: str) -> str:
    return _follow_caa_redirect(f"{CAA}/{mbid}/front-500")

def _resolve_caa_release(mbid: str) -> str:
    return _follow_caa_redirect(f"https://coverartarchive.org/release/{mbid}/front-500")

def _follow_caa_redirect(url: str) -> str:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "musthear/1.0"}, method="HEAD")
        _no_redirect_opener.open(req, timeout=8)
        return url
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "")
        return loc if loc else ""
    except Exception:
        return ""


def mb_search_release_group(artist: str, album: str) -> dict:
    q = 'artist:"{}" AND release:"{}"'.format(
        artist.replace('"', ''), album.replace('"', '')
    )
    url = ("https://musicbrainz.org/ws/2/release-group?"
           + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": "1"}))
    req = urllib.request.Request(url, headers={
        "User-Agent": "musthear/1.0 (https://github.com/HuanPc/escuchowsky)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read())
        rgs = data.get("release-groups", [])
        if rgs:
            rg = rgs[0]
            ac = rg.get("artist-credit") or []
            mb_artist = ac[0].get("name", artist) if ac else artist
            return {
                "mbid":   rg.get("id", ""),
                "title":  rg.get("title", album),
                "artist": mb_artist,
                "date":   rg.get("first-release-date", ""),
            }
    except Exception:
        pass
    return {}


# ── DB queries ─────────────────────────────────────────────────────────────────

def _collection_group(slug: str, name: str) -> str:
    s = slug.lower()
    prefixes = [
        ("aoty_",            "AOTY"),
        ("scaruffi_",        "Scaruffi"),
        ("bandcamp",         "Bandcamp"),
        ("kerrang",          "Kerrang!"),
        ("pitchfork",        "Pitchfork"),
        ("sputnik_",         "Sputnikmusic"),
        ("sputnikmusic",     "Sputnikmusic"),
        ("resident_advisor", "Resident Advisor"),
        ("rolling_stone",    "Rolling Stone"),
        ("grammy",           "Grammy"),
        ("juno",             "Juno Awards"),
        ("mu_",              "/mu/ 4chan"),
    ]
    for prefix, group in prefixes:
        if s.startswith(prefix):
            return group
    return "Otros"


def _load_ignore_slugs() -> set:
    """Reads musthear_ignored.yaml — slugs list."""
    p = Path(__file__).parent / "musthear_ignored.yaml"
    if not p.exists():
        return set()
    try:
        if _YAML_OK:
            data = _yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            return set(data.get("slugs") or [])
        # Fallback: parse simple list manually
        slugs = set()
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("-"):
                slug = line[1:].strip().strip('"').strip("'")
                if slug:
                    slugs.add(slug)
        return slugs
    except Exception:
        return set()


@lru_cache(maxsize=1)
def _get_all_musthear_raw() -> tuple:
    """All non-empty musthear, cached. Reload app to refresh."""
    conn = get_db()
    rows = conn.execute("""
        SELECT c.id, c.slug, c.name, c.total_albums, c.source_type
        FROM collections c
        JOIN collection_albums ca ON ca.collection_id = c.id
        GROUP BY c.id
        HAVING COUNT(ca.album_id) > 0
        ORDER BY c.name
    """).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["group"] = _collection_group(d["slug"], d["name"])
        result.append(d)
    return tuple(result)


def _get_album_chart_genres(conn, album_ids: list) -> dict:
    """Returns genre ancestors for albums that appear in any chart."""
    if not album_ids:
        return {}
    placeholders = ",".join("?" * len(album_ids))
    rows = conn.execute(f"""
        SELECT ca.album_id, c.slug
        FROM collection_albums ca
        JOIN collections c ON c.id = ca.collection_id
        WHERE c.slug LIKE 'genre_%'
        AND ca.album_id IN ({placeholders})
    """, album_ids).fetchall()
    tmp: dict[int, dict] = {}
    for r in rows:
        aid = r["album_id"]
        json_slug = r["slug"].replace("genre_", "").replace("_", "-")
        path = _SLUG_PATH.get(json_slug)
        seen = tmp.setdefault(aid, {})
        if path:
            for depth, s in enumerate(path, 1):
                if s not in seen:
                    seen[s] = {"name": _SLUG_NAME.get(s, s), "depth": depth}
    return {aid: sorted(genres.values(), key=lambda x: x["depth"])
            for aid, genres in tmp.items()}


def get_collection_albums(slug: str) -> list[dict]:
    conn = get_db()
    rows = conn.execute("""
        SELECT
            al.id, ar.name AS artist, al.name AS title,
            al.year, al.release_group_mbid AS mbid,
            ca.rank, al.cover_url, al.yt_id,
            al.aoty_critic_score, al.scaruffi_rating
        FROM collection_albums ca
        JOIN collections c  ON c.id  = ca.collection_id
        JOIN albums al       ON al.id = ca.album_id
        JOIN artists ar      ON ar.id = al.artist_id
        WHERE c.slug = ?
        ORDER BY ca.rank ASC NULLS LAST, al.year ASC
    """, (slug,)).fetchall()
    album_ids = [r["id"] for r in rows]
    genres_map = _get_album_chart_genres(conn, album_ids)
    conn.close()
    result = []
    for i, r in enumerate(rows):
        d = dict(r)
        d["number"] = d["rank"] or (i + 1)
        raw = d.get("cover_url") or ""
        if not _is_allowed_cover(raw):
            raw = ""
        d["cover"] = raw or (f"{CAA}/{d['mbid']}/front-500" if d.get("mbid") else "")
        d["genres"] = genres_map.get(d["id"], [])
        result.append(d)
    return result


# ── API endpoints ──────────────────────────────────────────────────────────────

@app.route("/api/musthear")
def api_musthear():
    ignore = _load_ignore_slugs()
    result = [
        c for c in _get_all_musthear_raw()
        if not c["slug"].startswith("genre_")
        and c["slug"] not in ignore
    ]
    return jsonify(result)


@app.route("/api/collection")
def api_collection():
    slug = request.args.get("slug", "").strip()
    if not slug:
        return jsonify({"error": "Parámetro 'slug' requerido"}), 400
    albums = get_collection_albums(slug)
    if not albums:
        return jsonify({"error": f"Colección '{slug}' no encontrada o vacía"}), 404
    result = [{
        "n":       a["number"],
        "artist":  a["artist"],
        "title":   a["title"],
        "year":    a.get("year"),
        "mbid":    a.get("mbid", ""),
        "cover":   a.get("cover", ""),
        "yt_id":   a.get("yt_id", ""),
        "aoty":    a.get("aoty_critic_score"),
        "scaruffi":a.get("scaruffi_rating"),
        "genres":  a.get("genres", []),
    } for a in albums]
    return jsonify({"slug": slug, "albums": result})


@app.route("/api/scrobbles")
def api_scrobbles():
    """
    SSE: descarga historial completo via getTopAlbums + getTopTracks.
    Formato idéntico a tumtumpa (app_discover.py) para poder reutilizar sesiones JSON.
    """
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    if not LFM_API_KEY:
        return jsonify({"error": "Last.fm API key no configurada"}), 500

    def _lfm_paged(method, result_key, uname, extra_params=None):
        page_delay = 0.5
        page = 1
        total_pages = None
        params = {"user": uname, "limit": 200, "page": page, **(extra_params or {})}
        while True:
            params["page"] = page
            last_error = None
            for attempt in range(6):
                data = lfm_get(method, params)
                container = data.get(result_key, {})
                if "error" not in data or container:
                    last_error = None
                    break
                err_code = data.get("error")
                last_error = data.get("message") or str(err_code) or "Error Last.fm"
                if attempt < 5:
                    wait = 60 * (attempt + 1) if err_code == 29 else 10 * (3 ** min(attempt, 3))
                    if err_code == 29:
                        page_delay = 2.0
                    yield None, page, total_pages, wait
                    time.sleep(wait)
            if last_error:
                yield None, page, total_pages, -1
                return
            attrs = container.get("@attr", {})
            try:
                tp = max(1, int(attrs.get("totalPages", 1)))
            except (ValueError, TypeError):
                tp = 1
            if total_pages is None or tp > total_pages:
                total_pages = tp
            items_key = [k for k in container if k != "@attr"]
            items = container.get(items_key[0], []) if items_key else []
            if isinstance(items, dict):
                items = [items]
            yield items, page, total_pages, 0
            if page >= total_pages:
                return
            page += 1
            time.sleep(page_delay + random.random() * 0.4)

    def generate():
        heard_counts  = {}   # (norm_a, norm_album) → [orig_a, orig_album, count]
        heard_songs   = {}   # (norm_a, norm_track) → [orig_a, orig_album, orig_track, count]
        heard_artists = set()
        last_scrobble_ts     = 0
        last_scrobble_artist = ""
        last_scrobble_track  = ""
        total_album_pages    = 0

        # Fase 1: álbumes
        for items, page, total_pages, signal in _lfm_paged(
            "user.getTopAlbums", "topalbums", username, {"period": "overall"}
        ):
            if signal == -1:
                yield f"data: {json.dumps({'error': 'Error descargando álbumes de Last.fm'})}\n\n"
                return
            if signal > 0:
                yield f"data: {json.dumps({'waiting': signal, 'page': page, 'total_pages': total_pages, 'count': len(heard_counts)})}\n\n"
                continue
            if items is None:
                continue
            for a in items:
                artist_obj = a.get("artist", {})
                artist = artist_obj.get("name", "") if isinstance(artist_obj, dict) else str(artist_obj)
                album = a.get("name", "")
                try:
                    count = int(a.get("playcount", 1) or 1)
                except (ValueError, TypeError):
                    count = 1
                if artist:
                    heard_artists.add(_norm(artist))
                if artist and album:
                    key = (_norm(artist), _norm(album))
                    heard_counts[key] = [artist, album, max(count, heard_counts.get(key, [0, 0, 0])[2])]
            total_album_pages = total_pages or 0
            yield f"data: {json.dumps({'page': page, 'total_pages': total_album_pages, 'count': len(heard_counts)})}\n\n"

        # Fase 2: canciones (opcional, no falla si hay error)
        for items, page, total_pages, signal in _lfm_paged(
            "user.getTopTracks", "toptracks", username, {"period": "overall"}
        ):
            if signal == -1:
                break
            if signal > 0:
                yield f"data: {json.dumps({'waiting': signal, 'page': page, 'total_pages': total_pages, 'count': len(heard_counts)})}\n\n"
                continue
            if items is None:
                continue
            for t in items:
                artist_obj = t.get("artist", {})
                artist = artist_obj.get("name", "") if isinstance(artist_obj, dict) else str(artist_obj)
                track_name = t.get("name", "")
                album_obj  = t.get("album", {})
                album = album_obj.get("#text", "") if isinstance(album_obj, dict) else ""
                try:
                    count = int(t.get("playcount", 1) or 1)
                except (ValueError, TypeError):
                    count = 1
                if artist and track_name:
                    skey = (_norm(artist), _norm(track_name))
                    heard_songs[skey] = [artist, album, track_name,
                                         max(count, heard_songs.get(skey, [0, 0, 0, 0])[3])]
            yield f"data: {json.dumps({'page': total_album_pages + page, 'total_pages': total_album_pages + (total_pages or 1), 'count': len(heard_counts)})}\n\n"

        # Fase 3: info del último scrobble
        recent = lfm_get("user.getRecentTracks", {"user": username, "limit": 1, "page": 1})
        rt = recent.get("recenttracks", {})
        if rt:
            tracks = rt.get("track", [])
            if isinstance(tracks, dict):
                tracks = [tracks]
            for t in tracks:
                if isinstance(t.get("@attr"), dict) and t["@attr"].get("nowplaying"):
                    continue
                artist_obj = t.get("artist", {})
                artist = artist_obj.get("#text", "") if isinstance(artist_obj, dict) else str(artist_obj)
                d = t.get("date", {})
                try:
                    last_scrobble_ts = int(d.get("uts", 0)) if isinstance(d, dict) else 0
                except (ValueError, TypeError):
                    last_scrobble_ts = 0
                last_scrobble_artist = artist
                last_scrobble_track  = t.get("name", "")
                break

        heard_pairs     = [[k[0], k[1], v[0], v[1], v[2]] for k, v in heard_counts.items()]
        heard_song_list = [[k[0], k[1], v[0], v[1], v[2], v[3]] for k, v in heard_songs.items()]
        yield f"data: {json.dumps({'done': True, 'user': username, 'count': len(heard_pairs), 'fetched_at': int(time.time()), 'heard': heard_pairs, 'heard_songs': heard_song_list, 'heard_artists': list(heard_artists), 'last_scrobble_ts': last_scrobble_ts, 'last_scrobble_artist': last_scrobble_artist, 'last_scrobble_track': last_scrobble_track, 'total_pages': total_album_pages})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/scrobbles/since")
def api_scrobbles_since():
    """Sync incremental: solo pistas nuevas desde `since` (Unix timestamp)."""
    username = request.args.get("user", "").strip()
    since    = request.args.get("since", "0").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    if not LFM_API_KEY:
        return jsonify({"error": "Last.fm API key no configurada"}), 500
    try:
        since = int(since)
    except ValueError:
        since = 0

    new_counts           = {}
    new_songs            = {}
    page                 = 1
    total_pages          = 1
    last_scrobble_ts     = 0
    last_scrobble_artist = ""
    last_scrobble_track  = ""
    while page <= total_pages:
        params = {"user": username, "limit": 200, "page": page}
        if since:
            params["from"] = since + 1
        data = lfm_get("user.getRecentTracks", params)
        rt = data.get("recenttracks", {})
        if "error" in data and not rt:
            if page == 1:
                return jsonify({"error": data.get("message", "Usuario no encontrado")}), 404
            break
        tracks = rt.get("track", [])
        if isinstance(tracks, dict):
            tracks = [tracks]
        if not tracks:
            break
        attrs = rt.get("@attr", {})
        try:
            tp = max(1, int(attrs.get("totalPages", 1)))
        except (ValueError, TypeError):
            tp = 1
        if tp > total_pages:
            total_pages = tp
        for t in tracks:
            if isinstance(t.get("@attr"), dict) and t["@attr"].get("nowplaying"):
                continue
            artist     = t.get("artist", {})
            artist     = artist.get("#text", "") if isinstance(artist, dict) else str(artist)
            album      = t.get("album", {})
            album      = album.get("#text", "") if isinstance(album, dict) else str(album)
            track_name = t.get("name", "")
            if last_scrobble_ts == 0:
                d = t.get("date", {})
                try:
                    last_scrobble_ts = int(d.get("uts", 0)) if isinstance(d, dict) else 0
                except (ValueError, TypeError):
                    last_scrobble_ts = 0
                last_scrobble_artist = artist
                last_scrobble_track  = track_name
            if artist and album:
                key = (_norm(artist), _norm(album))
                if key not in new_counts:
                    new_counts[key] = [artist, album, 1]
                else:
                    new_counts[key][2] += 1
            if artist and track_name:
                skey = (_norm(artist), _norm(track_name))
                if skey not in new_songs:
                    new_songs[skey] = [artist, album, track_name, 1]
                else:
                    new_songs[skey][3] += 1
        page += 1
        time.sleep(0.5 + random.random() * 0.4)

    new_pairs     = [[k[0], k[1], v[0], v[1], v[2]] for k, v in new_counts.items()]
    new_song_list = [[k[0], k[1], v[0], v[1], v[2], v[3]] for k, v in new_songs.items()]
    return jsonify({
        "user":                 username,
        "new_pairs":            new_pairs,
        "new_songs":            new_song_list,
        "count":                len(new_pairs),
        "fetched_at":           int(time.time()),
        "last_scrobble_ts":     last_scrobble_ts,
        "last_scrobble_artist": last_scrobble_artist,
        "last_scrobble_track":  last_scrobble_track,
    })


@app.route("/api/scrobbles/update")
def api_scrobbles_update():
    """Sync incremental: compara total con LFM y descarga todo si cambió."""
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    if not LFM_API_KEY:
        return jsonify({"error": "Last.fm API key no configurada"}), 500

    known_count = request.args.get("known_count", "0")
    try:
        known_count = int(known_count)
    except ValueError:
        known_count = 0

    check = lfm_get("user.getTopAlbums", {"user": username, "period": "overall", "limit": 1, "page": 1})
    if "error" in check and "topalbums" not in check:
        return jsonify({"error": check.get("message", "Error Last.fm")}), 404
    lfm_total = int(check.get("topalbums", {}).get("@attr", {}).get("total", 0))

    if lfm_total <= known_count:
        return jsonify({
            "user":       username,
            "new_count":  0,
            "fetched_at": int(time.time()),
            "heard":      [],
            "lfm_total":  lfm_total,
        })

    new_set = set()
    page = 1
    total_pages = 1
    while page <= total_pages:
        data = lfm_get("user.getTopAlbums", {
            "user": username, "period": "overall", "limit": 200, "page": page,
        })
        if "error" in data and "topalbums" not in data:
            break
        albums = data.get("topalbums", {}).get("album", [])
        if not albums:
            break
        for a in albums:
            artist = a.get("artist", {})
            artist = artist.get("name", "") if isinstance(artist, dict) else str(artist)
            title  = a.get("name", "")
            if artist and title:
                new_set.add((_norm(artist), _norm(title)))
        attrs = data.get("topalbums", {}).get("@attr", {})
        total_pages = int(attrs.get("totalPages", 1))
        page += 1
        time.sleep(0.5 + random.random() * 0.4)

    for rpage in range(1, 4):
        data = lfm_get("user.getRecentTracks", {"user": username, "limit": 200, "page": rpage})
        tracks = data.get("recenttracks", {}).get("track", [])
        if not tracks:
            break
        for t in tracks:
            artist = t.get("artist", {})
            artist = artist.get("#text", "") if isinstance(artist, dict) else str(artist)
            album  = t.get("album", {})
            album  = album.get("#text", "") if isinstance(album, dict) else str(album)
            if artist and album:
                new_set.add((_norm(artist), _norm(album)))
        time.sleep(0.5 + random.random() * 0.4)

    return jsonify({
        "user":         username,
        "new_count":    len(new_set),
        "fetched_at":   int(time.time()),
        "lfm_total":    lfm_total,
        "heard":        [list(p) for p in new_set],
        "full_replace": True,
    })


@app.route("/api/check_user")
def api_check_user():
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"ok": False, "error": "Usuario vacío"}), 400
    data = lfm_get("user.getInfo", {"user": username})
    if "error" in data:
        return jsonify({"ok": False, "error": data.get("message", "Usuario no encontrado")})
    u = data.get("user", {})
    return jsonify({
        "ok":        True,
        "username":  u.get("name", username),
        "realname":  u.get("realname", ""),
        "playcount": u.get("playcount", 0),
        "image":     next((i["#text"] for i in u.get("image", []) if i.get("size") == "medium"), ""),
    })


@app.route("/api/friends")
def api_friends():
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"ok": False, "error": "Usuario vacío"}), 400
    data = lfm_get("user.getFriends", {"user": username, "recenttracks": 0, "limit": 50})
    if "error" in data:
        return jsonify({"ok": False, "error": data.get("message", "No se pudieron obtener amigos")})
    friends_raw = data.get("friends", {}).get("user", [])
    if isinstance(friends_raw, dict):
        friends_raw = [friends_raw]
    friends = []
    for f in friends_raw:
        friends.append({
            "username": f.get("name", ""),
            "image":    next((i["#text"] for i in f.get("image", []) if i.get("size") == "medium"), ""),
        })
    return jsonify({"ok": True, "friends": friends})


@app.route("/api/cover")
def api_cover():
    mbid = request.args.get("mbid", "").strip()
    if not mbid or not re.match(r'^[a-f0-9-]{36}$', mbid):
        abort(400)
    url = f"{CAA}/{mbid}/front-500"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "musthear/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data  = r.read()
            ctype = r.headers.get("Content-Type", "image/jpeg")
        resp = Response(data, content_type=ctype)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    except Exception:
        abort(404)


@app.route("/api/enrich_albums")
def api_enrich_albums():
    """SSE: busca portadas para lista de [[artist, album], ...]."""
    raw  = request.args.get("albums", "")
    lang = request.args.get("lang",   "es").strip()[:2]
    try:
        if not raw:
            albums = []
        else:
            try:
                albums = json.loads(base64.b64decode(raw.replace(' ', '+')).decode("utf-8"))
            except Exception:
                albums = json.loads(raw)
    except Exception:
        return jsonify({"error": "albums param inválido"}), 400
    if not isinstance(albums, list):
        return jsonify({"error": "albums debe ser un array"}), 400
    albums = [a for a in albums if isinstance(a, list) and len(a) >= 2][:100]

    LFM_DELAY = 0.5
    MB_DELAY  = 1.1

    def generate():
        for i, pair in enumerate(albums):
            artist, album = str(pair[0]), str(pair[1])
            mbid      = ""
            cover_url = ""
            mb_title  = album
            mb_artist = artist
            date      = ""
            used_mb   = False

            lfm    = lfm_get("album.getInfo", {"artist": artist, "album": album, "autocorrect": 1, "lang": lang})
            lfm_al = lfm.get("album", {})
            lfm_img  = _lfm_image(lfm_al.get("image", []))
            lfm_mbid = (lfm_al.get("mbid") or "").strip()

            if lfm_img:
                cover_url = lfm_img
            elif lfm_mbid:
                cover_url = f"https://coverartarchive.org/release/{lfm_mbid}/front-500"

            if not cover_url:
                mb        = mb_search_release_group(artist, album)
                mbid      = mb.get("mbid", "")
                mb_title  = mb.get("title", album)
                mb_artist = mb.get("artist", artist)
                date      = mb.get("date", "")
                if mbid:
                    resolved  = _resolve_caa(mbid)
                    cover_url = resolved or f"{CAA}/{mbid}/front-500"
                used_mb = True
            elif lfm_mbid and cover_url.startswith("https://coverartarchive.org/release/"):
                resolved = _resolve_caa_release(lfm_mbid)
                if resolved:
                    cover_url = resolved

            yield f"data: {json.dumps({'i': i, 'artist': artist, 'album': album, 'mbid': mbid, 'cover_url': cover_url, 'mb_title': mb_title, 'mb_artist': mb_artist, 'date': date})}\n\n"
            if i < len(albums) - 1:
                time.sleep(MB_DELAY if used_mb else LFM_DELAY)

        yield f"data: {json.dumps({'done': True, 'total': len(albums)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/album_info")
def api_album_info():
    artist = request.args.get("artist", "").replace('\n', ' ').replace('\r', '').strip()
    album  = request.args.get("album",  "").replace('\n', ' ').replace('\r', '').strip()
    mbid   = request.args.get("mbid",   "").strip()
    lang   = request.args.get("lang",   "es").strip()[:2]
    if not artist and not album:
        return jsonify({"error": "artist/album requeridos"}), 400

    result = {}

    al_data = lfm_get("album.getInfo", {"artist": artist, "album": album, "autocorrect": 1, "lang": lang})
    if "album" in al_data:
        al = al_data["album"] if isinstance(al_data.get("album"), dict) else {}
        _tags_raw = al.get("tags", {})
        _tags = (_tags_raw.get("tag", []) if isinstance(_tags_raw, dict) else [])
        if isinstance(_tags, dict):
            _tags = [_tags]
        _wiki_raw = al.get("wiki", {})
        _wiki = (_wiki_raw.get("summary", "") if isinstance(_wiki_raw, dict) else str(_wiki_raw or ""))
        result["lfm"] = {
            "listeners": al.get("listeners", ""),
            "playcount":  al.get("playcount",  ""),
            "tags":  [t["name"] for t in _tags[:6] if isinstance(t, dict)],
            "wiki":  (_wiki or "").split("<a ")[0].strip(),
            "image": _lfm_image(al.get("image", [])),
        }
        if not mbid and al.get("mbid"):
            mbid = al["mbid"]

    ar_data = lfm_get("artist.getInfo", {"artist": artist, "autocorrect": 1, "lang": lang})
    if "artist" in ar_data:
        ar = ar_data["artist"] if isinstance(ar_data.get("artist"), dict) else {}
        _bio_raw   = ar.get("bio", {})
        _bio       = (_bio_raw.get("summary", "") if isinstance(_bio_raw, dict) else str(_bio_raw or ""))
        _stats_raw = ar.get("stats", {})
        _listeners = (_stats_raw.get("listeners", "") if isinstance(_stats_raw, dict) else "")
        _images    = ar.get("image", [])
        result["artist"] = {
            "bio":       (_bio or "").split("<a ")[0].strip(),
            "listeners": _listeners,
            "image":     next((i["#text"] for i in _images if isinstance(i, dict) and i.get("size") == "extralarge"), ""),
        }

    if not mbid:
        mb = mb_search_release_group(artist, album)
        if mb.get("mbid"):
            mbid = mb["mbid"]
            result.update({
                "mbid":      mbid,
                "cover_url": f"{CAA}/{mbid}/front-500",
                "mb_title":  mb.get("title", album),
                "mb_artist": mb.get("artist", artist),
                "date":      mb.get("date", ""),
            })
    else:
        result["mbid"]      = mbid
        result["cover_url"] = f"{CAA}/{mbid}/front-500"

    resp = jsonify(result)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/img/<path:filename>")
def serve_img(filename):
    return send_from_directory(Path(__file__).parent / "img", filename)

@app.route("/favicon.ico")
def favicon():
    return send_from_directory(Path(__file__).parent / "img", "boar.png", mimetype="image/png")

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)


# ── HTML Template ──────────────────────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>musthear</title>
<link rel="icon" type="image/png" href="/img/boar.png" />
<!-- Umami Analytics -->
<script defer src="https://cloud.umami.is/script.js" data-website-id="262419b6-9389-4f91-898c-3943726c6dc8"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/css/genres.css">
</head>
<body>

<!-- ── Header ─────────────────────────────────────────────────────────── -->
<header style="height:52px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 1.2rem;gap:1rem;flex-shrink:0;position:sticky;top:0;z-index:100;">
  <a class="logo" href="/" style="font-size:1.3rem;text-decoration:none;color:inherit">col<em>lections</em></a>
  <div style="flex:1"></div>
  <div id="badge-inline" style="display:none;align-items:center;gap:0.45rem;cursor:pointer;">
    <img id="badge-avatar" src="" alt="" style="width:26px;height:26px;border-radius:50%;object-fit:cover;background:var(--bg3);">
    <span id="badge-name" style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);"></span>
    <span id="badge-plays" style="font-family:var(--mono);font-size:0.65rem;color:var(--ink3);"></span>
  </div>
  <button id="btn-usuario" data-i18n="btn.user">USUARIO</button>
</header>

<input type="file" id="inp-session"       accept=".json" style="display:none">
<input type="file" id="inp-extra-json"    accept=".json" style="display:none">

<!-- ── User modal ──────────────────────────────────────────────────────── -->
<div id="user-modal-bg">
  <div id="user-modal">
    <button class="modal-close">✕</button>

    <!-- Usuario principal -->
    <div class="um-section">
      <div class="um-section-title" data-i18n="um.primary.title">Usuario principal</div>
      <div id="um-current-user">
        <img id="um-avatar" src="" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--bg3);flex-shrink:0">
        <div style="flex:1;min-width:0">
          <div class="um-user-name" id="um-username"></div>
          <div class="um-user-meta" id="um-usermeta"></div>
        </div>
        <button class="btn-sm" id="btn-sync-session">↻ Sync</button>
      </div>
      <div class="um-row">
        <input id="inp-user" type="text" placeholder="Usuario Last.fm" data-i18n-ph="um.primary.placeholder" autocomplete="off" spellcheck="false">
        <button class="btn" id="btn-go" style="padding:0.4rem 1rem;font-size:0.72rem;">Last.fm</button>
      </div>
      <div class="um-progress" id="um-progress"></div>
      <div class="um-actions">
        <button class="btn-sm" id="btn-import" data-i18n="um.import">↑ Importar JSON</button>
        <button class="btn-sm" id="btn-save-session" style="display:none" data-i18n="um.save">↓ Guardar JSON</button>
      </div>
      <div class="um-sep" data-i18n="um.sep.saved">Sesiones guardadas en este navegador</div>
      <div id="idb-list"><span class="idb-empty">Sin sesiones guardadas</span></div>
    </div>

    <!-- Usuarios adicionales (colapsable) -->
    <div class="um-section collapsed" id="um-sec-extra">
      <div class="um-section-title" style="display:flex;align-items:center;cursor:pointer">
        <span data-i18n="um.secondary.title">Usuarios secundarios</span>
        <button class="um-section-toggle" tabindex="-1">▾</button>
      </div>
      <div class="um-section-body">
        <div id="extra-users-list"></div>
        <div class="um-row" style="margin-top:0.5rem">
          <input id="inp-extra-user" type="text" placeholder="usuario last.fm" data-i18n-ph="um.secondary.placeholder" autocomplete="off" spellcheck="false">
          <button class="btn-sm" id="btn-extra-lfm">Last.fm</button>
          <button class="btn-sm" id="btn-extra-json">↑ JSON</button>
        </div>
        <div class="um-progress" id="um-extra-progress"></div>
        <div class="um-sep" style="display:flex;align-items:center;justify-content:space-between">
          <span data-i18n="um.friends.title">Amigos del usuario principal</span>
          <button class="btn-sm" id="btn-load-friends" style="font-size:0.65rem" data-i18n="um.friends.load">Cargar</button>
        </div>
        <div id="friends-list"></div>
        <div id="idb-extra-sep" class="um-sep" style="display:none" data-i18n="idb.extra.sep">Desde sesiones guardadas en este navegador</div>
        <div id="idb-extra-list"></div>
      </div>
    </div>

    <!-- Language selector -->
    <div class="um-lang-row">
      <span data-i18n="lang.label" style="font-size:0.7rem;color:var(--ink3);font-family:var(--mono)">Idioma</span>
      <label style="font-size:0.72rem;cursor:pointer;display:flex;align-items:center;gap:0.25rem">
        <input type="radio" name="ui-lang" value="es"> Español
      </label>
      <label style="font-size:0.72rem;cursor:pointer;display:flex;align-items:center;gap:0.25rem">
        <input type="radio" name="ui-lang" value="en"> English
      </label>
    </div>
  </div>
</div>

<!-- About modal -->
<div id="about-overlay">
  <div id="about-modal">
    <button class="about-close">✕</button>
    <h2>musthear</h2>
    <p>Cruza tu historial de <b>Last.fm</b> con listas de álbumes imprescindibles agrupadas por fuente (Scaruffi, AOTY, Pitchfork, etc.).</p>

    <h3>Primeros pasos</h3>
    <ul>
      <li>Introduce tu usuario de Last.fm y pulsa <b>Last.fm</b> para descargar tus scrobbles.</li>
      <li>Puedes importar un JSON exportado desde <em>tumtumpa</em> o <em>mustlisten</em>.</li>
      <li>Selecciona una <b>colección</b> en el panel izquierdo para ver qué álbumes has escuchado y cuáles te faltan.</li>
    </ul>

    <h3>Filtros y ordenación</h3>
    <ul>
      <li>Filtra por <b>género</b> (si el álbum aparece en algún chart) o por <b>década</b>.</li>
      <li>Ordena por posición, año o artista.</li>
    </ul>

    <h3>Sesiones</h3>
    <ul>
      <li>Los scrobbles se guardan en <b>IndexedDB</b>: la próxima vez no hace falta re-descargar.</li>
      <li>Los JSON son compatibles con tumtumpa y mustlisten.</li>
    </ul>

    <h3>Servicios</h3>
    <div class="about-services">
      <a class="about-svc lfm" href="https://www.last.fm" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M10.596 1.9C6.07 2.38 2.38 6.07 1.9 10.596 1.25 16.7 5.918 22 12 22c5.12 0 9.417-3.56 10.578-8.32.07-.29-.08-.58-.36-.67l-2.1-.68c-.27-.09-.56.05-.65.32-.65 1.98-2.47 3.35-4.62 3.35-2.65 0-4.8-2.15-4.8-4.8 0-2.65 2.15-4.8 4.8-4.8 1.8 0 3.36.97 4.2 2.42l-1.7.54c-.28.09-.42.4-.3.67l2.4 5.82c.12.28.43.42.71.3l5.82-2.4c.28-.12.42-.43.3-.71l-.68-1.64c-.12-.28-.43-.42-.71-.3l-1.32.54C14.26 4.12 12.28 1.9 10.596 1.9z"/>
        </svg>
        Last.fm
      </a>
      <a class="about-svc mb" href="https://musicbrainz.org" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
        </svg>
        MusicBrainz
      </a>
      <a class="about-svc gh" href="https://github.com/HuanPc/escuchowsky" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        GitHub
      </a>
    </div>
  </div>
</div>

<!-- Mobile sidebar overlay + FAB -->
<div id="sidebar-overlay"></div>
<button id="sidebar-fab">☰</button>

<!-- ── App shell ───────────────────────────────────────────────────────── -->
<div class="app-shell">

  <!-- ── Sidebar ─────────────────────────────────────────────────────── -->
  <aside id="sidebar">
    <div class="sb-scroll">

      <!-- Colecciones (agrupadas por fuente) -->
      <div class="sb-panel open" id="panel-colls">
        <div class="sb-panel-hdr">
          <span class="sb-panel-title" data-i18n="sb.collections">Colecciones</span>
          <span class="sb-panel-arrow">▶</span>
        </div>
        <div class="sb-panel-body" id="colls-body">
          <div class="sb-empty">Cargando…</div>
        </div>
      </div>

      <!-- Géneros (tags de la colección activa) -->
      <div class="sb-panel" id="panel-genres">
        <div class="sb-panel-hdr">
          <span class="sb-panel-title" data-i18n="sb.genres">Géneros</span>
          <span class="sb-panel-arrow">▶</span>
        </div>
        <div class="sb-panel-body">
          <div class="sb-pills" id="genre-pills">
            <div class="sb-empty">Selecciona una colección</div>
          </div>
        </div>
      </div>

      <!-- Fechas -->
      <div class="sb-panel open" id="panel-dates">
        <div class="sb-panel-hdr">
          <span class="sb-panel-title" data-i18n="sb.dates">Fechas</span>
          <span class="sb-panel-arrow">▶</span>
        </div>
        <div class="sb-panel-body">
          <div class="sb-pills" id="decade-pills">
            <div class="sb-empty">Selecciona una colección</div>
          </div>
        </div>
      </div>

      <button class="sb-about-btn" data-i18n="sb.about">about</button>

    </div><!-- .sb-scroll -->
  </aside>

  <!-- ── Main ──────────────────────────────────────────────────────────── -->
  <div id="main">
    <div class="main-inner">

      <div id="error-msg"></div>

      <div id="loading">
        <div class="spinner"></div>
        <span id="loading-text">Cargando scrobbles...</span>
      </div>

      <!-- Stats -->
      <div id="stats-bar">
        <div class="stat">
          <div class="stat-val" id="s-total">—</div>
          <div class="stat-lbl">Total</div>
        </div>
        <div class="stat-sep"></div>
        <div class="stat">
          <div class="stat-val accent" id="s-heard">—</div>
          <div class="stat-lbl" data-i18n="stats.heard">Escuchados</div>
        </div>
        <div class="stat-sep"></div>
        <div class="stat">
          <div class="stat-val" id="s-missing">—</div>
          <div class="stat-lbl" data-i18n="stats.pending">Pendientes</div>
        </div>
        <div class="stat-sep"></div>
        <div class="stat">
          <div class="stat-val" id="s-pct">—</div>
          <div class="stat-lbl" data-i18n="stats.complete">Completado</div>
        </div>
        <div class="stat-sep"></div>
        <div class="prog-wrap">
          <div class="stat-lbl">Progreso</div>
          <div class="prog-track"><div class="prog-fill" id="prog-fill"></div></div>
        </div>
      </div>

      <!-- Filters -->
      <div id="filters">
        <button class="filter-btn active" data-filter="all" data-i18n="filter.all">Todos</button>
        <button class="filter-btn" data-filter="missing" data-i18n="filter.pending">Pendientes</button>
        <button class="filter-btn" data-filter="heard" data-i18n="filter.heard">Escuchados</button>
        <div id="filter-extra-users"></div>
        <div class="filter-sep"></div>
        <label for="sort-select" style="margin:0">
          <select id="sort-select">
            <option value="rank" data-i18n="sort.rank">Orden lista</option>
            <option value="year_asc" data-i18n="sort.year.asc">Año ↑</option>
            <option value="year_desc" data-i18n="sort.year.desc">Año ↓</option>
            <option value="artist" data-i18n="sort.artist">Artista A–Z</option>
          </select>
        </label>
      </div>

      <div id="grid"></div>
      <div id="empty"><p data-i18n="empty">No hay álbumes para mostrar</p></div>

    </div><!-- .main-inner -->
  </div><!-- #main -->

</div><!-- .app-shell -->

<!-- Detail side panel -->
<div id="detail-overlay"></div>
<div id="detail-panel">
  <button class="dp-close">✕</button>
  <div class="dp-header">
    <img class="dp-cover" id="dp-cover" src="" alt="">
    <div class="dp-meta">
      <div class="dp-title"  id="dp-title"></div>
      <div class="dp-artist" id="dp-artist"></div>
      <div class="dp-year"   id="dp-year"></div>
      <div class="dp-status" id="dp-status"></div>
      <div id="dp-extra-status" style="display:none;flex-wrap:wrap;gap:5px;margin-top:5px"></div>
    </div>
  </div>
  <div class="dp-body">
    <div class="dp-loading" id="dp-loading" style="display:none" data-i18n="dp.loading">Consultando Last.fm…</div>
    <div class="dp-stats"   id="dp-stats"   style="display:none"></div>
    <div class="dp-tags"    id="dp-tags"></div>
    <div class="dp-yt"      id="dp-yt"      style="display:none"></div>
    <div class="dp-section" id="dp-album-wiki" style="display:none">
      <div class="dp-section-title" data-i18n="dp.album">Álbum</div>
      <div class="dp-text" id="dp-wiki-text"></div>
    </div>
    <div class="dp-section" id="dp-artist-bio" style="display:none">
      <div class="dp-section-title" id="dp-artist-bio-title"></div>
      <div class="dp-text" id="dp-bio-text"></div>
    </div>
    <div class="dp-links" id="dp-links"></div>
  </div>
</div>

<script src="/static/js/musthear.js"></script>
</body>
</html>"""

# ── CLI / entrypoint ──────────────────────────────────────────────────────────

def resolve_lastfm_key(cli_key: str | None) -> str:
    if cli_key:
        return cli_key
    k = os.environ.get("LASTFM_API_KEY", "")
    if k:
        return k
    enc = Path(".encrypted.env")
    if enc.exists():
        try:
            return subprocess.check_output(
                ["sops", "-d", "--extract", '["LASTFM_API_KEY"]', str(enc)],
                stderr=subprocess.DEVNULL,
            ).decode().strip()
        except Exception:
            pass
    return ""


def main():
    global DB_PATH, LFM_API_KEY

    parser = argparse.ArgumentParser(description="musthear — colecciones por fuente")
    parser.add_argument("--db",             required=True, help="Ruta a must_hear.db")
    parser.add_argument("--lastfm-api-key", default=None,  help="Last.fm API key")
    parser.add_argument("--port",           type=int, default=5002)
    parser.add_argument("--host",           default="127.0.0.1")
    parser.add_argument("--debug",          action="store_true")
    args = parser.parse_args()

    DB_PATH     = args.db
    LFM_API_KEY = resolve_lastfm_key(args.lastfm_api_key)

    if not Path(DB_PATH).exists():
        print(f"❌ DB no encontrada: {DB_PATH}")
        raise SystemExit(1)
    if not LFM_API_KEY:
        print("⚠  Sin Last.fm API key — las búsquedas fallarán.")

    print(f"🎵 musthear → http://{args.host}:{args.port}")
    print(f"🗄  DB: {DB_PATH}")
    print(f"🔑 Last.fm API key: {'✓' if LFM_API_KEY else '✗ no encontrada'}")

    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
