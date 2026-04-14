# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Server Infrastructure

Corriendo en AWS EC2 con Docker rootless bajo un usuario sin acceso sudo:

- Puertos abiertos (consola AWS):
  - 80 → iptables → 8085 (0.0.0.0/0)
  - 443 → iptables → 8443 (0.0.0.0/0)
  - 2245 (SSH custom, solo mi IP, solo llave SSH)
- CrowdSec con nginx-bouncer y firewall-bouncer leyendo logs de nginx y Flask
- Servidores locales disponibles para heavy-lifting y evitar carga en EC2

## What This Is

**Escuchowsky** es una app de descubrimiento musical que cruza el historial de Last.fm del usuario con colecciones curadas de RateYourMusic (RYM) para mostrar qué álbumes no ha escuchado aún.

Dos aplicaciones Flask independientes, cada una con su propio dominio y contenedor:

- **escuchowsky** (`app_genres.py`, port 5001) — mustlisten: colecciones y árbol de géneros de RYM
- **tumtumpa** (`app_discover.py`, port 5001) — mustdiscover: comparar con amigos de Last.fm

## Common Commands

```bash
# Build and start everything
docker-compose up --build -d

# Logs
docker-compose logs -f escuchowsky
docker-compose logs -f tumtumpa
docker-compose logs -f nginx

# Restart a single service
docker-compose restart escuchowsky

# Rebuild a single service
docker-compose up --build -d escuchowsky
```

No test suite exists. Pre-commit hook runs `gitleaks protect --verbose --redact --staged` to catch secrets.

## Architecture

### Containers (`docker-compose.yml`)

| Container | Image | Port | App |
|-----------|-------|------|-----|
| `escuchowsky` | `Dockerfile.escuchowsky` | 5001 | `app_genres.py` |
| `tumtumpa` | `Dockerfile.tumtumpa` | 5001 | `app_discover.py` |
| `nginx` | `Dockerfile` (nginx-unprivileged) | 8085:80, 8443:443 | Reverse proxy |

All containers share the `musica` bridge network. Nginx resolves upstream services by Docker DNS name (`escuchowsky`, `tumtumpa`).

### Flask Apps

Both apps follow the same pattern:
1. Client sends username → Flask fetches full scrobble history from Last.fm API (paginated, 200/page) via SSE (`text/event-stream`)
2. Albums matched against SQLite DB using fuzzy normalization (`_norm()` strips non-word chars, lowercases)
3. Unheard albums highlighted against curated RYM collections

Key SSE endpoints (long-running, gunicorn 120s timeout):
- `GET /api/scrobbles?user=...` — streams per-page progress
- `GET /api/enrich_albums?albums=[...]` — MusicBrainz lookups with 1.1s rate limiting per result

### Database (`db/must_hear_rym_new.db`)

SQLite with four tables: `artists`, `albums`, `collections`, `collection_albums`. Schema in `db/lastfm_rym_normalized.sql`. Mounted as a volume from `./db`.

`app_genres.py` also reads `db/rym_genres.json` (hierarchical genre tree from RYM) at startup.

### Entrypoint

`entrypoint_escuchowsky.sh` runs `app_genre_mermaid.py` first (generates `rym_genre_tree.html` from `rym_genres.json`), then starts gunicorn (2 workers × 4 threads).

### Nginx (`conf.d/`)

- `00_zones.conf` — rate limit zones: heavy APIs 6/min, covers 60/min, pages 60/min
- `server_params.conf` — TLS 1.2/1.3, security headers, Docker DNS resolver, proxy settings
- `escuchowsky.conf` / `tumtumpa.conf` — virtual hosts per domain

### External APIs Used

- **Last.fm** (`ws.audioscrobbler.com`) — scrobbles, top albums, user info, friends
- **MusicBrainz** (`musicbrainz.org`) — release group search for MBID enrichment
- **CoverArtArchive** (`coverartarchive.org`) — album covers proxied by MBID

### Secrets

Managed with SOPS + age encryption (`.sops.yaml`, `.encrypted.env`). The required env var is `LASTFM_API_KEY`.

### Client-Side

The frontends are SPAs with:
- IndexedDB for scrobble caching (persists across sessions)
- LocalStorage for preferences and extra user lists
- Service Worker in tumtumpa for offline support
- `X-Accel-Buffering: no` header required on SSE responses to bypass nginx buffering
