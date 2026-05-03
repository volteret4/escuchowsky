#!/usr/bin/env python3
"""
mustdiscover — Flask backend
Comparación de scrobbles entre usuario principal y usuarios secundarios.
Descubre qué escucha un usuario secundario que tú no has escuchado.

Uso:
    python app_discover.py --lastfm-api-key KEY [--port 5001]
    LASTFM_API_KEY=xxx python app_discover.py
"""
import os
import re
import json
import time
import random
import argparse
import urllib.request
import urllib.parse
import urllib.error
from flask import Flask, jsonify, request, render_template_string, abort, Response, stream_with_context, send_from_directory

app = Flask(__name__, static_folder='static', static_url_path='/static')

# ── Config ────────────────────────────────────────────────────────────────────
LFM_API_KEY  = os.environ.get("LASTFM_API_KEY") or None
YT_API_KEY   = os.environ.get("YOUTUBE_API_KEY") or None
CAA          = "https://coverartarchive.org/release-group"

_LFM_NO_IMG  = "2a96cbd8b46e442fc41c2b86b821562f"  # Last.fm placeholder hash


# ── Helpers ───────────────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return re.sub(r"[^\w]", "", (s or "").lower())

def _lfm_image(images: list, size: str = "extralarge") -> str:
    """Return the best Last.fm image URL, skipping the placeholder star."""
    for img in images:
        url = img.get("#text", "")
        if img.get("size") == size and url and _LFM_NO_IMG not in url:
            return url
    return ""


# ── Last.fm API ────────────────────────────────────────────────────────────────

def lfm_get(method: str, params: dict) -> dict:
    base = "https://ws.audioscrobbler.com/2.0/"
    params = {**params, "method": method, "api_key": LFM_API_KEY, "format": "json"}
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "tumtumpa/1.0 (viciosmusicales@gmail.com)"})
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


def mb_search_release_group(artist: str, album: str) -> dict:
    """Search MusicBrainz for a release group. Returns {mbid, title, artist, date}."""
    q = 'artist:"{}" AND release:"{}"'.format(
        artist.replace('"', ''), album.replace('"', '')
    )
    url = ("https://musicbrainz.org/ws/2/release-group?"
           + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": "1"}))
    req = urllib.request.Request(url, headers={
        "User-Agent": "tumtumpa/1.0 (https://github.com/volteret4/escuchowsky)",
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


# ── Static assets ─────────────────────────────────────────────────────────────

@app.route("/img/<path:filename>")
def serve_img(filename):
    return send_from_directory("img", filename)


# ── API endpoints ──────────────────────────────────────────────────────────────


@app.route("/api/config")
def api_config():
    """Exposes public client configuration (LFM key for direct browser calls)."""
    return jsonify({"lfm_key": LFM_API_KEY or ""})


@app.route("/api/scrobbles")
def api_scrobbles():
    """
    Descarga el historial completo via user.getTopAlbums + user.getTopTracks (SSE).
    Mucho más eficiente que getRecentTracks: ~50-200 req en vez de 2000+ para usuarios
    con 400k+ scrobbles. Mismo formato de salida para compatibilidad con el cliente.
    """
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    if not LFM_API_KEY:
        return jsonify({"error": "Last.fm API key no configurada"}), 500

    def _lfm_paged(method, result_key, username, extra_params=None):
        """
        Generador que pagina un método LFM y yielda (items_list, page, total_pages).
        result_key: clave en la respuesta que contiene el dict con 'track'/'album'/@attr.
        Incluye retry con backoff para error 29 (quota).
        """
        page_delay = 0.5
        page = 1
        total_pages = None
        params = {"user": username, "limit": 200, "page": page, **(extra_params or {})}
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
                print(f"[lfm] {method} p{page} intento {attempt+1} (código {err_code}): {last_error}", flush=True)
                if attempt < 5:
                    wait = 60 * (attempt + 1) if err_code == 29 else 10 * (3 ** min(attempt, 3))
                    if err_code == 29:
                        page_delay = 2.0
                    yield None, page, total_pages, wait  # señal de espera al caller
                    time.sleep(wait)
            if last_error:
                yield None, page, total_pages, -1  # señal de error fatal al caller
                return
            attrs = container.get("@attr", {})
            try:
                tp = max(1, int(attrs.get("totalPages", 1)))
            except (ValueError, TypeError):
                tp = 1
            if total_pages is None or tp > total_pages:
                total_pages = tp
            items_key = list(k for k in container if k != "@attr")
            items = container.get(items_key[0], []) if items_key else []
            if isinstance(items, dict):
                items = [items]
            yield items, page, total_pages, 0
            if page >= total_pages:
                return
            page += 1
            time.sleep(page_delay + random.random() * 0.4)

    def generate():
        heard_counts = {}   # (norm_a, norm_album) -> [orig_a, orig_album, count]
        heard_songs  = {}   # (norm_a, norm_track) -> [orig_a, orig_album, orig_track, count]
        heard_artists = set()
        last_scrobble_ts = 0
        last_scrobble_artist = ""
        last_scrobble_track = ""
        total_album_pages = 0

        # ── Fase 1: álbumes (getTopAlbums) ──────────────────────────────────
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
                    heard_counts[key] = [artist, album, max(count, heard_counts.get(key, [0,0,0])[2])]
            total_album_pages = total_pages or 0
            yield f"data: {json.dumps({'page': page, 'total_pages': total_album_pages, 'count': len(heard_counts)})}\n\n"

        # ── Fase 2: canciones (getTopTracks, todas las páginas) ─────────────
        for items, page, total_pages, signal in _lfm_paged(
            "user.getTopTracks", "toptracks", username, {"period": "overall"}
        ):
            if signal == -1:
                break  # canciones son opcionales, no fallar
            if signal > 0:
                yield f"data: {json.dumps({'waiting': signal, 'page': page, 'total_pages': total_pages, 'count': len(heard_counts)})}\n\n"
                continue
            if items is None:
                continue
            for t in items:
                artist_obj = t.get("artist", {})
                artist = artist_obj.get("name", "") if isinstance(artist_obj, dict) else str(artist_obj)
                track_name = t.get("name", "")
                album_obj = t.get("album", {})
                album = album_obj.get("#text", "") if isinstance(album_obj, dict) else ""
                try:
                    count = int(t.get("playcount", 1) or 1)
                except (ValueError, TypeError):
                    count = 1
                if artist and track_name:
                    skey = (_norm(artist), _norm(track_name))
                    heard_songs[skey] = [artist, album, track_name, max(count, heard_songs.get(skey, [0,0,0,0])[3])]
            # progreso fase 2 — sumar páginas de álbumes para no resetear el contador
            yield f"data: {json.dumps({'page': total_album_pages + page, 'total_pages': total_album_pages + (total_pages or 1), 'count': len(heard_counts)})}\n\n"

        # ── Fase 3: 1 página de recentTracks para last_scrobble info ─────────
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
                last_scrobble_track = t.get("name", "")
                break

        heard_pairs    = [[k[0], k[1], v[0], v[1], v[2]] for k, v in heard_counts.items()]
        heard_song_list = [[k[0], k[1], v[0], v[1], v[2], v[3]] for k, v in heard_songs.items()]
        yield f"data: {json.dumps({'done': True, 'user': username, 'count': len(heard_pairs), 'fetched_at': int(time.time()), 'heard': heard_pairs, 'heard_songs': heard_song_list, 'heard_artists': list(heard_artists), 'last_scrobble_ts': last_scrobble_ts, 'last_scrobble_artist': last_scrobble_artist, 'last_scrobble_track': last_scrobble_track, 'total_pages': total_album_pages})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/scrobbles/since")
def api_scrobbles_since():
    """
    Obtiene sólo pistas nuevas desde `since` (Unix timestamp) via getRecentTracks?from=.
    Ideal para sincronización incremental de usuarios secundarios.
    """
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

    # (norm_a, norm_album) -> [orig_a, orig_album, count]
    new_counts          = {}
    # (norm_a, norm_track) -> [orig_a, orig_album, orig_track, count]
    new_songs           = {}
    page                = 1
    total_pages         = 1
    last_scrobble_ts    = 0
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
            artist = t.get("artist", {})
            artist = artist.get("#text", "") if isinstance(artist, dict) else str(artist)
            album  = t.get("album", {})
            album  = album.get("#text", "") if isinstance(album, dict) else str(album)
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

    new_pairs    = [[k[0], k[1], v[0], v[1], v[2]] for k, v in new_counts.items()]
    new_song_list = [[k[0], k[1], v[0], v[1], v[2], v[3]] for k, v in new_songs.items()]
    return jsonify({
        "user":                username,
        "new_pairs":           new_pairs,
        "new_songs":           new_song_list,
        "count":               len(new_pairs),
        "fetched_at":          int(time.time()),
        "last_scrobble_ts":    last_scrobble_ts,
        "last_scrobble_artist": last_scrobble_artist,
        "last_scrobble_track": last_scrobble_track,
    })


def _lb_fetch_page(username: str, max_ts: int | None = None, min_ts: int = 0) -> dict:
    """Fetch one page of ListenBrainz listens (up to 100). Returns raw payload dict."""
    url = ("https://api.listenbrainz.org/1/user/"
           + urllib.parse.quote(username, safe="") + "/listens?count=100")
    if max_ts is not None:
        url += f"&max_ts={max_ts}"
    if min_ts:
        url += f"&min_ts={min_ts}"
    req = urllib.request.Request(url, headers={"User-Agent": "tumtumpa/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()).get("payload", {})


@app.route("/api/scrobbles/lb")
def api_scrobbles_lb():
    """
    Descarga el historial completo de ListenBrainz en formato SSE idéntico a /api/scrobbles.
    Pagina hacia atrás usando max_ts hasta agotar los scrobbles.
    """
    username = request.args.get("user", "").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400

    def generate():
        heard_counts         = {}
        heard_songs          = {}
        heard_artists        = set()
        last_scrobble_ts     = 0
        last_scrobble_artist = ""
        last_scrobble_track  = ""
        max_ts               = None
        page                 = 0
        total_pages          = None

        # Estimate total pages from listen-count
        try:
            cnt_url = ("https://api.listenbrainz.org/1/user/"
                       + urllib.parse.quote(username, safe="") + "/listen-count")
            req = urllib.request.Request(cnt_url, headers={"User-Agent": "tumtumpa/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                total_listens = json.loads(r.read()).get("payload", {}).get("count", 0)
            total_pages = max(1, (total_listens + 99) // 100)
        except Exception:
            total_pages = None

        while True:
            try:
                payload = _lb_fetch_page(username, max_ts=max_ts)
            except Exception as e:
                if page == 0:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
                    return
                break

            listens = payload.get("listens", [])
            if not listens:
                break

            page += 1
            for listen in listens:
                tm     = listen.get("track_metadata", {})
                artist = tm.get("artist_name", "")
                album  = tm.get("release_name", "") or ""
                track  = tm.get("track_name", "")
                ts     = listen.get("listened_at", 0)
                if last_scrobble_ts == 0 and ts:
                    last_scrobble_ts     = ts
                    last_scrobble_artist = artist
                    last_scrobble_track  = track
                if artist:
                    heard_artists.add(_norm(artist))
                if artist and album:
                    key = (_norm(artist), _norm(album))
                    if key not in heard_counts:
                        heard_counts[key] = [artist, album, 1]
                    else:
                        heard_counts[key][2] += 1
                if artist and track:
                    skey = (_norm(artist), _norm(track))
                    if skey not in heard_songs:
                        heard_songs[skey] = [artist, album, track, 1]
                    else:
                        heard_songs[skey][3] += 1

            # Compute next max_ts from valid timestamps in this page
            ts_vals = [l["listened_at"] for l in listens if l.get("listened_at", 0) > 0]
            if not ts_vals:
                # No valid timestamps → can't paginate further; emit done
                break
            max_ts = min(ts_vals) - 1

            tp = total_pages or page
            yield f"data: {json.dumps({'page': page, 'total_pages': tp, 'count': len(heard_counts)})}\n\n"

            time.sleep(0.25)

        heard_pairs     = [[k[0], k[1], v[0], v[1], v[2]] for k, v in heard_counts.items()]
        heard_song_list = [[k[0], k[1], v[0], v[1], v[2], v[3]] for k, v in heard_songs.items()]
        yield f"data: {json.dumps({'done': True, 'user': username, 'count': len(heard_pairs), 'fetched_at': int(time.time()), 'heard': heard_pairs, 'heard_songs': heard_song_list, 'heard_artists': list(heard_artists), 'last_scrobble_ts': last_scrobble_ts, 'last_scrobble_artist': last_scrobble_artist, 'last_scrobble_track': last_scrobble_track, 'total_pages': total_pages or page})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/scrobbles/lb/since")
def api_scrobbles_lb_since():
    """Sync incremental de ListenBrainz: sólo scrobbles después de `since` (Unix ts)."""
    username = request.args.get("user", "").strip()
    since    = request.args.get("since", "0").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    try:
        since = int(since)
    except ValueError:
        since = 0

    new_counts           = {}
    new_songs            = {}
    last_scrobble_ts     = 0
    last_scrobble_artist = ""
    last_scrobble_track  = ""
    max_ts               = None

    while True:
        try:
            payload = _lb_fetch_page(username, max_ts=max_ts, min_ts=since)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

        listens = payload.get("listens", [])
        if not listens:
            break

        for listen in listens:
            tm     = listen.get("track_metadata", {})
            artist = tm.get("artist_name", "")
            album  = tm.get("release_name", "") or ""
            track  = tm.get("track_name", "")
            ts     = listen.get("listened_at", 0)
            if last_scrobble_ts == 0 and ts:
                last_scrobble_ts     = ts
                last_scrobble_artist = artist
                last_scrobble_track  = track
            if artist and album:
                key = (_norm(artist), _norm(album))
                if key not in new_counts:
                    new_counts[key] = [artist, album, 1]
                else:
                    new_counts[key][2] += 1
            if artist and track:
                skey = (_norm(artist), _norm(track))
                if skey not in new_songs:
                    new_songs[skey] = [artist, album, track, 1]
                else:
                    new_songs[skey][3] += 1

        ts_vals = [l["listened_at"] for l in listens if l.get("listened_at", 0) > since]
        if not ts_vals:
            break
        max_ts = min(ts_vals) - 1
        if max_ts <= since:
            break
        time.sleep(0.25)

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
    """
    Sync incremental: descarga el top completo de nuevo y devuelve solo
    los pares que no estaban en el set existente (enviado por el cliente).
    Usar getRecentTracks con `from` es inviable para usuarios con 300k+ scrobbles
    porque puede suponer miles de páginas. getTopAlbums es la única fuente fiable
    y completa; la diferencia entre dos descargas son los álbumes nuevos.
    """
    username   = request.args.get("user", "").strip()
    if not username:
        return jsonify({"error": "Parámetro 'user' requerido"}), 400
    if not LFM_API_KEY:
        return jsonify({"error": "Last.fm API key no configurada"}), 500

    # El cliente envía los pares que ya tiene como JSON en el body (POST)
    # o como query param `known_count` para saber si algo cambió antes de descargar
    known_count = request.args.get("known_count", "0")
    try:
        known_count = int(known_count)
    except ValueError:
        known_count = 0

    # Primero comprobar si el total de álbumes en LFM cambió
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

    # Descargar todo de nuevo para obtener el diff
    new_set = set()
    page = 1
    per_page = 200
    total_pages = 1
    while page <= total_pages:
        data = lfm_get("user.getTopAlbums", {
            "user": username, "period": "overall",
            "limit": per_page, "page": page,
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

    # Recientes también
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
        "user":       username,
        "new_count":  len(new_set),
        "fetched_at": int(time.time()),
        "lfm_total":  lfm_total,
        # Devolvemos el set completo; el cliente reemplaza su caché
        "heard":      [list(p) for p in new_set],
        "full_replace": True,
    })


@app.route("/api/check_user")
def api_check_user():
    """Verifica que el usuario existe (Last.fm o ListenBrainz según ?source=)."""
    username = request.args.get("user", "").strip()
    source   = request.args.get("source", "lfm").strip()
    if not username:
        return jsonify({"ok": False, "error": "Usuario vacío"}), 400

    if source == "lb":
        url = ("https://api.listenbrainz.org/1/user/"
               + urllib.parse.quote(username, safe="") + "/listens?count=1")
        req = urllib.request.Request(url, headers={"User-Agent": "tumtumpa/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            lb_user = data.get("payload", {}).get("user_id", username)
            return jsonify({"ok": True, "username": lb_user, "realname": "", "playcount": 0, "image": ""})
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return jsonify({"ok": False, "error": "Usuario no encontrado en ListenBrainz"})
            return jsonify({"ok": False, "error": f"HTTP {e.code}"})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})

    data = lfm_get("user.getInfo", {"user": username})
    if "error" in data:
        return jsonify({"ok": False, "error": data.get("message", "Usuario no encontrado")})
    u = data.get("user", {})
    return jsonify({
        "ok":         True,
        "username":   u.get("name", username),
        "realname":   u.get("realname", ""),
        "playcount":  u.get("playcount", 0),
        "image":      next((i["#text"] for i in u.get("image", []) if i.get("size") == "medium"), ""),
    })


@app.route("/api/friends")
def api_friends():
    """Devuelve la lista de amigos de un usuario de Last.fm."""
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
    """
    Proxy legacy para portadas de CoverArtArchive.
    La app ya usa URLs directas de CAA en <img>; este endpoint se mantiene
    por compatibilidad con sesiones guardadas que aún tengan /api/cover URLs.
    """
    mbid = request.args.get("mbid", "").strip()
    if not mbid or not re.match(r'^[a-f0-9-]{36}$', mbid):
        abort(400)
    url = f"{CAA}/{mbid}/front-500"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "tumtumpa/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data     = r.read()
            ctype    = r.headers.get("Content-Type", "image/jpeg")
        from flask import Response
        resp = Response(data, content_type=ctype)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    except Exception:
        abort(404)


@app.route("/api/enrich_albums")
def api_enrich_albums():
    """
    SSE: busca metadatos para una lista de [[artist, album], ...].
    Estrategia: Last.fm album.getInfo primero (5 req/s) → si devuelve imagen o
    mbid, se usa directamente y se salta MusicBrainz. Solo se consulta MB (1 req/s)
    para álbumes que Last.fm no conoce.
    Devuelve un evento por álbum con {i, artist, album, mbid, cover_url, mb_title, mb_artist, date}.
    """
    raw = request.args.get("albums", "[]")
    try:
        albums = json.loads(raw)
    except Exception:
        return jsonify({"error": "albums param inválido"}), 400
    if not isinstance(albums, list):
        return jsonify({"error": "albums debe ser un array"}), 400
    albums = [a for a in albums if isinstance(a, list) and len(a) >= 2][:100]

    LFM_DELAY = 0.5    # ~2 req/s con jitter; combinado con scrobbles no supera 3 req/s
    MB_DELAY  = 1.1    # MusicBrainz: 1 req/s

    def generate():
        for i, pair in enumerate(albums):
            artist, album = str(pair[0]), str(pair[1])
            mbid      = ""
            cover_url = ""
            mb_title  = album
            mb_artist = artist
            date      = ""
            used_mb   = False

            # ── 1. Last.fm album.getInfo ──────────────────────────────────────
            lfm    = lfm_get("album.getInfo", {"artist": artist, "album": album, "autocorrect": 1})
            lfm_al = lfm.get("album", {})
            lfm_img = next(
                (img["#text"] for img in lfm_al.get("image", [])
                 if img.get("size") == "extralarge" and img.get("#text")),
                ""
            )
            lfm_mbid = (lfm_al.get("mbid") or "").strip()

            if lfm_img:
                cover_url = lfm_img
            elif lfm_mbid:
                # mbid de Last.fm es de release (no release-group), usar endpoint /release/
                cover_url = f"https://coverartarchive.org/release/{lfm_mbid}/front-500"

            # ── 2. MusicBrainz solo si Last.fm no dio portada ─────────────────
            if not cover_url:
                mb        = mb_search_release_group(artist, album)
                mbid      = mb.get("mbid", "")
                mb_title  = mb.get("title", album)
                mb_artist = mb.get("artist", artist)
                date      = mb.get("date", "")
                cover_url = f"{CAA}/{mbid}/front-500" if mbid else ""
                used_mb   = True

            result = {
                "i":         i,
                "artist":    artist,
                "album":     album,
                "mbid":      mbid,
                "cover_url": cover_url,
                "mb_title":  mb_title,
                "mb_artist": mb_artist,
                "date":      date,
            }
            yield f"data: {json.dumps(result)}\n\n"
            if i < len(albums) - 1:
                time.sleep((MB_DELAY if used_mb else LFM_DELAY) + random.random() * 0.3)

        yield f"data: {json.dumps({'done': True, 'total': len(albums)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/album_info")
def api_album_info():
    """
    Obtiene info de un álbum desde Last.fm (album.getInfo + artist.getInfo).
    Si no se provee mbid, busca en MusicBrainz.
    """
    artist = request.args.get("artist", "").strip()
    album  = request.args.get("album",  "").strip()
    mbid   = request.args.get("mbid",   "").strip()
    if not artist and not album:
        return jsonify({"error": "artist/album requeridos"}), 400

    result = {}

    # Last.fm album.getInfo
    al_params = {"artist": artist, "album": album, "autocorrect": 1}
    al_data = lfm_get("album.getInfo", al_params)
    if "album" in al_data:
        al = al_data["album"]
        _tags = al.get("tags", {}).get("tag", [])
        if isinstance(_tags, dict): _tags = [_tags]
        result["lfm"] = {
            "listeners": al.get("listeners", ""),
            "playcount":  al.get("playcount",  ""),
            "tags":  [t["name"] for t in _tags[:6]],
            "wiki":  (al.get("wiki", {}).get("summary", "") or "").split("<a ")[0].strip(),
            "image": _lfm_image(al.get("image", [])),
            "url":   al.get("url", ""),
        }
        if not mbid and al.get("mbid"):
            mbid = al["mbid"]

    time.sleep(0.3 + random.random() * 0.2)
    # Last.fm artist.getInfo
    ar_data = lfm_get("artist.getInfo", {"artist": artist, "autocorrect": 1})
    if "artist" in ar_data:
        ar = ar_data["artist"]
        result["artist"] = {
            "bio":       (ar.get("bio", {}).get("summary", "") or "").split("<a ")[0].strip(),
            "listeners": ar.get("stats", {}).get("listeners", ""),
            "image":     _lfm_image(ar.get("image", [])),
            "url":       ar.get("url", ""),
        }

    # MusicBrainz si no tenemos MBID (solo si hay título de álbum)
    if not mbid and album:
        mb = mb_search_release_group(artist, album)
        if mb.get("mbid"):
            mbid = mb["mbid"]
            result.update({
                "mbid":       mbid,
                "cover_url":  f"{CAA}/{mbid}/front-500",
                "mb_title":   mb.get("title", album),
                "mb_artist":  mb.get("artist", artist),
                "date":       mb.get("date", ""),
            })
    else:
        result["mbid"]      = mbid
        result["cover_url"] = f"{CAA}/{mbid}/front-500"

    resp = jsonify(result)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/api/artist_info")
def api_artist_info():
    """Imagen y bio del artista desde Last.fm artist.getInfo."""
    artist = request.args.get("artist", "").strip()
    if not artist:
        return jsonify({"error": "artist requerido"}), 400
    ar_data = lfm_get("artist.getInfo", {"artist": artist, "autocorrect": 1})
    if "artist" not in ar_data:
        return jsonify({}), 200
    ar = ar_data["artist"]
    image = _lfm_image(ar.get("image", []))
    bio   = (ar.get("bio", {}).get("summary", "") or "").split("<a ")[0].strip()[:300]
    resp  = jsonify({"image": image, "bio": bio,
                     "listeners": ar.get("stats", {}).get("listeners", ""),
                     "playcount":  ar.get("stats", {}).get("playcount",  ""),
                     "url":        ar.get("url", "")})
    # Cache longer when we have an image; short cache when empty so stale "no image" expires fast
    resp.headers["Cache-Control"] = "public, max-age=86400" if image else "public, max-age=300"
    return resp


@app.route("/api/yt_search")
def api_yt_search():
    """Busca en YouTube Data API v3 y devuelve el primer videoId."""
    artist = request.args.get("artist", "").strip()
    album  = request.args.get("album",  "").strip()
    if not artist:
        return jsonify({"error": "artist requerido"}), 400
    if not YT_API_KEY:
        return jsonify({"error": "YouTube API key no configurada"}), 503
    q = f"{artist} {album}" if album else artist
    url = ("https://www.googleapis.com/youtube/v3/search?"
           + urllib.parse.urlencode({
               "part": "id", "q": q, "type": "video",
               "maxResults": "1", "key": YT_API_KEY,
           }))
    req = urllib.request.Request(url, headers={"User-Agent": "tumtumpa/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
        items = data.get("items", [])
        vid_id = items[0].get("id", {}).get("videoId", "") if items else ""
        resp = jsonify({"videoId": vid_id})
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)


@app.route("/manifest.json")
def manifest():
    return Response(json.dumps({
        "name": "tumtumpa",
        "short_name": "tumtumpa",
        "description": "Descubre qué escuchan tus amigos que tú no has escuchado aún",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#0a0a12",
        "theme_color": "#7c6fff",
        "icons": []
    }), content_type="application/json")


@app.route("/sw.js")
def service_worker():
    sw = (
        "const CACHE='tumtumpa-v3';\n"
        "self.addEventListener('install',e=>{self.skipWaiting();});\n"
        "self.addEventListener('activate',e=>{"
        "e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));"
        "clients.claim();});\n"
        "self.addEventListener('fetch',e=>{"
        "if(e.request.method!=='GET')return;"
        "const u=new URL(e.request.url);"
        "if(u.origin!==self.location.origin)return;"
        "if(u.pathname.includes('/api/'))return;"   # skip all /api/ paths regardless of prefix
        "e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));"
        "});\n"
    )
    return Response(sw, content_type="application/javascript",
                    headers={"Service-Worker-Allowed": "/"})


# ── HTML Template ──────────────────────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>tumtumpa</title>
<link rel="icon" type="image/png" href="/img/little_chicken.png" />
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#7c6fff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-title" content="tumtumpa">
<meta name="description" content="Descubre qué escuchan tus amigos que tú no has escuchado aún">
<!-- Umami Analytics -->
<script defer src="https://cloud.umami.is/script.js" data-website-id="262419b6-9389-4f91-898c-3943726c6dc8"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/css/discover.css">
</head>
<body>

<!-- ── Welcome screen (shown when no data) ──────────────────────────── -->
<div id="welcome-screen" style="display:none;position:fixed;inset:0;z-index:200;background:var(--bg);overflow-y:auto;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);">
  <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1.5rem;gap:2rem;max-width:480px;margin:0 auto">
    <div style="text-align:center">
      <div style="font-family:var(--serif);font-size:2.5rem;font-weight:800;letter-spacing:-0.02em;line-height:1.1;margin-bottom:0.5rem">
        <span style="color:var(--accent)">tumtum</span>pa
      </div>
      <div style="font-family:var(--mono);font-size:0.72rem;color:var(--ink3);letter-spacing:.12em;text-transform:uppercase">by volteret4</div>
    </div>

    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:1.5rem;display:flex;flex-direction:column;gap:1.2rem;width:100%">
      <p style="font-size:0.95rem;line-height:1.6;color:var(--ink2)">
        Compara tu historial de <strong style="color:var(--ink)">Last.fm</strong> con el de tus amigos y descubre qué escuchan ellos que a ti te falta.
      </p>

      <div style="display:flex;flex-direction:column;gap:0.8rem">
        <div style="display:flex;gap:0.75rem;align-items:flex-start">
          <span style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:0.15rem 0.5rem;flex-shrink:0;margin-top:0.1rem">01</span>
          <span style="font-size:0.85rem;color:var(--ink2);line-height:1.5">Carga <strong style="color:var(--ink)">tu usuario</strong> de Last.fm. Descargamos todos tus álbumes escuchados — puede tardar un minuto, pero se guardan en tu navegador para la próxima vez.</span>
        </div>
        <div style="display:flex;gap:0.75rem;align-items:flex-start">
          <span style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:0.15rem 0.5rem;flex-shrink:0;margin-top:0.1rem">02</span>
          <span style="font-size:0.85rem;color:var(--ink2);line-height:1.5">Añade <strong style="color:var(--ink)">usuarios secundarios</strong> — amigos, músicos, críticos — cuyo gusto quieras explorar.</span>
        </div>
        <div style="display:flex;gap:0.75rem;align-items:flex-start">
          <span style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:0.15rem 0.5rem;flex-shrink:0;margin-top:0.1rem">03</span>
          <span style="font-size:0.85rem;color:var(--ink2);line-height:1.5">Pulsa <strong style="color:var(--ink)">Descubrir</strong> junto a cualquier usuario para ver sus álbumes favoritos que tú no has escuchado.</span>
        </div>
      </div>

      <button id="btn-start-welcome" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:0.85rem 1.5rem;font-family:var(--serif);font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:0.02em;transition:background 0.15s">
        Comenzar →
      </button>
    </div>

    <div style="font-family:var(--mono);font-size:0.65rem;color:var(--ink3);text-align:center;line-height:1.6">
      Los datos se guardan solo en tu navegador (IndexedDB).<br>Puedes exportar e importar JSON en cualquier momento.
    </div>
  </div>
</div>

<!-- ── Header ─────────────────────────────────────────────────────────── -->
<header style="height:52px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 1.2rem;gap:1rem;flex-shrink:0;position:sticky;top:0;z-index:100;">
  <a class="logo" href="/" style="font-family:var(--serif);font-size:1.3rem;font-weight:800;text-decoration:none"><span style="color:var(--accent)">tumtum</span><span style="color:#fff">pa!</span></a>
  <div style="flex:1"></div>
  <div id="badge-inline" style="display:none;align-items:center;gap:0.5rem;">
    <img id="badge-avatar" src="" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;background:var(--bg3);display:none">
    <span id="badge-name" style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);"></span>
  </div>
  <button id="btn-open-users" title="Gestionar usuarios" style="width:34px;height:34px;border-radius:50%;background:var(--bg3);border:1px solid var(--border2);color:var(--ink2);font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:border-color .15s,color .15s">👤</button>
</header>

<input type="file" id="inp-session" accept=".json" style="display:none">

<!-- ── User modal ──────────────────────────────────────────────────────── -->
<div id="user-modal-bg">
  <div id="user-modal">
    <button class="modal-close">✕</button>

    <!-- Buscador universal -->
    <div class="um-section">
      <div class="um-section-title">Buscar usuario</div>
      <div class="um-row">
        <input id="inp-user" type="text" placeholder="Usuario Last.fm" autocomplete="off" spellcheck="false">
        <button class="btn-sm primary" id="btn-go">Buscar</button>
        <button class="btn-sm" id="btn-import">↑ JSON</button>
      </div>
      <div class="source-radios">
        <label><input type="radio" name="um-source" id="um-src-lfm" value="lfm" checked> Last.fm</label>
        <label><input type="radio" name="um-source" id="um-src-lb"  value="lb"> ListenBrainz</label>
      </div>
      <div class="um-progress" id="um-progress"></div>
    </div>

    <!-- Usuarios (principal + secundarios unificados) -->
    <div class="um-section" id="um-sec-secondary">
      <div class="um-section-title">Usuarios</div>
      <div id="secondary-users-list"></div>
      <div id="sb-cache-notice" style="display:none"></div>
      <div class="um-progress" id="um-extra-progress"></div>
    </div>

    <!-- Amigos -->
    <div class="um-section">
      <div class="um-section-title" style="display:flex;align-items:center;justify-content:space-between">
        Amigos del usuario principal
        <button class="btn-sm" id="btn-load-friends" style="font-size:0.62rem">Cargar</button>
      </div>
      <div id="friends-list" style="max-height:200px;overflow-y:auto;scrollbar-width:thin"></div>
    </div>
  </div>
</div>

<!-- Hidden file inputs keep their IDs for JS event listeners -->
<input type="file" id="inp-extra-json" accept=".json" style="display:none">

<!-- About modal -->
<div id="about-overlay">
  <div id="about-modal">
    <button class="about-close">✕</button>
    <h2>tumtumpa</h2>
    <p>Cruza tu historial de <b>Last.fm</b> con otros usuarios para saber qué te falta escuchar de su colección.</p>

    <h3>Primeros pasos</h3>
    <ul>
      <li>Introduce tu usuario de Last.fm y pulsa <b>Go</b> para descargar tus scrobbles.</li>
      <li>Selecciona una <b>colección</b> en el panel izquierdo para ver qué álbumes has escuchado (dorado) y cuáles te faltan.</li>
      <li>Usa los filtros de la barra superior para ver solo los escuchados, los pendientes o los recomendados.</li>
    </ul>


    <h3>Panel de detalles</h3>
    <ul>
      <li>Haz clic en cualquier portada para ver estadísticas de Last.fm, tags, descripción del álbum y bio del artista.</li>
      <li>Enlace directo a MusicBrainz y YouTube (o búsqueda si no hay ID guardado).</li>
    </ul>

    <h3>Usuarios secundarios</h3>
    <ul>
      <li>Añade amigos desde el botón <b>Usuario</b> → sección <i>Usuarios secundarios</i>.</li>
      <li>Puedes cargar la lista de amigos de tu usuario principal para añadirlos rápidamente.</li>
      <li>Obtén álbumes y artistas que ellos han escuchado y tu aun no.</li>
    </ul>

    <h3>Sesiones</h3>
    <ul>
      <li>Los scrobbles se guardan en <b>IndexedDB</b> del navegador: la próxima vez no hace falta re-descargar.</li>
      <li>Exporta / importa sesiones como JSON o sincroniza incrementalmente con el botón <b>↻ Sync</b>.</li>
    </ul>
    <h3>Servicios</h3>

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
    <a class="about-svc gh" href="https://github.com/volteret4/escuchowsky" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      GitHub
    </a>

  </div>
</div>

<!-- ── App shell ───────────────────────────────────────────────────────── -->
<div class="app-shell">

  <!-- ── Main ──────────────────────────────────────────────────────────── -->
  <div id="main">

    <!-- Controles sticky: fuera de .main-inner para pegarse al header sin huecos -->
    <div id="discover-ctrl-bar" style="display:none">
      <div id="disc-rel-tabs">
        <button class="disc-tab active" data-rel="discover">Escucha</button>
        <button class="disc-tab" data-rel="share">Comparte</button>
        <button class="disc-tab" data-rel="enjoy">Disfruta</button>
      </div>
      <div id="disc-ctrl-row">
        <div id="disc-user-indicator"></div>
        <div class="disc-controls">
          <input type="number" id="disc-limit-global" min="5" max="100" value="20">
          <select id="disc-mode-select">
            <option value="albums">Álbumes</option>
            <option value="artists">Artistas</option>
            <option value="songs">Canciones</option>
          </select>
          <button id="disc-play-btn" title="Descubrir">▶</button>
        </div>
      </div>
    </div>

    <div class="main-inner">

      <!-- Error -->
      <div id="error-msg"></div>

      <!-- Loading -->
      <div id="loading">
        <div class="spinner"></div>
        <span id="loading-text">Cargando scrobbles...</span>
      </div>

      <!-- Empty state — shown when no discover results yet -->
      <div id="empty-state">
        <div id="empty-logo"><span style="color:var(--accent)">tumtum</span><span style="color:var(--ink2)">pa!</span></div>
        <p id="empty-tagline">Alégrate el día o mejora el de alguién con una joya musical.</p>
        <div id="empty-steps">
          <div class="empty-step"><span class="empty-num">01</span><span>Pulsa <b>👤</b> arriba a la derecha y busca tu usuario de <b>Last.fm</b> o <b>Listenbrainz</b>.</span></div>
          <div class="empty-step"><span class="empty-num">02</span><span>Añade <b>usuarios secundarios</b>. Es recomendable descargar el json para futuras sesiones.</span></div>
          <div class="empty-step"><span class="empty-num">03</span><span><b>Escuchar:</b> ver que han escuchado los demás que tu aun no.</span></div>
          <div class="empty-step"><span class="empty-num">04</span><span><b>Comparte:</b> permite encontrar alguna de tus joyas para recomendar al resto.</span></div>
          <div class="empty-step"><span class="empty-num">05</span><span><b>Disfruta:</b> muestra placeres compartidos, permitiendo afinar recomendaciones.</span></div>
          <div class="empty-step"><span class="empty-num">06</span><span>Pulsa <b>uno o varios usuarios</b> para mostrar los <b>artistas</b>, <b>álbumes</b> o <b>canciones</b> que comparten todos.</span></div>
          <div class="empty-step"><span class="empty-num">07</span><span>Pulsa en cada elemento del grid para obtener información y poder escuchar algo del mismo.</span></div>
        </div>
        <div id="empty-hint">Los datos se guardan en tu navegador (IndexedDB). Pero se llena rápidamente con varios usuarios, recuerda exportar / importar sesiones como JSON.</div>
      </div>

      <!-- Discover view (sin ctrl bar — ahora está fuera) -->
      <div id="discover-view">
        <div class="discover-filters" id="discover-decade-pills"></div>
        <div id="discover-grid"></div>
        <div class="discover-pagination" id="discover-pagination" style="display:none">
          <button class="btn-sm" id="disc-prev">← Anteriores</button>
          <span id="disc-page-info" style="font-family:var(--mono);font-size:0.72rem;color:var(--ink3)"></span>
          <button class="btn-sm" id="disc-next">Siguientes →</button>
        </div>
        <div class="discover-footer" id="discover-footer" style="display:none">
          <span id="discover-progress"></span>
        </div>
      </div>

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
    <div class="dp-loading" id="dp-loading" style="display:none">Consultando Last.fm…</div>
    <div class="dp-stats"   id="dp-stats"   style="display:none"></div>
    <div class="dp-tags"    id="dp-tags"></div>
    <div class="dp-yt"      id="dp-yt"      style="display:none"></div>
    <div class="dp-section" id="dp-album-wiki" style="display:none">
      <div class="dp-section-title">Álbum</div>
      <div class="dp-text" id="dp-wiki-text"></div>
    </div>
    <div class="dp-section" id="dp-artist-bio" style="display:none">
      <div class="dp-section-title" id="dp-artist-bio-title"></div>
      <div class="dp-text" id="dp-bio-text"></div>
    </div>
    <div class="dp-links" id="dp-links"></div>
  </div>
</div>

<script src="/static/js/discover.js"></script>
</body>
</html>"""

# ── CLI / entrypoint ──────────────────────────────────────────────────────────

def resolve_lastfm_key(cli_key: str | None) -> str:
    if cli_key:
        return cli_key
    k = os.environ.get("LASTFM_API_KEY", "")
    if k:
        return k
    # SOPS
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
    global LFM_API_KEY

    parser = argparse.ArgumentParser(description="mustdiscover — comparación entre usuarios")
    parser.add_argument("--lastfm-api-key", default=None,  help="Last.fm API key")
    parser.add_argument("--port",           type=int, default=5001)
    parser.add_argument("--host",           default="127.0.0.1")
    parser.add_argument("--debug",          action="store_true")
    args = parser.parse_args()

    LFM_API_KEY = resolve_lastfm_key(args.lastfm_api_key)

    if not LFM_API_KEY:
        print("⚠  Sin Last.fm API key — las búsquedas fallarán.")
        print("   Usa --lastfm-api-key KEY, env LASTFM_API_KEY, o .encrypted.env")

    print(f"🎵 mustdiscover → http://{args.host}:{args.port}")
    print(f"🔑 Last.fm API key: {'✓' if LFM_API_KEY else '✗ no encontrada'}")

    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
