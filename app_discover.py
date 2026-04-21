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

app = Flask(__name__)

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
        "const CACHE='tumtumpa-v2';\n"
        "self.addEventListener('install',e=>{self.skipWaiting();});\n"
        "self.addEventListener('activate',e=>{"
        "e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));"
        "clients.claim();});\n"
        "self.addEventListener('fetch',e=>{"
        "if(e.request.method!=='GET')return;"
        "const u=new URL(e.request.url);"
        "if(u.origin!==self.location.origin)return;"  # never intercept cross-origin (fonts, images, scripts)
        "if(u.pathname.startsWith('/api/'))return;"   # never intercept API/SSE calls
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
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="tumtumpa">
<meta name="description" content="Descubre qué escuchan tus amigos que tú no has escuchado aún">
<!-- Umami Analytics -->
<script defer src="https://cloud.umami.is/script.js" data-website-id="262419b6-9389-4f91-898c-3943726c6dc8"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
/* ── Reset & Variables ─────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #0a0a12;
  --bg2:      #10101c;
  --bg3:      #18182a;
  --border:   #252535;
  --border2:  #303048;
  --ink:      #e4e0f0;
  --ink2:     #8a86a0;
  --ink3:     #50506a;
  --accent:   #7c6fff;
  --accent2:  #5c4fdf;
  --heard-tint: rgba(124,111,255,0.07);
  --missing-tint: rgba(255,255,255,0.02);
  --red:      #c0392b;
  --radius:   4px;
  --mono:     'DM Mono', monospace;
  --serif:    'Syne', sans-serif;
  --sans:     'DM Sans', sans-serif;
}

html { font-size: 15px; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-weight: 300;
  min-height: 100vh;
  line-height: 1.5;
}

/* ── Noise overlay ─────────────────────────────────────────────────── */
body::before {
  content: '';
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  opacity: 0.025;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 200px;
}

/* ── Layout ────────────────────────────────────────────────────────── */
.page { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; padding: 0 2rem 4rem; }

/* ── Header ────────────────────────────────────────────────────────── */
header {
  padding: 3rem 0 2rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2.5rem;
  display: flex;
  align-items: flex-end;
  gap: 2rem;
}
.logo {
  font-family: var(--serif);
  font-size: 2.6rem;
  font-weight: 900;
  letter-spacing: -0.02em;
  color: var(--ink);
  line-height: 1;
}
.logo em {
  color: var(--accent);
  font-style: italic;
}
.tagline {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--ink3);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin-bottom: 0.2rem;
}

/* ── Search panel ──────────────────────────────────────────────────── */
.search-panel {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 1rem;
  align-items: end;
  margin-bottom: 2rem;
}
label {
  display: block;
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-bottom: 0.4rem;
}
input, select {
  width: 100%;
  background: var(--bg2);
  border: 1px solid var(--border2);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.88rem;
  padding: 0.65rem 0.9rem;
  border-radius: var(--radius);
  outline: none;
  transition: border-color 0.15s;
  -webkit-appearance: none;
}
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%235a5248' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.8rem center;
  padding-right: 2.2rem;
  cursor: pointer;
}
input:focus, select:focus { border-color: var(--accent2); }
input::placeholder { color: var(--ink3); }
.btn {
  background: var(--accent);
  color: #0d0d0d;
  border: none;
  font-family: var(--mono);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.65rem 1.5rem;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, transform 0.1s;
}
.btn:hover  { background: var(--accent2); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

/* ── User badge ────────────────────────────────────────────────────── */
#user-badge {
  display: none;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1rem;
}
#user-badge.visible { display: flex; }
#badge-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--bg3); }
#badge-name   { font-family: var(--mono); font-size: 0.82rem; color: var(--ink); }
#badge-plays  { font-family: var(--mono); font-size: 0.72rem; color: var(--ink3); }
#badge-date   { font-family: var(--mono); font-size: 0.68rem; color: var(--ink3); }
.badge-actions { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; }

/* ── User modal ────────────────────────────────────────────────────── */
#user-modal-bg {
  display: none; position: fixed; inset: 0; z-index: 500;
  background: rgba(0,0,0,0.72);
  backdrop-filter: blur(3px);
  align-items: flex-start; justify-content: center;
  padding: 3.5rem 1rem 2rem;
  overflow-y: auto;
}
#user-modal-bg.open { display: flex; }
#user-modal {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 4px;
  width: 100%; max-width: 520px;
  position: relative;
  animation: modalIn 0.2s ease;
}
.um-section {
  padding: 1.1rem 1.4rem 1.2rem;
  border-bottom: 1px solid var(--border);
}
.um-section:last-child { border-bottom: none; }
.um-section-title {
  font-family: var(--mono);
  font-size: 0.58rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-bottom: 0.85rem;
}
.um-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.55rem; }
.um-row input { flex: 1; }
.source-radios {
  display: flex; gap: 0.7rem; margin-bottom: 0.45rem;
}
.source-radios label {
  display: flex; align-items: center; gap: 0.28rem;
  font-family: var(--mono); font-size: 0.68rem; color: var(--ink3);
  cursor: pointer; user-select: none;
}
.source-radios label.checked { color: var(--ink); }
.source-radios input[type=radio] { accent-color: var(--accent); cursor: pointer; }
.um-progress {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--ink3);
  padding: 0.3rem 0 0.5rem;
  min-height: 1.4rem;
}
#um-current-user {
  display: none;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg3);
  border-radius: var(--radius);
  margin-bottom: 0.75rem;
  border-left: 2px solid var(--accent);
}
#um-current-user.visible { display: flex; }
.um-user-name { font-family: var(--mono); font-size: 0.82rem; color: var(--ink); font-weight: 500; flex: 1; }
.um-user-meta { font-family: var(--mono); font-size: 0.68rem; color: var(--ink3); }
.um-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.8rem; }
.um-sep {
  font-family: var(--mono);
  font-size: 0.58rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink3);
  margin: 0.6rem 0 0.4rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.idb-empty { font-size: 0.72rem; color: var(--ink3); padding: 0.3rem 0; }
.idb-entry {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.4rem; border-radius: 4px; font-size: 0.72rem;
}
.idb-entry:hover { background: var(--bg3); }
.idb-entry-info { flex: 1; min-width: 0; }
.idb-entry-user { font-family: var(--mono); font-weight: 600; color: var(--ink); }
.idb-entry-meta { color: var(--ink3); font-size: 0.65rem; }
/* extra users in modal */
.eu-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; }
.eu-dot { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; }
.eu-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--bg3); }
.eu-name { flex: 1; font-family: var(--mono); font-size: 0.78rem; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eu-meta { font-family: var(--mono); font-size: 0.65rem; color: var(--ink3); flex-shrink: 0; }
.eu-del { background: none; border: none; color: var(--ink3); cursor: pointer; font-size: 0.9rem; padding: 0 2px; flex-shrink: 0; }
.eu-del:hover { color: var(--red); }
/* Friends list */
#friends-list { max-height: 220px; overflow-y: auto; scrollbar-width: thin; }
.fr-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.28rem 0; }
.fr-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--bg3); }
.fr-name { flex: 1; font-family: var(--mono); font-size: 0.75rem; color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-add { font-size: 0.65rem; padding: 0.2rem 0.5rem; flex-shrink: 0; }
.fr-add:disabled { opacity: .45; cursor: default; }
/* header badge button */
#badge-inline { display: none !important; }
#btn-usuario {
  font-family: var(--mono);
  font-size: 0.65rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 0.35rem 0.85rem;
  border-radius: var(--radius);
  cursor: pointer;
  border: 1px solid var(--border2);
  background: var(--bg3);
  color: var(--ink2);
  transition: all 0.12s;
  white-space: nowrap;
}
#btn-usuario:hover { border-color: var(--accent); color: var(--accent); }
#btn-usuario.loaded { border-color: var(--accent); color: var(--accent); }

.btn-sm {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.3rem 0.75rem;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.12s;
  border: 1px solid var(--border2);
  background: var(--bg3);
  color: var(--ink2);
}
.btn-sm:hover { border-color: var(--accent); color: var(--accent); }
.btn-sm.primary { background: transparent; border-color: var(--accent); color: var(--accent); }
.btn-sm.primary:hover { background: transparent; border-color: var(--accent2); color: var(--accent2); }
#inp-session { display: none; }

/* ── Stats bar ─────────────────────────────────────────────────────── */
#stats-bar {
  display: none;
  align-items: center;
  gap: 2rem;
  padding: 0.9rem 1.2rem;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
#stats-bar.visible { display: flex; }
.stat { text-align: center; }
.stat-val {
  font-family: var(--serif);
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1;
  color: var(--ink);
}
.stat-val.accent { color: var(--accent); }
.stat-lbl {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink3);
  margin-top: 0.2rem;
}
.stat-sep { width: 1px; height: 36px; background: var(--border); align-self: center; }

/* ── Progress bar ──────────────────────────────────────────────────── */
.prog-wrap { flex: 1; min-width: 160px; }
.prog-track {
  height: 4px;
  background: var(--bg3);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 0.5rem;
}
.prog-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.6s cubic-bezier(.16,1,.3,1);
  width: 0%;
}

/* ── Filters ───────────────────────────────────────────────────────── */
#filters {
  display: none;
  gap: 0.5rem;
  margin-bottom: 1.2rem;
  flex-wrap: wrap;
  align-items: center;
}
#filters.visible { display: flex; }
.filter-btn {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.35rem 0.8rem;
  background: var(--bg2);
  border: 1px solid var(--border2);
  color: var(--ink2);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.12s;
}
.filter-btn:hover  { border-color: var(--ink3); color: var(--ink); }
.filter-btn.active { background: var(--accent); border-color: var(--accent); color: #0d0d0d; }
.filter-sep { margin-left: auto; }
#sort-select { width: auto; padding: 0.35rem 2rem 0.35rem 0.7rem; font-size: 0.7rem; }

/* ── Grid ──────────────────────────────────────────────────────────── */
#grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

/* ── Album card ────────────────────────────────────────────────────── */
.card {
  position: relative;
  background: var(--bg);
  cursor: pointer;
  overflow: hidden;
  transition: z-index 0s;
  aspect-ratio: 1;
}
.card.heard   { background: var(--heard-tint); box-shadow: inset 0 0 0 2px var(--accent); }
.card.missing { background: var(--missing-tint); }

.card-cover {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease, filter 0.3s ease;
  filter: grayscale(20%) brightness(0.85);
}
.card:hover .card-cover {
  transform: scale(1.04);
  filter: grayscale(0%) brightness(1);
}
.card.heard .card-cover   { filter: grayscale(0%)  brightness(0.9); }
.card.missing .card-cover { filter: grayscale(60%) brightness(0.7); }
.card:hover.missing .card-cover { filter: grayscale(20%) brightness(0.85); }

.card-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0) 55%);
  pointer-events: none;
}
.card-info {
  position: absolute; bottom: 0; left: 0; right: 0;
  padding: 0.5rem 0.55rem 0.5rem;
}
.card-title {
  font-family: var(--sans);
  font-size: 0.72rem;
  font-weight: 500;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}
.card-artist {
  font-family: var(--mono);
  font-size: 0.6rem;
  color: rgba(255,255,255,0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 0.1rem;
}
.card-year {
  font-family: var(--mono);
  font-size: 0.58rem;
  color: rgba(255,255,255,0.35);
}
.card-n {
  position: absolute; top: 0.4rem; left: 0.4rem;
  font-family: var(--mono);
  font-size: 0.58rem;
  color: rgba(255,255,255,0.3);
  background: rgba(0,0,0,0.5);
  padding: 0.1rem 0.3rem;
  border-radius: 1px;
}
/* extra-user dots on cards */
.extra-dots {
  position: absolute; top: 0.4rem; right: 0.4rem;
  display: flex; flex-direction: column; gap: 2px; align-items: flex-end;
}
.extra-dot {
  width: 8px; height: 8px; border-radius: 50%;
  opacity: 0.22; transition: opacity .12s;
}
.extra-dot.heard { opacity: 1; box-shadow: 0 0 4px currentColor; }

/* Recommendations panel */
#rec-panel { display:none; padding: 1.5rem 1rem; }
#rec-panel.visible { display:block; }
.rec-info { color: var(--ink2); font-size: 0.83rem; line-height: 1.65; max-width: 560px; }
.rec-info h3 { color: var(--ink); font-size: 0.9rem; margin: 0 0 0.5rem; text-transform: uppercase; letter-spacing: .05em; }
.rec-controls { display:flex; align-items:center; gap: 0.75rem; margin: 1rem 0 0.5rem; flex-wrap:wrap; }
.rec-controls label { display:flex; align-items:center; gap:0.4rem; font-family:var(--mono); font-size:0.78rem; }
.rec-controls input[type=number] { width:58px; background:var(--bg3); border:1px solid var(--border); color:var(--ink); padding:4px 6px; border-radius:4px; font-family:var(--mono); font-size:0.78rem; }
.rec-controls button { background:var(--accent); color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-family:var(--mono); font-size:0.78rem; }
.rec-controls button:disabled { opacity:.45; cursor:not-allowed; }
#rec-progress { font-family:var(--mono); font-size:0.72rem; color:var(--ink3); min-height:1.2em; }
/* Rec cards */
.rc-users { display:flex; align-items:center; gap:3px; margin-top:3px; flex-wrap:wrap; }
.rc-avatar { width:14px; height:14px; border-radius:50%; object-fit:cover; }
.rc-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.rc-count { font-family:var(--mono); font-size:0.6rem; color:var(--ink3); margin-left:2px; }

/* floating sidebar button (mobile) */
#sidebar-fab {
  display: none;
  position: fixed; bottom: 1.5rem; left: 1rem; z-index: 300;
  width: 46px; height: 46px; border-radius: 50%;
  background: var(--accent); color: #0d0d0d; border: none;
  font-size: 1.15rem; cursor: pointer;
  align-items: center; justify-content: center;
  box-shadow: 0 3px 14px rgba(0,0,0,0.55);
  transition: background 0.15s;
}
#sidebar-fab:hover { background: var(--accent2); }
#sidebar-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.5); z-index: 199;
}

/* ── Cover placeholder ─────────────────────────────────────────────── */
.card-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg3);
}
.card-placeholder svg { width: 28px; height: 28px; opacity: 0.2; }

/* ── Detail side panel ─────────────────────────────────────────────── */
#detail-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.55); backdrop-filter: blur(2px);
  z-index: 400;
}
#detail-overlay.open { display: block; }
#detail-panel {
  position: fixed; right: 0; top: 52px; height: calc(100dvh - 52px);
  width: min(440px, 100vw);
  background: var(--bg2); border-left: 1px solid var(--border2);
  transform: translateX(100%);
  transition: transform 0.25s cubic-bezier(.4,0,.2,1);
  z-index: 401; overflow-y: auto;
  display: flex; flex-direction: column;
}
#detail-panel.open { transform: translateX(0); }
.dp-close {
  position: absolute; top: 0.75rem; right: 0.75rem;
  background: none; border: none; color: var(--ink3);
  cursor: pointer; font-size: 1.2rem; line-height: 1;
  padding: 0.2rem 0.4rem; z-index: 1;
}
.dp-close:hover { color: var(--ink); }
.dp-header {
  display: flex; gap: 1rem; padding: 1.4rem;
  border-bottom: 1px solid var(--border);
  padding-right: 2.5rem; flex-shrink: 0;
}
.dp-cover {
  width: 100px; height: 100px; object-fit: cover;
  border-radius: 2px; flex-shrink: 0; background: var(--bg3);
}
.dp-meta { flex: 1; min-width: 0; }
.dp-title {
  font-family: var(--serif); font-size: 1.15rem;
  font-weight: 700; line-height: 1.25; color: var(--ink);
}
.dp-artist {
  font-family: var(--mono); font-size: 0.78rem;
  color: var(--accent); margin-top: 0.25rem;
}
.dp-year { font-family: var(--mono); font-size: 0.7rem; color: var(--ink3); margin-top: 0.15rem; }
.dp-status {
  display: inline-flex; align-items: center; gap: 0.35rem;
  margin-top: 0.5rem; font-family: var(--mono);
  font-size: 0.65rem; letter-spacing: 0.1em; text-transform: uppercase;
}
.dp-status.heard   { color: var(--accent); }
.dp-status.missing { color: var(--ink3); }
.dp-body { padding: 1.2rem 1.4rem 2rem; flex: 1; }
.dp-loading { font-family: var(--mono); font-size: 0.72rem; color: var(--ink3); margin-bottom: 0.8rem; }
.dp-stats {
  display: flex; gap: 1.5rem; margin-bottom: 0.9rem;
  font-family: var(--mono); font-size: 0.7rem; color: var(--ink3);
}
.dp-stats span b { color: var(--ink2); }
.dp-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-bottom: 0.9rem; }
.dp-tag {
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: .06em;
  text-transform: uppercase; padding: 0.15rem 0.5rem;
  border: 1px solid var(--border2); border-radius: var(--radius); color: var(--ink3);
}
.dp-yt {
  position: relative; width: 100%; padding-bottom: 56.25%;
  background: #000; border-radius: 2px; overflow: hidden; margin-bottom: 1rem;
}
.dp-yt iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }
.dp-section { margin-bottom: 0.9rem; }
.dp-section-title {
  font-family: var(--mono); font-size: 0.58rem; letter-spacing: .15em;
  text-transform: uppercase; color: var(--ink3); margin-bottom: 0.4rem;
}
.dp-text { font-size: 0.83rem; color: var(--ink2); line-height: 1.65; }
.dp-links { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
.dp-link {
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 0.3rem 0.7rem;
  border: 1px solid var(--border2); border-radius: var(--radius);
  color: var(--ink2); text-decoration: none; transition: all 0.12s;
}
.dp-link:hover { border-color: var(--accent); color: var(--accent); }

/* ── Empty state ───────────────────────────────────────────────────── */
#empty-state {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 1.4rem;
  min-height: calc(100dvh - 120px);
  text-align: center; padding: 2rem 1.5rem;
  max-width: 480px; margin: 0 auto;
}
/* hidden via JS when discover-view becomes visible */
#empty-logo {
  font-family: var(--serif); font-size: 2.8rem;
  font-weight: 800; letter-spacing: -0.02em; line-height: 1;
}
#empty-tagline {
  font-size: 0.95rem; color: var(--ink2); line-height: 1.55; margin: 0;
}
#empty-steps {
  display: flex; flex-direction: column; gap: 0.9rem;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: 8px; padding: 1.3rem 1.5rem; width: 100%;
  box-sizing: border-box; text-align: left;
}
.empty-step {
  display: flex; gap: 0.75rem; align-items: flex-start;
  font-size: 0.85rem; color: var(--ink2); line-height: 1.5;
}
.empty-num {
  font-family: var(--mono); font-size: 0.72rem; color: var(--accent);
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 3px; padding: 0.15rem 0.45rem;
  flex-shrink: 0; margin-top: 0.1rem;
}
.empty-step b { color: var(--ink); }
#empty-hint {
  font-family: var(--mono); font-size: 0.62rem;
  color: var(--ink3); line-height: 1.6; text-align: center;
}

/* ── Descubrir section ─────────────────────────────────────────────── */
#discover-view { display: none; }
#discover-view.visible { display: block; }
#discover-ctrl-bar {
  display: flex; align-items: center; gap: 0.5rem;
  flex-wrap: wrap; margin-bottom: 0.7rem;
}
#discover-ctrl-bar #disc-user-indicator {
  display: flex; flex-wrap: wrap; gap: 0.3rem; flex: 1; min-width: 0;
}
#discover-ctrl-bar .disc-controls {
  display: flex; align-items: center; gap: 0.35rem;
  padding: 0; flex-shrink: 0;
}
.discover-nav {
  display: none; /* eliminado */
}
.discover-filters {
  display: flex; gap: 0.4rem; flex-wrap: wrap;
  margin-bottom: 0.9rem;
}
.filter-pill {
  background: var(--bg3); border: 1px solid var(--border2); color: var(--ink3);
  font-family: var(--mono); font-size: 0.68rem; padding: 0.22rem 0.65rem;
  border-radius: 20px; cursor: pointer; transition: border-color .15s, color .15s;
}
.filter-pill:hover { border-color: var(--accent); color: var(--ink); }
.filter-pill.active { border-color: var(--accent); color: var(--accent); background: var(--bg2); }
#discover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.6rem;
  margin-bottom: 1.2rem;
}
.discover-footer {
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
  padding: 0.5rem 0; border-top: 1px solid var(--border);
  margin-top: 0.5rem;
}
#discover-progress { font-family: var(--mono); font-size: 0.72rem; color: var(--ink3); flex: 1; }
#btn-discover-more {
  background: var(--bg3); border: 1px solid var(--border2); color: var(--ink2);
  font-family: var(--mono); font-size: 0.72rem; padding: 0.35rem 0.9rem;
  border-radius: var(--radius); cursor: pointer;
}
#btn-discover-more:hover { border-color: var(--accent); color: var(--accent); }
#btn-discover-more:disabled { opacity: .4; cursor: not-allowed; }


/* ── Collapsible um-section ────────────────────────────────────────── */
.um-section-toggle {
  background: none; border: none; color: var(--ink3); cursor: pointer;
  font-size: 0.75rem; margin-left: auto; padding: 0 2px;
  line-height: 1; transition: transform .2s;
}
.um-section-body { /* always shown unless .collapsed */ }
.um-section.collapsed .um-section-body { display: none; }
.um-section.collapsed .um-section-toggle { transform: rotate(-90deg); }

/* ── Modal close button ────────────────────────────────────────────── */
.modal-close {
  position: absolute; top: 0.75rem; right: 0.75rem;
  background: none; border: none; color: var(--ink3);
  font-size: 1.1rem; cursor: pointer; line-height: 1; padding: 0.2rem 0.4rem;
}
.modal-close:hover { color: var(--ink); }

/* ── Primary user card in modal ────────────────────────────────────── */
.um-primary-card {
  display: flex; align-items: center; gap: 0.65rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg3);
  border-radius: var(--radius);
  border-left: 3px solid var(--accent);
  margin-bottom: 0.5rem;
}
.um-primary-card img { flex-shrink:0; }

/* ── Secondary users in modal ──────────────────────────────────────── */
.sec-user-row {
  display: flex; flex-direction: column;
  padding: 0.45rem 0; border-bottom: 1px solid var(--border);
}
.sec-user-row:last-child { border-bottom: none; }
.sec-user-left { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
.sec-user-info { flex: 1; min-width: 0; }
.sec-user-name { font-family: var(--mono); font-size: 0.8rem; font-weight: 600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sec-user-row.active .sec-user-name { color: var(--ink); }
.sec-user-row:not(.active) .sec-user-name { color: var(--ink2); }
.sec-user-meta { font-family: var(--mono); font-size: 0.62rem; color: var(--ink3); }
.sec-user-btns { display: flex; gap: 0.3rem; flex-wrap: wrap; padding-left: 1.8rem; }
.btn-sm.act { background: transparent; border-color: var(--accent); color: var(--accent); }
.btn-sm.act:hover { background: transparent; border-color: var(--accent2); color: var(--accent2); }

@keyframes modalIn { from { opacity:0; transform: scale(0.96) translateY(8px); } }

/* ── Loading / Error ───────────────────────────────────────────────── */
#loading {
  display: none; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 6rem 2rem; gap: 1rem;
  color: var(--ink3);
  font-family: var(--mono);
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
#loading.visible { display: flex; }
.spinner {
  width: 28px; height: 28px;
  border: 2px solid var(--border2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#error-msg {
  display: none;
  padding: 1rem 1.2rem;
  background: rgba(192,57,43,0.1);
  border: 1px solid rgba(192,57,43,0.3);
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 0.8rem;
  color: #e07060;
  margin-bottom: 1rem;
}
#error-msg.visible { display: block; }

/* ── Empty state ───────────────────────────────────────────────────── */
#empty {
  display: none;
  text-align: center;
  padding: 5rem 2rem;
  color: var(--ink3);
}
#empty.visible { display: block; }
#empty p { font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.1em; text-transform: uppercase; }

/* ── App shell ─────────────────────────────────────────────────────── */
.app-shell {
  height: calc(100dvh - 52px);
  overflow: hidden;
  display: flex;
}

/* ── Sidebar (eliminado — mantenido por si hay referencias residuales) ─ */
#sidebar {
  display: none;
  overflow: hidden;
}
.sb-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 0;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.sb-scroll::-webkit-scrollbar { width: 3px; }
.sb-scroll::-webkit-scrollbar-thumb { background: var(--border); }

/* ── Sidebar panel ─────────────────────────────────────────────────── */
.sb-panel { margin-bottom: 0.25rem; }
.sb-panel-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.45rem 0.9rem;
  cursor: pointer;
  user-select: none;
}
.sb-panel-title {
  font-family: var(--mono);
  font-size: 0.58rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink3);
}
.sb-panel-arrow {
  font-size: 0.55rem;
  color: var(--ink3);
  transition: transform 0.15s;
}
.sb-panel.open .sb-panel-arrow { transform: rotate(90deg); }
.sb-panel-body { display: none; }
.sb-panel.open .sb-panel-body { display: block; }

/* ── Collapsible groups ─────────────────────────────────────────────── */
.sb-grp { border-top: 1px solid var(--border); }
.sb-grp-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.42rem 0.9rem;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}
.sb-grp-hdr:hover { background: var(--bg3); }
.sb-grp-name {
  font-family: var(--mono);
  font-size: 0.6rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink3);
}
.sb-grp-arrow {
  font-size: 0.5rem;
  color: var(--ink3);
  transition: transform 0.15s;
  flex-shrink: 0;
}
.sb-grp.open .sb-grp-arrow { transform: rotate(90deg); }
.sb-grp-body { display: none; }
.sb-grp.open .sb-grp-body { display: block; }

/* ── Flat collection item ───────────────────────────────────────────── */
.sb-coll-item {
  display: flex;
  align-items: center;
  padding: 0.36rem 0.9rem 0.36rem 1.1rem;
  cursor: pointer;
  transition: background 0.1s;
  font-family: var(--sans);
  font-size: 0.74rem;
  color: var(--ink2);
  line-height: 1.2;
  gap: 0.4rem;
}
.sb-coll-item:hover  { background: var(--bg3); color: var(--ink); }
.sb-coll-item.active { background: rgba(232,193,74,0.08); color: var(--accent); border-left: 2px solid var(--accent); padding-left: calc(1.1rem - 2px); }
.sb-coll-count {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.56rem;
  color: var(--ink3);
  flex-shrink: 0;
}

/* ── Genre tree (RYM Charts) ───────────────────────────────────────── */
.tree-genre { }
.tree-genre-hdr {
  display: flex;
  align-items: center;
  padding: 0.36rem 0.9rem 0.36rem 1.1rem;
  cursor: pointer;
  transition: background 0.1s;
  gap: 0.35rem;
}
.tree-genre-hdr:hover { background: var(--bg3); }
.tree-genre-hdr.active { background: rgba(232,193,74,0.08); border-left: 2px solid var(--accent); padding-left: calc(1.1rem - 2px); }
.tree-genre-name {
  font-family: var(--sans);
  font-size: 0.74rem;
  color: var(--ink2);
  flex: 1;
}
.tree-genre-hdr:hover .tree-genre-name,
.tree-genre-hdr.active .tree-genre-name { color: var(--accent); }
.tree-genre-arrow {
  font-size: 0.48rem;
  color: var(--ink3);
  transition: transform 0.15s;
  flex-shrink: 0;
}
.tree-genre.open > .tree-genre-hdr .tree-genre-arrow { transform: rotate(90deg); }
.tree-sub { display: none; }
.tree-genre.open > .tree-sub { display: block; }
.tree-sub-item {
  display: flex;
  align-items: center;
  padding: 0.3rem 0.9rem 0.3rem 2rem;
  cursor: pointer;
  transition: background 0.1s;
  font-family: var(--sans);
  font-size: 0.7rem;
  color: var(--ink3);
  line-height: 1.2;
}
.tree-sub-item:hover  { background: var(--bg3); color: var(--ink); }
.tree-sub-item.active { color: var(--accent); background: rgba(232,193,74,0.06); }

/* ── Pill filters (genres, decades) ───────────────────────────────── */
.sb-pills {
  padding: 0.4rem 0.7rem 0.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.pill {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.04em;
  padding: 0.22rem 0.55rem;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: 10px;
  color: var(--ink3);
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}
.pill:hover  { border-color: var(--ink3); color: var(--ink); }
.pill.active { background: var(--accent); border-color: var(--accent); color: #0d0d0d; }
.sb-empty {
  padding: 0.5rem 1rem;
  font-family: var(--mono);
  font-size: 0.65rem;
  color: var(--ink3);
  font-style: italic;
}

/* ── Discover compact controls ───────────────────────────────────────────── */
.disc-controls {
  display: flex; align-items: center; gap: 0.35rem;
  padding: 0.5rem 0.9rem 0.4rem;
}
.disc-controls input[type=number] {
  width: 46px; background: var(--bg3); border: 1px solid var(--border);
  color: var(--ink); padding: 3px 4px; border-radius: 3px;
  font-family: var(--mono); font-size: 0.7rem; text-align: center;
  -moz-appearance: textfield;
}
.disc-controls input[type=number]::-webkit-inner-spin-button,
.disc-controls input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.disc-controls select {
  flex: 1; background: var(--bg3); border: 1px solid var(--border);
  color: var(--ink); padding: 3px 4px; border-radius: 3px;
  font-family: var(--mono); font-size: 0.7rem;
}
#disc-play-btn {
  width: 26px; height: 22px; background: var(--accent); color: var(--bg);
  border: none; border-radius: 3px; cursor: pointer; font-size: 0.6rem;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
#disc-play-btn:hover { background: var(--accent2); }
/* ── Discover user pills (barra horizontal) ─────────────────────────────── */
.disc-user-line {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.22rem 0.6rem; border-radius: 20px;
  cursor: pointer; user-select: none;
  font-family: var(--mono); font-size: 0.68rem; color: var(--ink3);
  background: var(--bg3); border: 1px solid var(--border2);
  transition: border-color .15s, color .15s;
  white-space: nowrap;
}
.disc-user-line:hover { border-color: var(--accent); color: var(--ink); }
.disc-user-line.active { border-color: var(--accent); color: var(--accent); background: var(--bg2); }
.disc-user-line-name { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }

/* ── Sidebar USUARIOS section ────────────────────────────────────────────── */
.sb-search-area { padding: 0.45rem 0.75rem 0.2rem; }
.sb-search-row { display: flex; gap: 0.3rem; align-items: center; }
.sb-search-row input { flex: 1; min-width: 0; font-size: 0.72rem; padding: 0.35rem 0.5rem; }
.sb-search-row .btn-sm { font-size: 0.6rem; padding: 0.28rem 0.45rem; white-space: nowrap; flex-shrink: 0; }
.sb-progress-txt { font-family: var(--mono); font-size: 0.63rem; color: var(--ink3); min-height: 1.1em; padding: 0.18rem 0 0; }
#sb-cache-notice { margin: 0.4rem 0 0.2rem; padding: 0.45rem 0.6rem; background: color-mix(in srgb, var(--warn,#c8820a) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn,#c8820a) 40%, transparent); border-radius: var(--radius); font-size: 0.62rem; color: var(--ink2); line-height: 1.45; }
#sb-cache-notice b { color: color-mix(in srgb, var(--warn,#c8820a) 80%, var(--ink)); }
#sb-cache-notice .notice-btns { display: flex; gap: 0.4rem; margin-top: 0.35rem; flex-wrap: wrap; }
#sb-cache-notice button { font-size: 0.6rem; padding: 0.2rem 0.5rem; }
.sb-search-area .source-radios { margin: 0.25rem 0 0; gap: 0.6rem; }
.sb-search-area .source-radios label { font-size: 0.62rem; }
.sb-user-item { padding: 0.38rem 0.75rem; border-top: 1px solid var(--border); }
.sb-user-item-primary { border-left: 2px solid var(--accent); padding-left: calc(0.75rem - 2px); background: rgba(124,111,255,0.04); }
.sb-user-item-left { display: flex; align-items: center; gap: 0.4rem; }
.sb-user-item-info { flex: 1; min-width: 0; overflow: hidden; }
.sb-user-item-name { font-family: var(--mono); font-size: 0.7rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-user-item-primary .sb-user-item-name { color: var(--ink); }
.sb-user-item:not(.sb-user-item-primary) .sb-user-item-name { color: var(--ink2); }
.sb-user-item-meta { font-family: var(--mono); font-size: 0.58rem; color: var(--ink3); }
.sb-user-item-btns { display: flex; gap: 0.22rem; flex-wrap: wrap; padding: 0.22rem 0 0.05rem; }
.sb-user-item-btns .btn-sm { font-size: 0.58rem; padding: 0.16rem 0.38rem; }
.sb-friends-section { padding: 0.35rem 0.75rem 0.45rem; border-top: 1px solid var(--border); }
.sb-friends-btn { width: 100%; font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.28rem 0.7rem; background: var(--bg3); border: 1px solid var(--border2); color: var(--ink2); border-radius: var(--radius); cursor: pointer; transition: all 0.12s; }
.sb-friends-btn:hover { border-color: var(--accent); color: var(--accent); }
#sb-friends-list { max-height: 200px; overflow-y: auto; scrollbar-width: thin; margin-top: 0.35rem; }

/* ── Per-user filter buttons ─────────────────────────────────────────────── */
#filter-extra-users { display: contents; }
.filter-btn-user img, .filter-btn-user .fbu-dot {
  width: 12px; height: 12px; border-radius: 50%; object-fit: cover;
  vertical-align: middle; margin-right: 2px;
}

/* ── Discover pagination ─────────────────────────────────────────────────── */
.discover-pagination {
  display: flex; align-items: center; justify-content: center;
  gap: 1rem; padding: 1rem 0 0.5rem;
}
.discover-pagination button:disabled { opacity: 0.35; cursor: default; }

/* ── Genre chips on album cards ──────────────────────────────────────────── */
.card-genres {
  display: flex; gap: 2px; flex-wrap: wrap; margin-top: 2px;
  overflow: hidden; max-height: 1.4rem;
}
.card-genre {
  font-family: var(--mono); font-size: 0.48rem; padding: 0.08rem 0.3rem;
  border-radius: 2px; background: rgba(0,0,0,0.45); white-space: nowrap;
  line-height: 1.4;
}
.card-genre.depth-1 { color: var(--accent); }
.card-genre.depth-2 { color: rgba(255,255,255,0.5); }
.card-genre.depth-3 { color: rgba(255,255,255,0.3); }

/* ── Discover artist card ────────────────────────────────────────────── */
.disc-artist-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--surface2);
  min-height: 140px;
}
/* Cover image must be absolutely positioned — height:100% doesn't resolve
   correctly on flex children in WebKit when parent height comes from aspect-ratio */
.disc-artist-card .card-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.disc-artist-icon {
  width: 56px; height: 56px;
  border-radius: 50%;
  background: rgba(255,255,255,0.06);
  display: flex; align-items: center; justify-content: center;
  position: relative; z-index: 1;
}
.disc-artist-icon svg { width: 28px; height: 28px; stroke: var(--ink3); }
/* card-info at bottom like album cards; icon stays in flex flow and stays centered */
.disc-artist-card .card-info { position: absolute; bottom: 0; left: 0; right: 0; padding: 0.45rem 0.5rem 0.5rem; text-align: center; }
.disc-artist-card .card-title { font-size: 0.72rem; }

/* ── Discover song card ──────────────────────────────────────────────── */
.disc-song-card { background: var(--bg2); }
/* placeholder: ♪ icon, same look as card-placeholder but with a note */
.disc-song-ph {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
}
.disc-song-icon { font-size: 2rem; color: var(--ink3); user-select: none; }
.disc-song-card .card-album-hint { font-size: 0.58rem; color: var(--ink3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── About button in sidebar ─────────────────────────────────────────── */
.sb-about-btn {
  display: block;
  width: calc(100% - 2rem);
  margin: 1.25rem 1rem 1rem;
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  color: var(--ink3);
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: center;
  transition: color 0.15s, border-color 0.15s;
}
.sb-about-btn:hover { color: var(--accent); border-color: var(--accent); }

/* ── About modal ─────────────────────────────────────────────────────── */
#about-overlay {
  display: none;
  position: fixed; inset: 0; z-index: 600;
  background: rgba(0,0,0,0.7);
  align-items: center;
  justify-content: center;
}
#about-overlay.open { display: flex; }
#about-modal {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: 4px;
  padding: 2rem;
  max-width: 560px;
  width: calc(100% - 2rem);
  max-height: 80vh;
  overflow-y: auto;
  position: relative;
}
#about-modal h2 { font-family: var(--serif); font-size: 1.4rem; margin-bottom: 1rem; color: var(--ink); }
#about-modal h3 {
  font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--accent); margin: 1.2rem 0 0.4rem;
}
#about-modal p, #about-modal li { font-size: 0.85rem; color: var(--ink2); line-height: 1.6; }
#about-modal ul { padding-left: 1.2rem; margin-top: 0.25rem; }
#about-modal li { margin-bottom: 0.25rem; }
.about-close {
  position: absolute; top: 1rem; right: 1rem;
  background: none; border: none; color: var(--ink3);
  font-size: 1.2rem; cursor: pointer; line-height: 1;
}
.about-close:hover { color: var(--ink); }

.about-svc {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.3rem 0.7rem; border-radius: 3px; border: 1px solid;
  font-family: var(--mono); font-size: 0.7rem; text-decoration: none;
  transition: opacity 0.15s;
}
.about-svc:hover { opacity: 0.75; }
.about-svc svg { flex-shrink: 0; }
.about-svc.lfm  { color: #d51007; border-color: rgba(213,16,7,0.35); }
.about-svc.mb   { color: #ba478f; border-color: rgba(186,71,143,0.35); }
.about-svc.gh   { color: var(--ink2); border-color: var(--border2); }
.about-close {
  position: absolute; top: 1rem; right: 1rem;
  background: none; border: none; color: var(--ink3);
  font-size: 1.2rem; cursor: pointer; line-height: 1;
}

/* ── Main content area ─────────────────────────────────────────────── */
#main {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.main-inner {
  padding: 1.25rem 1.5rem 3rem;
  max-width: 1400px;
  width: 100%;
}

/* ── Responsive ────────────────────────────────────────────────────── */
@media (max-width: 800px) {
  #grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
}
@media (max-width: 600px) {
  #user-modal-bg {
    padding: 0;
    top: 52px;
    align-items: flex-end;
    overflow: hidden;
  }
  #user-modal {
    width: 100vw;
    max-width: 100vw;
    box-sizing: border-box;
    border-radius: 12px 12px 0 0;
    height: calc(100dvh - 52px);
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: env(safe-area-inset-bottom, 0.5rem);
  }
  .um-section { padding: 0.85rem 1rem 0.9rem; }
  .modal-close { top: 0.6rem; right: 0.6rem; }
  #secondary-users-list { max-height: 190px; overflow-y: auto; }
  .sec-user-btns .btn-sm { font-size: 0.58rem; padding: 0.18rem 0.32rem; }
  .um-row input { min-width: 0; }
  /* La sección de amigos ocupa el espacio restante hasta el borde inferior */
  #user-modal { display: flex; flex-direction: column; }
  #user-modal .um-section:last-child { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #user-modal .um-section:last-child #friends-list { flex: 1; max-height: none; overflow-y: auto; }
}
</style>
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

      <button onclick="startFromWelcome()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:0.85rem 1.5rem;font-family:var(--serif);font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:0.02em;transition:background 0.15s">
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
  <div class="logo" style="font-family:var(--serif);font-size:1.3rem;font-weight:800"><span style="color:var(--accent)">tumtum</span><span style="color:#fff">pa!</span></div>
  <div style="flex:1"></div>
  <div id="badge-inline" style="display:none;align-items:center;gap:0.5rem;">
    <img id="badge-avatar" src="" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;background:var(--bg3);display:none">
    <span id="badge-name" style="font-family:var(--mono);font-size:0.75rem;color:var(--accent);"></span>
  </div>
  <button id="btn-open-users" onclick="openUserModal()" title="Gestionar usuarios" style="width:34px;height:34px;border-radius:50%;background:var(--bg3);border:1px solid var(--border2);color:var(--ink2);font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:border-color .15s,color .15s">👤</button>
</header>

<input type="file" id="inp-session" accept=".json" style="display:none">

<!-- ── User modal ──────────────────────────────────────────────────────── -->
<div id="user-modal-bg">
  <div id="user-modal">
    <button class="modal-close" onclick="closeUserModal()">✕</button>

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

    <!-- Usuario principal (destacado) -->
    <div class="um-section" id="um-sec-primary" style="display:none">
      <div class="um-section-title">Usuario principal</div>
      <div class="um-primary-card">
        <img id="um-avatar" src="" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--bg3);flex-shrink:0;display:none">
        <div style="flex:1;min-width:0;overflow:hidden">
          <div class="um-user-name" id="um-username" style="color:var(--ink)"></div>
          <div class="um-user-meta" id="um-usermeta" style="font-size:0.65rem"></div>
        </div>
        <button class="btn-sm" id="btn-sync-session" title="Sincronizar">↻</button>
        <button class="btn-sm" id="btn-save-session" style="display:none" title="Guardar JSON">↓ JSON</button>
        <button class="btn-sm" id="btn-unload-primary" title="Descargar usuario">✕</button>
      </div>
    </div>

    <!-- Usuarios secundarios -->
    <div class="um-section" id="um-sec-secondary">
      <div class="um-section-title">Usuarios secundarios</div>
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
<div id="about-overlay" onclick="if(event.target===this)closeAboutModal()">
  <div id="about-modal">
    <button class="about-close" onclick="closeAboutModal()">✕</button>
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
        <p id="empty-tagline">Descubre qué escuchan tus amigos que a ti te falta.</p>
        <div id="empty-steps">
          <div class="empty-step"><span class="empty-num">01</span><span>Pulsa <b>👤</b> arriba a la derecha y carga tu usuario de <b>Last.fm</b>.</span></div>
          <div class="empty-step"><span class="empty-num">02</span><span>Añade <b>usuarios secundarios</b> — amigos, artistas, críticos.</span></div>
          <div class="empty-step"><span class="empty-num">03</span><span>Pulsa <b>▶</b> junto a un usuario para ver qué escucha que tú no has oído.</span></div>
        </div>
        <div id="empty-hint">Los datos se guardan en tu navegador (IndexedDB). Exporta / importa sesiones como JSON.</div>
      </div>

      <!-- Discover view -->
      <div id="discover-view">
        <!-- Controles: selector de usuario, modo y límite -->
        <div id="discover-ctrl-bar">
          <div id="disc-user-indicator"></div>
          <div class="disc-controls">
            <input type="number" id="disc-limit-global" min="5" max="100" value="20">
            <select id="disc-mode-select">
              <option value="albums">Álbumes</option>
              <option value="artists">Artistas</option>
              <option value="songs">Canciones</option>
            </select>
            <button id="disc-play-btn" onclick="triggerDiscover()" title="Descubrir">▶</button>
          </div>
        </div>
        <div class="discover-filters" id="discover-decade-pills"></div>
        <div id="discover-grid"></div>
        <div class="discover-pagination" id="discover-pagination" style="display:none">
          <button class="btn-sm" id="disc-prev" onclick="discoverPrevPage()">← Anteriores</button>
          <span id="disc-page-info" style="font-family:var(--mono);font-size:0.72rem;color:var(--ink3)"></span>
          <button class="btn-sm" id="disc-next" onclick="discoverNextPage()">Siguientes →</button>
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
  <button class="dp-close" onclick="closeDetailPanel()">✕</button>
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

<script>
// ── IndexedDB constants (must be before any async init that uses them) ──────
const IDB_NAME  = 'mustlisten';
const IDB_STORE = 'sessions';

// ── State ──────────────────────────────────────────────────────────────────
let heardCache   = null;   // { user, pairs:[[a,t],...], count, fetched_at }
let loadedUser   = null;

// extra users for cross-reference / recommendation
const USER_COLORS = ['#6a9fb5','#78b56c','#b56c6c','#9b6cb5','#b59b6c','#6cb5b5','#b56ca0','#7ab5a0'];
let extraUsers = [];  // [{user, pairs:[[na,nt,oa,ot,count],...], color, count, fetched_at}]

// discover state
let discoverMode          = false;
let discoverAllCandidates = [];
let discoverCandidates    = [];
let discoverAlbums        = [];
let discoverOffset        = 0;
let discoverSearching     = false;
let discoverEs            = null;
let discoverDecadeFilter  = new Set();
let discoverPage          = 0;
let discoverLimit         = 20;
let discoverModeType      = 'albums';
let discoverUserIdx       = 0;
let activeDiscoverUserIdx = 0;

// album info cache (artist|||title → data)
const albumInfoCache = new Map();

// ── DOM refs ───────────────────────────────────────────────────────────────
const inpUser    = document.getElementById('inp-user');
const btnGo      = document.getElementById('btn-go');
const loading    = document.getElementById('loading');
const loadTxt    = document.getElementById('loading-text');
const errMsg     = document.getElementById('error-msg');
const inpSession = document.getElementById('inp-session');

// ── Sidebar panel toggle ───────────────────────────────────────────────────
function closeSidebar() {} // no-op (sidebar eliminado)

// ── About modal ───────────────────────────────────────────────────────────
function openAboutModal() {
  document.getElementById('about-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeAboutModal() {
  document.getElementById('about-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('about-overlay').classList.contains('open'))
    closeAboutModal();
});

// ── User modal open/close ──────────────────────────────────────────────────
function openUserModal() {
  document.getElementById('user-modal-bg').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderSecondaryUsers();
}
function closeUserModal() {
  document.getElementById('user-modal-bg').classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('user-modal-bg').addEventListener('click', e => {
  if (e.target === document.getElementById('user-modal-bg')) closeUserModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('user-modal-bg').classList.contains('open')) closeUserModal();
  }
});

// ── Extra users (recommendation) ──────────────────────────────────────────
function saveExtraUsersLS() {
  localStorage.setItem('ml_extra_users', JSON.stringify(
    extraUsers.map(u => ({ user: u.user, pairs: u.pairs, color: u.color, count: u.count, fetched_at: u.fetched_at, image: u.image || '', source: u.source || 'lfm' }))
  ));
}

function loadExtraUsersLS() {
  try {
    const saved = JSON.parse(localStorage.getItem('ml_extra_users') || '[]');
    for (const u of saved) {
      if (u.user && u.pairs) extraUsers.push({ ...u, image: u.image || '' });
    }
  } catch(e) {}
}

function buildExtraUsersList() {
  const hasExtra = extraUsers.length > 0;
  const ctrlBar = document.getElementById('discover-ctrl-bar');
  if (ctrlBar) ctrlBar.style.display = hasExtra ? '' : 'none';
  if (hasExtra) {
    if (activeDiscoverUserIdx >= extraUsers.length) activeDiscoverUserIdx = 0;
    _updateDiscoverIndicator();
  }
  renderSecondaryUsers();
}

function selectDiscoverUser(i) { setActiveDiscoverUser(i); }

function setActiveDiscoverUser(i) {
  activeDiscoverUserIdx = i;
  // Highlight in secondary-bar
  document.querySelectorAll('.sbar-user').forEach((el, j) =>
    el.classList.toggle('active', j === i));
  _updateDiscoverIndicator();
}

function _updateDiscoverIndicator() {
  const el = document.getElementById('disc-user-indicator');
  if (!el) return;
  if (!extraUsers.length) { el.innerHTML = ''; return; }
  el.innerHTML = extraUsers.map((uu, i) =>
    `<div class="disc-user-line${i===activeDiscoverUserIdx?' active':''}" onclick="setActiveDiscoverUser(${i})">
      ${uu.image
        ? `<img src="${escH(uu.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<span style="width:8px;height:8px;border-radius:50%;background:${uu.color};display:inline-block;flex-shrink:0"></span>`}
      <span class="disc-user-line-name">${escH(uu.user)}</span>
    </div>`
  ).join('');
}

async function triggerDiscover() {
  if (!extraUsers.length) return;
  const mode = document.getElementById('disc-mode-select')?.value || 'albums';
  const limit = Math.min(100, Math.max(1,
    parseInt(document.getElementById('disc-limit-global')?.value || '20')
  ));
  // Songs data is too large for localStorage — load from IDB on demand
  if (mode === 'songs') {
    const u = extraUsers[activeDiscoverUserIdx];
    if (u && u.songs === undefined) {
      const data = await idbLoad(u.user).catch(() => null);
      if (data) u.songs = data.songs || [];
    }
  }
  enterDiscoverMode(activeDiscoverUserIdx, limit, mode);
}

function saveExtraUserJSON(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const blob = new Blob([JSON.stringify({ version:1, user: u.user, count: u.count, fetched_at: u.fetched_at, heard: u.pairs, songs: u.songs || [] }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${u.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}


async function addExtraUser() {
  const inp = document.getElementById('inp-extra-user');
  const prog = document.getElementById('um-extra-progress');
  const user = inp.value.trim();
  if (!user) return;
  if (extraUsers.some(u => u.user.toLowerCase() === user.toLowerCase())) {
    inp.value = ''; return;
  }
  const btn = document.getElementById('btn-extra-lfm');
  btn.disabled = true; inp.disabled = true;
  const src = umSource();
  prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(checkUserEndpoint(user, src)).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(user, msg => {
        if (msg._waiting) prog.textContent = `⏳ Límite Last.fm — esperando ${msg.waiting}s… (pág ${msg.page}/${msg.total_pages})`;
        else prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }, src),
    ]);
    const heard     = lfmResult.heard;
    const songs     = lfmResult.heard_songs || [];
    const color     = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image     = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser  = userInfo?.ok ? userInfo.username : user;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, songs, color, count: heard.length, fetched_at, image, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, songs, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track, complete: true, total_pages: lfmResult.total_pages || 0, heard_artists: lfmResult.heard_artists || [] });
    await renderIdbExtraList();
    buildExtraUsersList();
    inp.value = '';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes, ${songs.length.toLocaleString()} canciones`;
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; inp.disabled = false;
  }
}

async function syncExtraUser(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const prog = document.getElementById('um-extra-progress');
  prog.textContent = `Sincronizando ${u.user}...`;
  try {
    const url = sinceEndpoint(u.user, u.fetched_at || 0, u.source || 'lfm');
    const r = await fetch(url);
    if (!r.ok) { const t = await r.text(); throw new Error(`Error ${r.status}: ${t.slice(0, 120)}`); }
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // merge: add only pairs not already present
    const existing = new Set(u.pairs.map(p => p[0] + '|' + p[1]));
    const added = data.new_pairs.filter(p => !existing.has(p[0] + '|' + p[1]));
    extraUsers[idx].pairs      = [...u.pairs, ...added];
    extraUsers[idx].count      = extraUsers[idx].pairs.length;
    extraUsers[idx].fetched_at = data.fetched_at;
    // Merge new songs
    if (data.new_songs?.length) {
      const existSongs = new Set((extraUsers[idx].songs || []).map(s => s[0] + '|' + s[1]));
      const addedSongs = data.new_songs.filter(s => !existSongs.has(s[0] + '|' + s[1]));
      extraUsers[idx].songs = [...(extraUsers[idx].songs || []), ...addedSongs];
    }
    // Update last scrobble info if sync returned newer data
    if (data.last_scrobble_ts && data.last_scrobble_ts > (extraUsers[idx].last_scrobble_ts || 0)) {
      extraUsers[idx].last_scrobble_ts     = data.last_scrobble_ts;
      extraUsers[idx].last_scrobble_artist = data.last_scrobble_artist || '';
      extraUsers[idx].last_scrobble_track  = data.last_scrobble_track  || '';
    }
    saveExtraUsersLS();
    await idbSave({ user: extraUsers[idx].user, count: extraUsers[idx].count, fetched_at: extraUsers[idx].fetched_at, heard: extraUsers[idx].pairs, songs: extraUsers[idx].songs || [], last_scrobble_ts: extraUsers[idx].last_scrobble_ts || 0, last_scrobble_artist: extraUsers[idx].last_scrobble_artist || '', last_scrobble_track: extraUsers[idx].last_scrobble_track || '' });
    await renderIdbExtraList();
    buildExtraUsersList();
    prog.textContent = `✓ ${u.user}: +${added.length} nuevos (total ${extraUsers[idx].count.toLocaleString()})`;
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  }
}

// (inp-extra-user / btn-extra-lfm removed — search box now handles both primary and secondary)

// ── Friends loader ─────────────────────────────────────────────────────────
document.getElementById('btn-load-friends').addEventListener('click', loadFriends);

async function loadFriends() {
  const listEl = document.getElementById('friends-list');
  const btn    = document.getElementById('btn-load-friends');
  const user   = heardCache?.user || document.getElementById('inp-user').value.trim();
  if (!user) {
    listEl.innerHTML = '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Carga primero el usuario principal.</div>';
    return;
  }
  btn.disabled = true;
  listEl.innerHTML = '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Cargando amigos…</div>';
  try {
    const data = await fetch(`/api/friends?user=${encodeURIComponent(user)}`).then(r => r.json());
    if (!data.ok || !data.friends.length) {
      listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">${escH(data.error || 'Este usuario no tiene amigos en Last.fm.')}</div>`;
      return;
    }
    renderFriendsList(data.friends);
  } catch(e) {
    listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Error: ${escH(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderFriendsList(friends) {
  const listEl = document.getElementById('friends-list');
  const alreadyAdded = new Set(extraUsers.map(u => u.user.toLowerCase()));
  listEl.innerHTML = friends.map(f => {
    const added = alreadyAdded.has(f.username.toLowerCase());
    const avatar = f.image
      ? `<img class="fr-avatar" src="${escH(f.image)}" alt="" onerror="this.style.display='none'">`
      : `<span class="fr-avatar" style="background:var(--bg3);display:inline-block"></span>`;
    return `<div class="fr-row" id="fr-row-${escH(f.username.toLowerCase().replace(/[^a-z0-9]/g,''))}">
      ${avatar}
      <span class="fr-name">${escH(f.username)}</span>
      <button class="btn-sm fr-add" ${added ? 'disabled' : ''} onclick="addExtraUserByName('${escH(f.username)}', this)">
        ${added ? '✓' : 'Añadir'}
      </button>
    </div>`;
  }).join('');
}

async function addExtraUserByName(username, btn) {
  if (!username) return;
  if (extraUsers.some(u => u.user.toLowerCase() === username.toLowerCase())) return;
  const prog = document.getElementById('um-extra-progress');
  btn.disabled = true;
  btn.textContent = '…';
  prog.textContent = `Cargando ${username}…`;
  const src = umSource();
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(checkUserEndpoint(username, src)).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(username, msg => {
        if (msg._waiting) prog.textContent = `⏳ Límite Last.fm — esperando ${msg.waiting}s… (pág ${msg.page}/${msg.total_pages})`;
        else prog.textContent = `${username}: página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }, src),
    ]);
    const heard      = lfmResult.heard;
    const songs      = lfmResult.heard_songs || [];
    const color      = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image      = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser   = userInfo?.ok ? userInfo.username : username;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, songs, color, count: heard.length, fetched_at, image, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, songs, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    await renderIdbExtraList();
    buildExtraUsersList();
    btn.textContent = '✓';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes, ${songs.length.toLocaleString()} canciones`;
    // Refresh friends list so the newly added user shows as already added
    const frList = document.getElementById('friends-list');
    if (frList?.children.length) {
      frList.querySelectorAll('.fr-add').forEach(b => {
        const row = b.closest('.fr-row');
        const name = row?.querySelector('.fr-name')?.textContent?.trim() || '';
        if (extraUsers.some(eu => eu.user.toLowerCase() === name.toLowerCase())) {
          b.disabled = true;
          b.textContent = '✓';
        }
      });
    }
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Añadir';
    prog.textContent = 'Error: ' + e.message;
  }
}

// inp-extra-json is still in DOM (appended after modal), handle it for back-compat
document.getElementById('inp-extra-json').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById('um-extra-progress');
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error('Formato inválido');
    if (extraUsers.some(u => u.user.toLowerCase() === data.user.toLowerCase())) {
      prog.textContent = `${data.user} ya está en la lista.`; return;
    }
    const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const ft = data.fetched_at || 0;
    const importedSongs = data.songs || [];
    extraUsers.push({ user: data.user, pairs: data.heard, songs: importedSongs, color, count: data.heard.length, fetched_at: ft, image: '' });
    saveExtraUsersLS();
    await idbSave({ user: data.user, count: data.heard.length, fetched_at: ft, heard: data.heard, songs: importedSongs });
    buildExtraUsersList();
    prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
  } catch(err) {
    prog.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
});

function removeExtraUser(idx) {
  extraUsers.splice(idx, 1);
  saveExtraUsersLS();
  buildExtraUsersList();
}

// Legacy alias kept for call sites that haven't been updated yet
async function renderIdbExtraList() { return renderSecondaryUsers(); }

async function idbAddAsExtra(username) {
  const data = await idbLoad(username);
  if (!data) return;
  if (extraUsers.some(u => u.user.toLowerCase() === username.toLowerCase())) return;
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  // try to get avatar
  const userInfo = await fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null);
  const image = userInfo?.ok ? (userInfo.image || '') : '';
  extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: data.fetched_at || 0, image });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderIdbExtraList();
  document.getElementById('um-extra-progress').textContent = `✓ ${data.user} añadido`;
}

/// ── Source helpers ────────────────────────────────────────────────────────
function umSource() {
  return document.getElementById('um-src-lb')?.checked ? 'lb' : 'lfm';
}
function sbSource() { return umSource(); } // sidebar eliminado, usar modal
function scrobblesEndpoint(user, source) {
  const base = source === 'lb' ? '/api/scrobbles/lb' : '/api/scrobbles';
  return `${base}?user=${encodeURIComponent(user)}`;
}
function sinceEndpoint(user, since, source) {
  const base = source === 'lb' ? '/api/scrobbles/lb/since' : '/api/scrobbles/since';
  return `${base}?user=${encodeURIComponent(user)}&since=${since}`;
}
function checkUserEndpoint(user, source) {
  const suffix = source === 'lb' ? '&source=lb' : '';
  return `/api/check_user?user=${encodeURIComponent(user)}${suffix}`;
}

// Sync placeholder text and .checked label class when source radio changes
function _syncSourceGroup(groupName, inputId, labels) {
  // labels: [{radioId, placeholder}]
  const radios = labels.map(l => document.getElementById(l.radioId));
  const inp    = document.getElementById(inputId);
  function update() {
    radios.forEach((r, i) => {
      if (!r) return;
      r.closest('label')?.classList.toggle('checked', r.checked);
      if (inp && r.checked) inp.placeholder = labels[i].placeholder;
    });
  }
  radios.forEach(r => r?.addEventListener('change', update));
  update(); // set initial state
}
document.addEventListener('DOMContentLoaded', () => {
  _syncSourceGroup('um-source', 'inp-user', [
    { radioId: 'um-src-lfm', placeholder: 'Usuario Last.fm' },
    { radioId: 'um-src-lb',  placeholder: 'Usuario ListenBrainz' },
  ]);
  // sb-source (sidebar eliminado) — no sync needed
});

// ── Helper: consume /api/scrobbles SSE stream ─────────────────────────────
async function fetchScrobblesSSE(user, onProgress, source = 'lfm') {
  const response = await fetch(scrobblesEndpoint(user, source));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader   = response.body.getReader();
  const decoder  = new TextDecoder();
  let buffer = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const msg = JSON.parse(part.slice(6));
      if (msg.error) throw new Error(msg.error);
      if (msg.done) result = msg;
      else if (msg.waiting) onProgress({ ...msg, _waiting: true });
      else onProgress(msg);
    }
  }
  if (!result) throw new Error('No se recibió respuesta del servidor');
  return result; // {heard, last_scrobble_ts, last_scrobble_artist, last_scrobble_track, ...}
}

// (duplicate init block removed — single init at bottom of script)

// (toggleUmExtra removed — secondary section is now always visible in modal)

// ── Discover mode ─────────────────────────────────────────────────────────
function discoverCardHTML(a, i) {
  if (a.type === 'song') {
    const userBadges = (a.users || []).map(u =>
      u.image
        ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
        : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
    ).join('');
    const cover = a.cover_url
      ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt=""
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    return `<div class="card rec-card disc-song-card" data-disc="${i}" style="cursor:pointer">
      ${cover}
      <div class="disc-song-ph"${a.cover_url ? ' style="display:none"' : ''}>
        <div class="disc-song-icon">♪</div>
      </div>
      <div class="card-overlay"></div>
      <div class="card-info">
        <div class="card-title">${escH(a.orig_t)}</div>
        <div class="card-artist">${escH(a.orig_a)}</div>
        ${a.orig_album ? `<div class="card-album-hint">${escH(a.orig_album)}</div>` : ''}
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  if (a.type === 'artist') {
    const userBadges = (a.users || []).map(u =>
      u.image
        ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
        : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
    ).join('');
    const coverEl = a.cover_url
      ? `<img class="card-cover disc-artist-img" src="${escH(a.cover_url)}" alt="">`
      : `<img class="card-cover disc-artist-img" src="data:," alt="" style="display:none">
         <div class="disc-artist-icon">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
             <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
           </svg>
         </div>`;
    return `<div class="card rec-card disc-artist-card" data-disc="${i}" style="cursor:pointer">
      ${coverEl}
      <div class="card-overlay"></div>
      <div class="card-info">
        <div class="card-title">${escH(a.orig_a)}</div>
        <div class="card-artist" style="opacity:0.6">${a.album_count} álbum${a.album_count !== 1 ? 'es' : ''}</div>
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  const cover = a.cover_url
    ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt=""
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const ph = `<div class="card-placeholder" ${a.cover_url ? 'style="display:none"' : ''}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg></div>`;
  const userBadges = (a.users || []).map(u =>
    u.image
      ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
      : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
  ).join('');
  return `<div class="card rec-card" data-disc="${i}" style="cursor:pointer">
    ${cover}${ph}
    <div class="card-overlay"></div>
    <div class="card-info">
      <div class="card-title">${escH(a.mb_title || a.orig_t)}</div>
      <div class="card-artist">${escH(a.mb_artist || a.orig_a)}</div>
      ${a.date ? `<div class="card-year">${escH(a.date.slice(0,4))}</div>` : ''}
      <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
    </div>
  </div>`;
}

function renderDiscoverGrid() {
  const dg = document.getElementById('discover-grid');
  let filtered = discoverAlbums;
  if (discoverDecadeFilter.size) {
    filtered = filtered.filter(a => {
      const yr = parseInt((a.date || '').slice(0,4));
      if (!yr) return false;
      return discoverDecadeFilter.has(Math.floor(yr / 10) * 10);
    });
  }
  dg.innerHTML = filtered.map((a, i) => discoverCardHTML(a, discoverAlbums.indexOf(a))).join('');
  dg.querySelectorAll('.card[data-disc]').forEach(c => {
    c.addEventListener('click', () => {
      const idx = parseInt(c.dataset.disc);
      const entry = discoverAlbums[idx];
      if (entry?.type === 'artist') {
        openDetailPanel({ type: 'discover_artist', idx });
      } else if (entry?.type === 'song') {
        openDetailPanel({ type: 'discover_song', idx });
      } else {
        openDetailPanel({ type: 'discover', idx });
      }
    });
  });
  // Update count label (element may not exist if removed from template)
  const noun = discoverModeType === 'songs' ? 'canciones' : discoverModeType === 'artists' ? 'artistas' : 'álbumes';
  const _countEl = document.getElementById('discover-count');
  if (_countEl) _countEl.textContent =
    `${filtered.length} ${noun}${discoverCandidates.length > discoverAlbums.length ? ` de ${discoverCandidates.length} candidatos` : ''}`;
  // Decade pills
  const decades = new Set();
  discoverAlbums.forEach(a => {
    const yr = parseInt((a.date || '').slice(0,4));
    if (yr) decades.add(Math.floor(yr / 10) * 10);
  });
  const pillsEl = document.getElementById('discover-decade-pills');
  pillsEl.innerHTML = [...decades].sort().map(d =>
    `<button class="filter-pill${discoverDecadeFilter.has(d) ? ' active' : ''}" data-decade="${d}">${d}s</button>`
  ).join('');
  pillsEl.querySelectorAll('.filter-pill').forEach(b => {
    b.addEventListener('click', () => {
      const d = parseInt(b.dataset.decade);
      if (discoverDecadeFilter.has(d)) discoverDecadeFilter.delete(d);
      else discoverDecadeFilter.add(d);
      renderDiscoverGrid();
    });
  });
}

function enterDiscoverMode(userIdx, limit = 20, mode = 'albums') {
  if (!extraUsers.length) return;
  const u = extraUsers[userIdx];
  if (!u) return;
  limit = Math.min(100, Math.max(1, limit));

  discoverMode     = true;
  discoverPage     = 0;
  discoverLimit    = limit;
  discoverModeType = mode;
  discoverUserIdx  = userIdx;
  discoverAllCandidates = [];
  discoverDecadeFilter.clear();
  if (discoverEs) { discoverEs.close(); discoverEs = null; }

  const primaryPairs = heardCache ? new Set(heardCache.pairs.map(p => p[0] + '|' + p[1])) : new Set();

  if (mode === 'artists') {
    // ── Artists mode: exclude artists heard by primary (uses full artist set if available) ──
    const primaryArtists = heardCache
      ? (heardCache.artist_set || new Set(heardCache.pairs.map(p => p[0])))
      : new Set();
    const amap = {};
    for (const p of u.pairs) {
      const normA = p[0];
      if (primaryArtists.has(normA)) continue;
      const origA = p[2] || p[0];
      if (!amap[normA]) amap[normA] = { norm_a: normA, orig_a: origA, orig_t: '', total: 0, album_count: 0, users: [], type: 'artist' };
      const count = p[4] || 1;
      amap[normA].total += count;
      amap[normA].album_count++;
      if (!amap[normA].users.length)
        amap[normA].users.push({ user: u.user, count: 0, color: u.color, image: u.image || '' });
      amap[normA].users[0].count += count;
    }
    discoverAllCandidates = Object.values(amap).sort((a, b) => b.total - a.total);
  } else if (mode === 'songs') {
    // ── Songs mode: exclude songs heard by primary ───────────────────────────
    const primarySongs = heardCache
      ? (heardCache.song_set || new Set((heardCache.songs || []).map(s => s[0] + '|' + s[1])))
      : new Set();
    const smap = {};
    for (const s of (u.songs || [])) {
      // s = [norm_a, norm_track, orig_a, orig_album, orig_track, count]
      const key = s[0] + '|' + s[1];
      if (primarySongs.has(key)) continue;
      if (!smap[key]) smap[key] = {
        norm_a: s[0], norm_t: s[1],
        orig_a: s[2] || s[0], orig_album: s[3] || '',
        orig_t: s[4] || s[1],
        total: 0, users: [], type: 'song',
      };
      const count = s[5] || 1;
      smap[key].total += count;
      smap[key].users.push({ user: u.user, count, color: u.color, image: u.image || '' });
    }
    discoverAllCandidates = Object.values(smap).sort((a, b) => b.total - a.total);
  } else {
    // ── Albums mode (default) ────────────────────────────────────────────────
    const cmap = {};
    for (const p of u.pairs) {
      const key = p[0] + '|' + p[1];
      if (primaryPairs.has(key)) continue;
      if (!cmap[key]) cmap[key] = {
        norm_a: p[0], norm_t: p[1],
        orig_a: p[2] || p[0], orig_t: p[3] || p[1],
        total: 0, users: [],
      };
      const count = p[4] || 1;
      cmap[key].total += count;
      cmap[key].users.push({ user: u.user, count, color: u.color, image: u.image || '' });
    }
    discoverAllCandidates = Object.values(cmap).sort((a, b) => b.total - a.total);
  }

  // Show discover view
  document.getElementById('discover-view').classList.add('visible');
  const _es = document.getElementById('empty-state'); if (_es) _es.style.display = 'none';
  closeSidebar();

  _loadDiscoverPage();
}

function _enrichSongCovers() {
  // Collect unique (orig_a, orig_album) pairs that still need covers, keyed by "a|||album"
  const needed = {};  // "a|||album" -> [idx, ...]
  discoverAlbums.forEach((a, i) => {
    if (a.type !== 'song' || a.cover_url || !a.orig_album) return;
    const k = (a.orig_a || '') + '|||' + (a.orig_album || '');
    if (!needed[k]) needed[k] = { orig_a: a.orig_a, orig_album: a.orig_album, idxs: [] };
    needed[k].idxs.push(i);
  });
  const pairs = Object.values(needed);
  if (!pairs.length) return;

  // Use api_enrich_albums SSE to fetch missing covers
  const url = '/api/enrich_albums?albums=' + encodeURIComponent(JSON.stringify(
    pairs.map(p => [p.orig_a, p.orig_album])
  ));
  const es = new EventSource(url);
  es.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.done || msg.error) { es.close(); return; }
    if (!msg.artist || !msg.album || !msg.cover_url) return;
    const k = msg.artist + '|||' + msg.album;
    enrichCacheSet(msg.artist, msg.album, { cover_url: msg.cover_url, mbid: msg.mbid || '' });
    const entry = needed[k];
    if (!entry) return;
    entry.idxs.forEach(idx => {
      if (!discoverAlbums[idx]) return;
      discoverAlbums[idx].cover_url = msg.cover_url;
      // Patch the card in the DOM
      const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
      if (!card) return;
      let img = card.querySelector('.card-cover');
      const ph = card.querySelector('.disc-song-ph');
      if (!img) {
        img = document.createElement('img');
        img.className = 'card-cover';
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = function() {
          this.style.display = 'none';
          if (ph) ph.style.display = 'flex';
        };
        card.insertBefore(img, card.firstChild);
      }
      if (ph) ph.style.display = 'none';
      img.style.display = '';
      img.src = msg.cover_url;
    });
  };
  es.onerror = () => es.close();
}

function _loadDiscoverPage() {
  discoverAlbums  = [];
  discoverOffset  = 0;
  discoverSearching = false;
  discoverDecadeFilter.clear();
  if (discoverEs) { discoverEs.close(); discoverEs = null; }

  discoverCandidates = discoverAllCandidates.slice(
    discoverPage * discoverLimit,
    (discoverPage + 1) * discoverLimit
  );

  _updateDiscoverPagination();

  const u = extraUsers[discoverUserIdx];
  const uName = u ? escH(u.user) : '?';

  if (!discoverCandidates.length) {
    document.getElementById('discover-progress').textContent = 'Sin candidatos para este usuario';
    document.getElementById('discover-footer').style.display = '';
    renderDiscoverGrid();
    return;
  }

  if (discoverModeType === 'artists') {
    discoverAlbums = discoverCandidates.map(c => ({
      ...c, mb_artist: c.orig_a, mb_title: '', cover_url: '', date: '', mbid: '',
    }));
    renderDiscoverGrid();
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `${discoverAlbums.length} artistas de ${uName} (pág. ${discoverPage + 1})`;
    // Load artist images: try Last.fm first, fall back to album cover from enrichment cache
    discoverAlbums.forEach((a, i) => {
      const hit = enrichCacheGet(a.orig_a, '');
      if (hit?.cover_url) {
        _applyArtistCover(i, hit.cover_url);
        return;
      }
      // Fallback: look for any album cover from this artist in enrichment cache
      const u2 = extraUsers[discoverUserIdx];
      if (u2) {
        for (const p of u2.pairs) {
          if (p[0] === a.norm_a) {
            const albumHit = enrichCacheGet(p[2] || p[0], p[3] || p[1]);
            if (albumHit?.cover_url) {
              enrichCacheSet(a.orig_a, '', { cover_url: albumHit.cover_url });
              _applyArtistCover(i, albumHit.cover_url);
              return;
            }
          }
        }
      }
      fetch(`/api/artist_info?artist=${encodeURIComponent(a.orig_a)}`)
        .then(r => r.json())
        .then(info => {
          const imgUrl = info?.image || '';
          if (!imgUrl) return;
          discoverAlbums[i].cover_url = imgUrl;
          enrichCacheSet(a.orig_a, '', { cover_url: imgUrl });
          _applyArtistCover(i, imgUrl);
        }).catch(() => {});
    });
  } else if (discoverModeType === 'songs') {
    discoverAlbums = discoverCandidates.map(c => {
      const entry = { ...c };
      // Pre-fill cover from enrichment cache if we have an album name
      if (!entry.cover_url && entry.orig_album) {
        const hit = enrichCacheGet(entry.orig_a, entry.orig_album);
        if (hit?.cover_url) entry.cover_url = hit.cover_url;
      }
      return entry;
    });
    renderDiscoverGrid();
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `${discoverAlbums.length} canciones de ${uName} (pág. ${discoverPage + 1})`;
    _enrichSongCovers();
  } else {
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `Buscando ${discoverCandidates.length} álbumes de ${uName}…`;
    loadMoreDiscover();
  }
}

function _updateDiscoverPagination() {
  const total   = discoverAllCandidates.length;
  const maxPage = Math.ceil(total / discoverLimit) - 1;
  const pag  = document.getElementById('discover-pagination');
  pag.style.display = total > discoverLimit ? '' : 'none';
  document.getElementById('disc-prev').disabled = discoverPage <= 0;
  document.getElementById('disc-next').disabled = discoverPage >= maxPage;
  const from = discoverPage * discoverLimit + 1;
  const to   = Math.min((discoverPage + 1) * discoverLimit, total);
  document.getElementById('disc-page-info').textContent = `${from}–${to} de ${total}`;
}

function discoverPrevPage() {
  if (discoverPage <= 0 || discoverSearching) return;
  discoverPage--;
  _loadDiscoverPage();
}

function discoverNextPage() {
  const maxPage = Math.ceil(discoverAllCandidates.length / discoverLimit) - 1;
  if (discoverPage >= maxPage || discoverSearching) return;
  discoverPage++;
  _loadDiscoverPage();
}

function leaveDiscoverMode() {
  discoverMode = false;
  if (discoverEs) { discoverEs.close(); discoverEs = null; }
  document.getElementById('discover-view').classList.remove('visible');
  const _es2 = document.getElementById('empty-state'); if (_es2) _es2.style.display = '';
}

function loadMoreDiscover() {
  if (discoverSearching) return;
  // Load all remaining candidates (limit was chosen at entry)
  const batch = discoverCandidates.slice(discoverOffset);
  if (!batch.length) {
    document.getElementById('discover-progress').textContent = '✓ No hay más candidatos';
    return;
  }

  discoverSearching = true;
  const prog = document.getElementById('discover-progress');
  document.getElementById('discover-footer').style.display = '';

  // Build placeholders, separating cached vs uncached items
  const startIdx   = discoverAlbums.length;
  const uncachedJs = [];  // batch indices that need SSE enrichment

  batch.forEach((c, j) => {
    const hit = enrichCacheGet(c.orig_a, c.orig_t);
    discoverAlbums.push({
      ...c,
      mbid:      hit?.mbid      || '',
      cover_url: hit?.cover_url || '',
      mb_title:  hit?.mb_title  || c.orig_t,
      mb_artist: hit?.mb_artist || c.orig_a,
      date:      hit?.date      || '',
    });
    if (!hit) uncachedJs.push(j);
  });
  renderDiscoverGrid();

  // If everything was cached, no SSE needed
  if (!uncachedJs.length) {
    discoverOffset  += batch.length;
    discoverSearching = false;
    prog.textContent  = `✓ ${discoverAlbums.length} álbumes`;
    return;
  }

  prog.textContent = `Consultando… (0 / ${uncachedJs.length})`;

  if (discoverEs) { discoverEs.close(); discoverEs = null; }
  const sseBatch    = uncachedJs.map(j => [batch[j].orig_a, batch[j].orig_t]);
  const albumsParam = encodeURIComponent(JSON.stringify(sseBatch));
  discoverEs = new EventSource(`/api/enrich_albums?albums=${albumsParam}`);

  discoverEs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.done) {
      discoverEs.close(); discoverEs = null;
      discoverOffset  += batch.length;
      discoverSearching = false;
      prog.textContent  = `✓ ${discoverAlbums.length} álbumes encontrados`;
      return;
    }
    if (typeof msg.i === 'number') {
      const aIdx = startIdx + uncachedJs[msg.i];  // map SSE index → discoverAlbums index
      if (!discoverAlbums[aIdx]) return;
      const cover_url = msg.cover_url || (msg.mbid ? `/api/cover?mbid=${encodeURIComponent(msg.mbid)}` : '');
      const enriched  = {
        mbid:      msg.mbid      || '',
        cover_url,
        mb_title:  msg.mb_title  || discoverAlbums[aIdx].orig_t,
        mb_artist: msg.mb_artist || discoverAlbums[aIdx].orig_a,
        date:      msg.date      || '',
      };
      Object.assign(discoverAlbums[aIdx], enriched);
      enrichCacheSet(discoverAlbums[aIdx].orig_a, discoverAlbums[aIdx].orig_t, enriched);
      _patchDiscoverCard(aIdx, discoverAlbums[aIdx]);
    }
    prog.textContent = `Buscando… (${msg.i + 1} / ${uncachedJs.length})`;
  };

  discoverEs.onerror = () => {
    discoverEs.close(); discoverEs = null;
    discoverOffset  += batch.length;
    discoverSearching = false;
    prog.textContent  = `✓ ${discoverAlbums.length} álbumes encontrados`;
  };
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
  });
});

// ── Enrich cache ─────────────────────────────────────────────────────────
// Key: "artist|||title" (title='' for artist-mode entries)
// Value: {cover_url, mbid?, mb_title?, mb_artist?, date?}
const ENRICH_CACHE_KEY = 'enrich_cache_v1';
function enrichCacheGet(artist, title) {
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    return c[artist + '|||' + title] || null;
  } catch(e) { return null; }
}
function enrichCacheSet(artist, title, data) {
  if (!data?.cover_url) return;
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    c[artist + '|||' + title] = data;
    localStorage.setItem(ENRICH_CACHE_KEY, JSON.stringify(c));
  } catch(e) {}
}

// ── YouTube cache & embed ─────────────────────────────────────────────────
const YT_CACHE_KEY = 'yt_ids_v1';
function ytCacheGet(artist, album) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    const v = c[artist + '|||' + album];
    return v !== undefined ? v : null;
  } catch(e) { return null; }
}
function ytCacheSet(artist, album, videoId) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    c[artist + '|||' + album] = videoId;
    localStorage.setItem(YT_CACHE_KEY, JSON.stringify(c));
  } catch(e) {}
}
function embedYT(videoId) {
  const ytDiv = document.getElementById('dp-yt');
  if (!videoId) { ytDiv.style.display = 'none'; ytDiv.innerHTML = ''; return; }
  ytDiv.style.display = '';
  ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(videoId)}?rel=0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen></iframe>`;
  // Swap "Buscar YouTube" search link → direct watch link
  const linksEl = document.getElementById('dp-links');
  const searchA = linksEl.querySelector('a[href*="results?search_query"]');
  if (searchA) {
    searchA.href = `https://www.youtube.com/watch?v=${escH(videoId)}`;
    searchA.textContent = 'YouTube ↗';
  } else if (!linksEl.querySelector('a[href*="watch?v="]')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="https://www.youtube.com/watch?v=${escH(videoId)}" target="_blank">YouTube ↗</a>`);
  }
}
async function fetchAndEmbedYT(artist, album) {
  if (!artist || !album) return;
  const cached = ytCacheGet(artist, album);
  if (cached !== null) { embedYT(cached); return; }
  try {
    const r = await fetch(`/api/yt_search?${new URLSearchParams({ artist, album })}`);
    if (!r.ok) return;
    const data = await r.json();
    if (typeof data.videoId === 'string') {
      ytCacheSet(artist, album, data.videoId);
      embedYT(data.videoId);
    }
  } catch(e) {}
}

// ── Modal ──────────────────────────────────────────────────────────────────
// ── Detail side panel ──────────────────────────────────────────────────────
function openDetailPanel(ref) {
  // ref: {type:'discover'|'discover_artist'|'discover_song', idx}
  let title, artist, year, cover, mbid, yt_id, heard, extraHeard, descCached;
  if (ref.type === 'discover_artist') {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_a; artist = a.orig_a;
    year = ''; cover = a.cover_url || ''; mbid = ''; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
    // title kept as artist name for display; album passed as '' to fetchAlbumInfo
  } else if (ref.type === 'discover_song') {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_t; artist = a.orig_a;
    year = '';
    const _songHit = a.orig_album ? enrichCacheGet(a.orig_a, a.orig_album) : null;
    cover = a.cover_url || _songHit?.cover_url || '';
    mbid = ''; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
  } else {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.mb_title || a.orig_t; artist = a.mb_artist || a.orig_a;
    year = a.date ? a.date.slice(0,4) : ''; cover = a.cover_url;
    mbid = a.mbid; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
  }

  // Reset panel
  const panel = document.getElementById('detail-panel');
  document.getElementById('dp-loading').style.display = 'none';
  document.getElementById('dp-stats').style.display   = 'none';
  document.getElementById('dp-tags').innerHTML        = '';
  document.getElementById('dp-yt').style.display      = 'none';
  document.getElementById('dp-yt').innerHTML          = '';
  document.getElementById('dp-album-wiki').style.display  = 'none';
  document.getElementById('dp-artist-bio').style.display  = 'none';
  document.getElementById('dp-links').innerHTML       = '';

  // Cover
  const dpCover = document.getElementById('dp-cover');
  if (cover) { dpCover.src = cover; dpCover.style.display = ''; }
  else        { dpCover.src = ''; dpCover.style.display = 'none'; }

  document.getElementById('dp-title').textContent  = title  || '';
  document.getElementById('dp-artist').textContent = artist || '';
  document.getElementById('dp-year').textContent   = year   || '';

  // Status not shown for discover entries
  document.getElementById('dp-status').style.display = 'none';

  // Extra users status
  const extraSt = document.getElementById('dp-extra-status');
  if (false) { // collection extra-status not used in app_discover
    extraSt.innerHTML = extraUsers.map((u, i) => {
      const h = extraHeard[i];
      const icon = u.image
        ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;opacity:${h?1:.3}">`
        : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block;opacity:${h?1:.25}"></span>`;
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${h?u.color:'var(--ink3)'}">
        ${icon} ${escH(u.user)}: ${h ? '✓' : '—'}</span>`;
    }).join('');
    extraSt.style.display = 'flex';
  } else if (['discover','discover_artist','discover_song'].includes(ref.type)) {
    const a = discoverAlbums[ref.idx];
    if (a?.users?.length) {
      const extraLabel = ref.type === 'discover_artist'
        ? a.users.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${u.image ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover">` : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block"></span>`}
            ${escH(u.user)}: ${a.total} plays · ${a.album_count} álbum${a.album_count!==1?'es':''}</span>`)
        : a.users.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${u.image ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover">` : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block"></span>`}
            ${escH(u.user)}: ${u.count} plays</span>`);
      extraSt.innerHTML = extraLabel.join('');
      extraSt.style.display = 'flex';
    } else { extraSt.innerHTML = ''; extraSt.style.display = 'none'; }
  } else { extraSt.innerHTML = ''; extraSt.style.display = 'none'; }

  // YouTube
  if (yt_id) {
    const ytDiv = document.getElementById('dp-yt');
    ytDiv.style.display = '';
    ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(yt_id)}?rel=0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>`;
  }

  // Cached description
  if (descCached) {
    document.getElementById('dp-wiki-text').textContent = descCached;
    document.getElementById('dp-album-wiki').style.display = '';
  }

  // Links
  const links = [];
  if (mbid)  links.push(`<a class="dp-link" href="https://musicbrainz.org/release-group/${mbid}" target="_blank">MusicBrainz</a>`);
  if (artist && title) {
    const ytQ = encodeURIComponent(`${artist} ${title}`);
    links.push(`<a class="dp-link" href="https://www.youtube.com/results?search_query=${ytQ}" target="_blank">Buscar YouTube ↗</a>`);
  }
  document.getElementById('dp-links').innerHTML = links.join('');

  // Open
  document.getElementById('detail-overlay').classList.add('open');
  panel.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch LFM + MB info asynchronously
  // discover_artist: album=''; discover_song: use orig_album if available; discover: full album name
  let fetchAlbum;
  if (ref.type === 'discover_artist') {
    fetchAlbum = '';
  } else if (ref.type === 'discover_song') {
    fetchAlbum = discoverAlbums[ref.idx]?.orig_album || '';
  } else {
    fetchAlbum = title || '';
  }
  fetchAlbumInfo(artist || '', fetchAlbum, mbid || '');

  // Fetch YouTube embed for album and song entries
  if ((ref.type === 'discover' || ref.type === 'discover_song') && title) {
    fetchAndEmbedYT(artist, title);
  }
}

function closeDetailPanel() {
  document.getElementById('dp-yt').innerHTML = '';
  document.getElementById('dp-yt').style.display = 'none';
  document.getElementById('detail-overlay').classList.remove('open');
  document.getElementById('detail-panel').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('detail-overlay').addEventListener('click', closeDetailPanel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('detail-panel').classList.contains('open'))
    closeDetailPanel();
});

function _applyAlbumInfoToPanel(data, artist) {
  const dpCover = document.getElementById('dp-cover');
  const coverMissing = !dpCover.src || dpCover.src.endsWith('undefined') || dpCover.style.display === 'none';

  // Cover priority: MBID → Last.fm artist image (never both — avoids NS_BINDING_ABORTED)
  if (data.cover_url && coverMissing) {
    dpCover.src = data.cover_url; dpCover.style.display = '';
  } else if (data.artist?.image && coverMissing) {
    dpCover.src = data.artist.image; dpCover.style.display = '';
  }

  // Stats — album listeners first, fall back to artist listeners
  const listeners = data.lfm?.listeners || data.artist?.listeners || '';
  const playcount  = data.lfm?.playcount || '';
  if (listeners || playcount) {
    const s = document.getElementById('dp-stats');
    s.innerHTML = (listeners ? `<span><b>${parseInt(listeners||0).toLocaleString()}</b> oyentes</span>` : '')
                + (playcount ? `<span><b>${parseInt(playcount||0).toLocaleString()}</b> plays globales</span>` : '');
    s.style.display = 'flex';
  }

  // Tags
  if (data.lfm?.tags?.length) {
    document.getElementById('dp-tags').innerHTML =
      data.lfm.tags.map(t => `<span class="dp-tag">${escH(t)}</span>`).join('');
  }

  // Album wiki
  if (data.lfm?.wiki) {
    document.getElementById('dp-wiki-text').textContent = data.lfm.wiki;
    document.getElementById('dp-album-wiki').style.display = '';
  }

  // Artist bio
  if (data.artist?.bio) {
    document.getElementById('dp-artist-bio-title').textContent = artist;
    document.getElementById('dp-bio-text').textContent = data.artist.bio;
    document.getElementById('dp-artist-bio').style.display = '';
  }

  // Update links if we got a new MBID
  const linksEl = document.getElementById('dp-links');
  if (data.mbid && !linksEl.innerHTML.includes('musicbrainz')) {
    linksEl.innerHTML =
      `<a class="dp-link" href="https://musicbrainz.org/release-group/${data.mbid}" target="_blank">MusicBrainz</a>`
      + linksEl.innerHTML;
  }
  // Last.fm album link
  if (data.lfm?.url && !linksEl.innerHTML.includes('last.fm')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="${escH(data.lfm.url)}" target="_blank">Last.fm álbum</a>`);
  }
  // Last.fm artist link
  if (data.artist?.url && !linksEl.innerHTML.includes('Last.fm artista')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="${escH(data.artist.url)}" target="_blank">Last.fm artista</a>`);
  }
}

async function fetchAlbumInfo(artist, album, mbid) {
  const loading = document.getElementById('dp-loading');
  loading.style.display = '';
  const cacheKey = `${artist}|||${album}`;
  try {
    // Use in-memory cache to avoid repeated server calls for same album
    if (albumInfoCache.has(cacheKey)) {
      _applyAlbumInfoToPanel(albumInfoCache.get(cacheKey), artist);
      loading.style.display = 'none';
      return;
    }
    const p = new URLSearchParams({ artist, album });
    if (mbid) p.set('mbid', mbid);
    const data = await fetch(`/api/album_info?${p}`).then(r => r.json());
    if (data.error) { loading.style.display = 'none'; return; }
    albumInfoCache.set(cacheKey, data);
    _applyAlbumInfoToPanel(data, artist);
  } catch(e) {}
  loading.style.display = 'none';
}

// ── Artist cover: apply to card via background-image (most reliable approach) ──
function _applyArtistCover(idx, url) {
  if (!url) return;
  discoverAlbums[idx] = discoverAlbums[idx] || {};
  discoverAlbums[idx].cover_url = url;
  const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
  if (!card) return;
  // Use background-image directly on the card — avoids all img display/src timing issues
  card.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
  card.style.backgroundSize = 'cover';
  card.style.backgroundPosition = 'center';
  // Hide the person icon placeholder
  const icon = card.querySelector('.disc-artist-icon');
  if (icon) icon.style.display = 'none';
  // Hide the dummy img if present
  const img = card.querySelector('.disc-artist-img');
  if (img) img.style.display = 'none';
}

// ── _patchDiscoverCard: update single card without re-render ───────────────
function _patchDiscoverCard(idx, a) {
  const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
  if (!card) return;
  if (a.cover_url) {
    let img = card.querySelector('.card-cover');
    const ph = card.querySelector('.card-placeholder');
    const artistIcon = card.querySelector('.disc-artist-icon');
    if (!img) {
      img = document.createElement('img');
      img.className = 'card-cover';
      img.alt = '';
      card.insertBefore(img, card.firstChild);
    }
    if (img.src !== a.cover_url) {
      img.onerror = function() {
        this.style.display = 'none';
        if (ph) ph.style.display = 'flex';
        if (artistIcon) artistIcon.style.display = 'flex';
      };
      if (ph) ph.style.display = 'none';
      if (artistIcon) artistIcon.style.display = 'none';
      img.style.display = '';   // visible BEFORE src to avoid hidden-element load suppression
      img.src = a.cover_url;
    }
  }
  const titleEl  = card.querySelector('.card-title');
  const artistEl = card.querySelector('.card-artist');
  if (titleEl  && a.mb_title)  titleEl.textContent  = a.mb_title;
  if (artistEl && a.mb_artist) artistEl.textContent = a.mb_artist;
  if (a.date) {
    let yearEl = card.querySelector('.card-year');
    if (!yearEl) {
      yearEl = document.createElement('div');
      yearEl.className = 'card-year';
      const rcUsers = card.querySelector('.rc-users');
      const info = card.querySelector('.card-info');
      if (info && rcUsers) info.insertBefore(yearEl, rcUsers);
      else if (info) info.appendChild(yearEl);
    }
    yearEl.textContent = a.date.slice(0, 4);
  }
}

// ── Sidebar USUARIOS panel ────────────────────────────────────────────────
// renderSbUsersList was the old sidebar renderer — now just an alias so old call sites work
async function renderSbUsersList() { return renderSecondaryUsers(); }

async function sbSyncPrimary() {
  if (!heardCache) return;
  const prog = document.getElementById('um-extra-progress');
  if (prog) prog.textContent = 'Sincronizando...';
  try {
    const url = `/api/scrobbles/update?user=${encodeURIComponent(heardCache.user)}&known_count=${heardCache.count||0}`;
    const data = await fetch(url).then(r => r.json());
    if (data.error) { if (prog) prog.textContent = 'Error: ' + data.error; return; }
    if (data.new_count === 0) { if (prog) prog.textContent = '✓ Al día'; return; }
    if (data.full_replace) {
      heardCache.pairs = data.heard; heardCache.count = data.heard.length; heardCache.fetched_at = data.fetched_at;
      showUserBadge(heardCache.user, document.getElementById('badge-avatar')?.src||'', heardCache.count, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
      if (prog) prog.textContent = '✓ Al día';
      await renderSecondaryUsers();
    }
  } catch(e) { if (prog) prog.textContent = 'Error: ' + e.message; }
}

function sbSavePrimaryJson() {
  if (!heardCache) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({ version:1, user:heardCache.user, count:heardCache.count, fetched_at:heardCache.fetched_at, heard:heardCache.pairs, songs: heardCache.songs||[], yt_ids, covers }, null, 0)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${heardCache.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function idbExportAll() {
  const sessions = await idbList();
  if (!sessions.length) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({ version: 1, exported_at: Date.now(), sessions, yt_ids, covers }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function showCacheNotice() {
  const notice = document.getElementById('sb-cache-notice');
  if (!notice || notice.dataset.shown) return;
  const sessions = await idbList();
  const secondarySessions = sessions.filter(s => s.user.toLowerCase() !== (heardCache?.user||'').toLowerCase());
  if (!secondarySessions.length) return;
  const oldest = secondarySessions.sort((a,b) => a.fetched_at - b.fetched_at)[0];
  const oldestDate = oldest ? new Date(oldest.fetched_at * 1000).toLocaleDateString() : '';
  let storageInfo = '';
  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const pct = Math.round(usage / quota * 100);
      const usedMB = (usage / 1048576).toFixed(0);
      storageInfo = ` (almacenamiento: ${pct}%, ${usedMB} MB usados)`;
    } catch {}
  }
  notice.dataset.shown = '1';
  notice.style.display = '';
  notice.innerHTML = `
    <b>⚠ Aviso de caché</b>${storageInfo}<br>
    Tienes <b>${secondarySessions.length}</b> usuario${secondarySessions.length > 1 ? 's' : ''} secundario${secondarySessions.length > 1 ? 's' : ''} guardado${secondarySessions.length > 1 ? 's' : ''}.
    Si se agota el espacio del navegador al añadir uno nuevo, el más antiguo
    (<b>${escH(oldest?.user || '')}</b>, descargado el ${oldestDate}) podría eliminarse automáticamente.
    <b>Se recomienda hacer una copia de seguridad antes de continuar.</b>
    <div class="notice-btns">
      <button class="btn-sm" onclick="idbExportAll()">↓ Exportar todo (backup)</button>
      <button class="btn-sm" onclick="this.closest('#sb-cache-notice').style.display='none';delete this.closest('#sb-cache-notice').dataset.shown">✕ Cerrar</button>
    </div>`;
}


// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading(msg) { loadTxt.textContent = msg || 'Cargando...'; loading.classList.add('visible'); }
function hideLoading()    { loading.classList.remove('visible'); }
function showError(msg)   { errMsg.textContent = msg; errMsg.classList.add('visible'); }
function hideError()      { errMsg.classList.remove('visible'); }
function hideResults() { heardCache = null; loadedUser = null; }
function escH(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── IndexedDB ─────────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'user' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbSave(data) {
  const db = await openIDB();
  const _put = payload => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ ...payload, user: payload.user.toLowerCase() });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
  try {
    return await _put(data);
  } catch(e) {
    if (e.name !== 'QuotaExceededError') throw e;
    // Sin canciones (songs pueden ser varios MB para usuarios grandes)
    console.warn('[idb] QuotaExceededError — guardando sin canciones');
    try {
      return await _put({ ...data, songs: [] });
    } catch(e2) {
      if (e2.name !== 'QuotaExceededError') throw e2;
      // Sin heard tampoco — solo metadatos para que el usuario aparezca en la lista
      console.warn('[idb] QuotaExceededError — guardando solo metadatos');
      const { heard, songs, ...meta } = data;
      return await _put({ ...meta, heard: [], songs: [], partial: true }).catch(() => null);
    }
  }
}
async function idbLoad(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(username.toLowerCase());
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbList() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbDelete(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(username.toLowerCase());
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ── Unified secondary users list ─────────────────────────────────────────
async function renderSecondaryUsers() {
  const sessions = await idbList();
  const el = document.getElementById('secondary-users-list');
  if (!el) return;
  const primaryUser = heardCache?.user?.toLowerCase();
  const visible = sessions
    .filter(s => s.user.toLowerCase() !== primaryUser)
    .sort((a, b) => b.fetched_at - a.fetched_at);

  if (!visible.length) {
    el.innerHTML = '<div class="idb-empty">Sin sesiones guardadas</div>';
    return;
  }
  el.innerHTML = visible.map(s => {
    const eu = extraUsers.find(u => u.user.toLowerCase() === s.user.toLowerCase());
    const isActive = !!eu;
    const _ts = s.last_scrobble_ts || s.fetched_at;
    const dateStr = new Date(_ts * 1000).toLocaleDateString();
    const lastLbl = s.last_scrobble_artist ? ` · ${s.last_scrobble_artist}` : '';
    const incompleteTag = s.complete === false ? ' <span style="color:var(--red);font-size:0.7rem" title="Descarga incompleta — usa ↻ Sync">⚠</span>' : '';
    const avatar = eu?.image
      ? `<img class="eu-avatar" src="${escH(eu.image)}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<div class="eu-dot" style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${eu?.color || 'var(--ink3)'}"></div>`;
    return `<div class="sec-user-row${isActive ? ' active' : ''}">
      <div class="sec-user-left">
        ${avatar}
        <div class="sec-user-info">
          <div class="sec-user-name">${escH(s.user)}</div>
          <div class="sec-user-meta">${s.count.toLocaleString()} álb. · ${dateStr}${escH(lastLbl)}${incompleteTag}</div>
        </div>
      </div>
      <div class="sec-user-btns">
        <button class="btn-sm" onclick="syncSecondaryIdb('${escH(s.user)}')" title="Sincronizar desde Last.fm">↻ Sync</button>
        <button class="btn-sm${isActive ? ' act' : ''}" onclick="toggleSecondaryUser('${escH(s.user)}')">${isActive ? 'ACTIVO' : 'CARGAR'}</button>
        <button class="btn-sm" onclick="idbDownloadSession('${escH(s.user)}')" title="Guardar JSON">↓ JSON</button>
        <button class="btn-sm" onclick="setPrimaryFromSecondary('${escH(s.user)}')" title="Cargar como usuario principal">→ Prin.</button>
        <button class="eu-del" onclick="idbDeleteSession('${escH(s.user)}')" title="Eliminar">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function idbLoadSession(username) {
  const data = await idbLoad(username);
  if (!data) return;
  loadHeardCache(data);
  document.getElementById('um-progress').textContent = `✓ ${data.user} cargado desde BD`;
  closeUserModal();
}

async function idbDeleteSession(username) {
  await idbDelete(username);
  const lc = username.toLowerCase();
  // Evict from active heardCache
  if (heardCache?.user?.toLowerCase() === lc) {
    heardCache = null; loadedUser = null;
    inpUser.value = '';
    hideUserBadge(); hideResults();
  }
  // Evict from extraUsers + localStorage
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
  }
  renderSecondaryUsers();
}

function idbDownloadSession(username) {
  idbLoad(username).then(data => {
    if (!data) return;
    const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    const blob = new Blob([JSON.stringify({ version:1, user: data.user, count: data.count, fetched_at: data.fetched_at, heard: data.heard, yt_ids, covers }, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tumtumpa_${data.user}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── User badge (header) ────────────────────────────────────────────────────
function showUserBadge(username, img, albumCount, lastTs, lastArtist, lastTrack) {
  if (img) {
    const av = document.getElementById('badge-avatar');
    if (av) { av.src = img; av.style.display = ''; }
    const umAv = document.getElementById('um-avatar');
    if (umAv) { umAv.src = img; umAv.style.display = ''; }
  }
  document.getElementById('badge-name').textContent = username;
  document.getElementById('badge-inline').style.display = 'flex';
  const countStr = typeof albumCount === 'number' ? albumCount.toLocaleString() + ' álb.' : albumCount;
  const dateStr  = lastTs ? new Date(lastTs * 1000).toLocaleDateString() : '';
  const lastStr  = (lastArtist && lastTrack) ? `${lastArtist} — ${lastTrack}` : '';
  const metaStr  = [countStr, dateStr].filter(Boolean).join(' · ');
  const umUser = document.getElementById('um-username');
  const umMeta = document.getElementById('um-usermeta');
  if (umUser) umUser.textContent = username;
  if (umMeta) umMeta.textContent = lastStr ? `${countStr} · ${dateStr} · ${lastStr}` : metaStr;
  const secPrim = document.getElementById('um-sec-primary');
  if (secPrim) secPrim.style.display = '';
  const saveSess = document.getElementById('btn-save-session');
  if (saveSess) saveSess.style.display = '';
  renderSecondaryUsers();
}
function hideUserBadge() {
  document.getElementById('badge-inline').style.display = 'none';
  const secPrim = document.getElementById('um-sec-primary');
  if (secPrim) secPrim.style.display = 'none';
  const saveSess = document.getElementById('btn-save-session');
  if (saveSess) saveSess.style.display = 'none';
  renderSecondaryUsers();
}

// ── Unload primary user ────────────────────────────────────────────────────
function unloadPrimaryUser() {
  heardCache = null; loadedUser = null;
  inpUser.value = '';
  hideUserBadge();
  hideResults();
  renderSecondaryUsers();
}

// ── Toggle secondary user active state (adds/removes from extraUsers) ──────
async function toggleSecondaryUser(username) {
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === username.toLowerCase());
  if (idx !== -1) {
    // Already active → deactivate
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
    renderSecondaryUsers();
    return;
  }
  // Not active → activate (load from IDB + get image)
  const data = await idbLoad(username);
  if (!data) return;
  const prog = document.getElementById('um-extra-progress');
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  const userInfo = await fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null);
  const image = userInfo?.ok ? (userInfo.image || '') : '';
  extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: data.fetched_at || 0, image });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderSecondaryUsers();
  if (prog) prog.textContent = `✓ ${data.user} cargado`;
}

// ── Sync a secondary user from Last.fm (by username in IDB) ───────────────
async function syncSecondaryIdb(username) {
  const prog = document.getElementById('um-extra-progress');
  if (prog) prog.textContent = `Sincronizando ${username}...`;
  try {
    const existing = await idbLoad(username);
    const euSrc = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase())?.source
                  || existing?.source || 'lfm';
    // Si la sesión no está marcada como completa, descargar todo desde cero
    if (existing && existing.complete === false) {
      if (prog) prog.textContent = `Sesión incompleta — descargando completo...`;
      const lfmResult = await fetchScrobblesSSE(username, msg => {
        if (prog) prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
      }, euSrc);
      const heard = lfmResult.heard;
      const songs = lfmResult.heard_songs || [];
      const newFetched = Math.floor(Date.now()/1000);
      await idbSave({ user: username, count: heard.length, fetched_at: newFetched, heard, songs,
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '',
        complete: true, total_pages: lfmResult.total_pages || 0, source: euSrc });
      const eu = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase());
      if (eu) { eu.pairs = heard; eu.songs = songs; eu.count = heard.length; eu.fetched_at = newFetched; saveExtraUsersLS(); }
      renderSecondaryUsers();
      if (prog) prog.textContent = `✓ ${username}: ${heard.length.toLocaleString()} álbumes (descarga completa)`;
      return;
    }
    const since = existing?.fetched_at || 0;
    const url = sinceEndpoint(username, since, euSrc);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // merge new pairs into existing
    const existSet = new Set((existing?.heard || []).map(p => p[0] + '|' + p[1]));
    const added = (data.new_pairs || []).filter(p => !existSet.has(p[0] + '|' + p[1]));
    const merged = [...(existing?.heard || []), ...added];
    // merge songs
    const existSongSet = new Set((existing?.songs || []).map(s => s[0] + '|' + s[1]));
    const addedSongs = (data.new_songs || []).filter(s => !existSongSet.has(s[0] + '|' + s[1]));
    const mergedSongs = [...(existing?.songs || []), ...addedSongs];
    const newFetched = data.fetched_at || Math.floor(Date.now()/1000);
    await idbSave({ user: username, count: merged.length, fetched_at: newFetched, heard: merged,
      songs: mergedSongs,
      last_scrobble_ts: data.last_scrobble_ts || existing?.last_scrobble_ts || 0,
      last_scrobble_artist: data.last_scrobble_artist || existing?.last_scrobble_artist || '',
      last_scrobble_track: data.last_scrobble_track || existing?.last_scrobble_track || '',
      complete: true, total_pages: existing?.total_pages || 0 });
    // update in-memory if in extraUsers
    const eu = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase());
    if (eu) {
      eu.pairs = merged; eu.songs = mergedSongs; eu.count = merged.length; eu.fetched_at = newFetched;
      saveExtraUsersLS();
    }
    renderSecondaryUsers();
    if (prog) prog.textContent = `✓ ${username}: +${added.length} nuevos (total ${merged.length.toLocaleString()})`;
  } catch(e) {
    if (prog) prog.textContent = 'Error: ' + e.message;
  }
}

// ── Load secondary user as primary ────────────────────────────────────────
async function setPrimaryFromSecondary(username) {
  const data = await idbLoad(username);
  if (!data) return;
  // Remove from extraUsers if present
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === username.toLowerCase());
  if (idx !== -1) { extraUsers.splice(idx, 1); saveExtraUsersLS(); }
  loadHeardCache(data);
  document.getElementById('um-progress').textContent = `✓ ${data.user} cargado como principal`;
  buildExtraUsersList();
}

function loadHeardCache(data) {
  heardCache = {
    user:                data.user,
    pairs:               data.heard,
    songs:               data.songs || data.heard_songs || [],
    count:               data.heard.length,
    fetched_at:          data.fetched_at          || 0,
    last_scrobble_ts:    data.last_scrobble_ts    || 0,
    last_scrobble_artist: data.last_scrobble_artist || '',
    last_scrobble_track: data.last_scrobble_track  || '',
    complete:            data.complete !== undefined ? data.complete : true,
    total_pages:         data.total_pages          || 0,
    // Set de artistas normalizados para filtro en modo Descubrir artistas
    artist_set:          data.heard_artists
                           ? new Set(data.heard_artists)
                           : new Set((data.heard || []).map(p => p[0])),
  };
  // song_set: fast lookup for songs mode — key is norm_a + '|' + norm_track
  heardCache.song_set = new Set(heardCache.songs.map(s => s[0] + '|' + s[1]));
  loadedUser    = data.user.toLowerCase();
  inpUser.value = data.user;
  showUserBadge(data.user, '', data.heard.length, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
  idbSave({
    user:                heardCache.user,
    count:               heardCache.count,
    fetched_at:          heardCache.fetched_at,
    heard:               heardCache.pairs,
    songs:               heardCache.songs,
    last_scrobble_ts:    heardCache.last_scrobble_ts,
    last_scrobble_artist: heardCache.last_scrobble_artist,
    last_scrobble_track: heardCache.last_scrobble_track,
    complete:            heardCache.complete,
    total_pages:         heardCache.total_pages,
    heard_artists:       [...heardCache.artist_set],
  }).then(() => { renderIdbList(); renderIdbExtraList(); }).catch(() => {});
  dismissWelcome();
}

// ── Session: guardar JSON ─────────────────────────────────────────────────
document.getElementById('btn-save-session').addEventListener('click', () => {
  if (!heardCache) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({
    version: 1, user: heardCache.user, count: heardCache.count,
    fetched_at: heardCache.fetched_at, heard: heardCache.pairs,
    songs: heardCache.songs || [],
    yt_ids, covers,
  }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${heardCache.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Session: importar JSON (routes to primary or secondary) ───────────────
document.getElementById('btn-import').addEventListener('click', () => inpSession.click());
inpSession.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById('um-progress');
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error('Formato inválido');
    // Restore enrich and YT caches (merge; existing takes priority as it's more recent)
    if (data.covers && typeof data.covers === 'object') {
      try {
        const existing = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
        localStorage.setItem(ENRICH_CACHE_KEY, JSON.stringify({ ...data.covers, ...existing }));
      } catch(_) {}
    }
    if (data.yt_ids && typeof data.yt_ids === 'object') {
      try {
        const existing = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
        localStorage.setItem(YT_CACHE_KEY, JSON.stringify({ ...data.yt_ids, ...existing }));
      } catch(_) {}
    }
    const addAsSecondary = !!heardCache && heardCache.user.toLowerCase() !== data.user.toLowerCase();
    if (addAsSecondary) {
      if (extraUsers.some(u => u.user.toLowerCase() === data.user.toLowerCase())) {
        prog.textContent = `${data.user} ya está activo`; e.target.value = ''; return;
      }
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const ft = data.fetched_at || 0;
      extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: ft, image: '' });
      saveExtraUsersLS();
      await idbSave({ user: data.user, count: data.heard.length, fetched_at: ft, heard: data.heard, songs: data.songs || [] });
      buildExtraUsersList();
      prog.textContent = `✓ ${data.user} importado como secundario — ${data.heard.length.toLocaleString()} álbumes`;
      // Fetch avatar in background
      fetch(`/api/check_user?user=${encodeURIComponent(data.user)}`).then(r=>r.json()).then(info => {
        if (!info?.ok || !info.image) return;
        const eu = extraUsers.find(u => u.user.toLowerCase() === data.user.toLowerCase());
        if (eu) { eu.image = info.image; saveExtraUsersLS(); renderSecondaryUsers(); }
        idbLoad(data.user).then(d => { if (d) idbSave({ ...d, image: info.image }); }).catch(()=>{});
      }).catch(()=>{});
    } else {
      loadHeardCache(data);
      prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
      closeUserModal();
    }
  } catch(err) {
    prog.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
});

// ── Session: sync incremental ──────────────────────────────────────────────
document.getElementById('btn-sync-session').addEventListener('click', async () => {
  if (!heardCache) return;
  const btn = document.getElementById('btn-sync-session');
  const prog = document.getElementById('um-progress');
  btn.disabled = true;
  btn.textContent = '↻ ...';
  prog.textContent = 'Sincronizando con Last.fm...';
  try {
    const knownCount = heardCache.count || 0;
    const url = `/api/scrobbles/update?user=${encodeURIComponent(heardCache.user)}&known_count=${knownCount}`;
    const data = await fetch(url).then(r => r.json());
    if (data.error) { prog.textContent = 'Error: ' + data.error; return; }
    if (data.new_count === 0) {
      prog.textContent = '✓ Al día'; btn.textContent = '↻ Sync'; return;
    }
    if (data.full_replace) {
      heardCache.pairs = data.heard; heardCache.count = data.heard.length; heardCache.fetched_at = data.fetched_at;
      showUserBadge(heardCache.user, '', heardCache.count, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
      prog.textContent = `✓ Al día`;
    }
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Sync';
  }
});

// ── Unload primary button ──────────────────────────────────────────────────
document.getElementById('btn-unload-primary').addEventListener('click', unloadPrimaryUser);

// ── Main: Cargar scrobbles ─────────────────────────────────────────────────
btnGo.addEventListener('click', doLoadUser);
inpUser.addEventListener('keydown', e => { if (e.key === 'Enter') doLoadUser(); });

async function doLoadUser() {
  const user = inpUser.value.trim();
  if (!user) return;
  hideError();
  const prog = document.getElementById('um-progress');
  btnGo.disabled = true;

  // If primary already loaded AND this user is not the primary → add as secondary
  const addAsSecondary = !!heardCache && heardCache.user.toLowerCase() !== user.toLowerCase();
  const src = umSource();

  try {
    if (addAsSecondary) {
      // Always do a full fresh download via the search box — never short-circuit
      // from IDB here; the IDB may contain a truncated previous download.
      // Use the "CARGAR" button on the secondary list to load from IDB instead.
      prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
      const [userInfo, lfmResult] = await Promise.all([
        fetch(checkUserEndpoint(user, src)).then(r=>r.json()).catch(()=>null),
        fetchScrobblesSSE(user, msg => {
          prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
        }, src),
      ]);
      const heard = lfmResult.heard;
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const image = userInfo?.ok ? (userInfo.image || '') : '';
      const realUser = userInfo?.ok ? userInfo.username : user;
      const fetched_at = Math.floor(Date.now()/1000);
      // Replace existing extraUsers entry if present, else push new
      const euIdx = extraUsers.findIndex(u => u.user.toLowerCase() === realUser.toLowerCase());
      const eu = { user: realUser, pairs: heard, songs: lfmResult.heard_songs||[], color: euIdx !== -1 ? extraUsers[euIdx].color : color,
        count: heard.length, fetched_at, image, source: src,
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '' };
      if (euIdx !== -1) extraUsers[euIdx] = eu; else extraUsers.push(eu);
      saveExtraUsersLS();
      await idbSave({ user: realUser, count: heard.length, fetched_at, heard,
        songs: lfmResult.heard_songs || [],
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '',
        complete: true, total_pages: lfmResult.total_pages || 0,
        heard_artists: lfmResult.heard_artists || [], source: src });
      buildExtraUsersList();
      prog.textContent = `✓ ${realUser} añadido — ${heard.length.toLocaleString()} álbumes`;
      inpUser.value = '';
    } else {
      // Load as primary
      prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
      const result = await fetchScrobblesSSE(user, msg => {
        prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes únicos`;
      }, src);
      loadHeardCache({
        user, heard: result.heard, heard_songs: result.heard_songs || [],
        fetched_at:           Math.floor(Date.now()/1000),
        last_scrobble_ts:     result.last_scrobble_ts    || 0,
        last_scrobble_artist: result.last_scrobble_artist || '',
        last_scrobble_track:  result.last_scrobble_track  || '',
        complete:             true,
        total_pages:          result.total_pages          || 0,
        heard_artists:        result.heard_artists         || [],
      });
      prog.textContent = `✓ ${result.heard.length.toLocaleString()} álbumes cargados`;
      closeUserModal();
    }
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btnGo.disabled = false;
  }
}

// ── Welcome screen ─────────────────────────────────────────────────────────
function dismissWelcome() {
  localStorage.setItem('tt_welcomed', '1');
  document.getElementById('welcome-screen').style.display = 'none';
}

function startFromWelcome() {
  dismissWelcome();
  openUserModal();
}

// ── PWA Service Worker registration ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

// ── Init ─────────────────────────────────────────────────────────────────
(async () => {
  loadExtraUsersLS();
  // Purge extra users no longer in IDB
  if (extraUsers.length) {
    try {
      const sessions = await idbList();
      const inIdb = new Set(sessions.map(s => s.user.toLowerCase()));
      const valid = extraUsers.filter(u => inIdb.has(u.user.toLowerCase()));
      if (valid.length !== extraUsers.length) {
        extraUsers.length = 0; valid.forEach(u => extraUsers.push(u));
        saveExtraUsersLS();
      }
    } catch(e) {}
  }
  await renderSecondaryUsers();
  buildExtraUsersList();

  // Show welcome screen if no data at all and never seen before
  const welcomed = localStorage.getItem('tt_welcomed');
  if (!welcomed) {
    const sessions = await idbList().catch(() => []);
    if (!sessions.length && !extraUsers.length) {
      document.getElementById('welcome-screen').style.display = 'block';
    }
  }
})();
</script>
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
