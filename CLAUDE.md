# mustlisten — app.py standalone

## Qué es
Flask web app que cruza scrobbles de Last.fm con listas de álbumes "must hear"
almacenadas en SQLite. El usuario introduce su nick de Last.fm, el servidor
descarga su historial de la API y lo cruza localmente con la colección elegida.

## Archivo principal
`app.py` — todo en un solo fichero (~1500 líneas). Incluye:
- Backend Flask con 5 endpoints
- HTML/CSS/JS embebido en `HTML_TEMPLATE`

## Endpoints
- `GET /`                          → UI principal
- `GET /api/collections`           → lista de colecciones de la DB
- `GET /api/collection?slug=X`     → álbumes de una colección (con géneros)
- `GET /api/scrobbles?user=X`      → descarga top albums + recientes de Last.fm
- `GET /api/scrobbles/update`      → sync incremental (compara con known_count)
- `GET /api/check_user?user=X`     → verifica usuario Last.fm
- `GET /api/cover?mbid=X`          → proxy para CoverArtArchive (evita CORS)

## Base de datos: must_hear_rym_new.db
Tablas relevantes:
- `collections`      — id, slug, name, total_albums, source_type, source_url
- `collection_albums`— collection_id, album_id, rank
- `albums`           — id, name, year, release_group_mbid, cover_url, yt_id, artist_id
- `artists`          — id, name
- `genres`           — id, name, source
- `album_genres`     — album_id, genre_id
- `user_heard`       — (no usado por la web app, solo por html_must_hear.py)

source_type values: musicbrainz | rateyourmusic | sputnikmusic | image_ocr | NULL

## UI (HTML_TEMPLATE)
Layout 2 columnas: sidebar izquierdo + contenido principal
- Sidebar: panel Colecciones (agrupadas por serie), panel Géneros, panel Fechas
- Main: input usuario, stats bar, filtros heard/missing, grid de portadas
- Modal al hacer click en una portada: cover + youtube embed + links

## Cómo arrancar
```bash
pip install flask
python app.py --db /ruta/must_hear_rym_new.db --lastfm-api-key TU_KEY
# Por defecto: http://127.0.0.1:5000
```

## Hosting — Fly.io (recomendado para testing gratuito)
```bash
pip install flyctl
flyctl auth login
flyctl launch       # genera fly.toml, Dockerfile
flyctl volumes create data_vol --size 2 --region mad
# En fly.toml añadir:
# [mounts]
#   source = "data_vol"
#   destination = "/data"
flyctl deploy
```
La DB se sube al volumen en /data/ (persistente entre deploys).
LASTFM_API_KEY se pone con: `flyctl secrets set LASTFM_API_KEY=xxx`

## Limitaciones conocidas
- La DB acabará pesando 100-200MB (completa con todas las colecciones + portadas)
- El scraping de Last.fm tarda 10-60s en usuarios con muchos scrobbles
  (usa getTopAlbums paginado + getRecentTracks)
- No hay autenticación — cualquiera con la URL puede usarla

## Mejoras pendientes
- Búsqueda de texto dentro de una colección
- Modo offline completo (guardar colecciones en localStorage)
- Comparar entre varios usuarios
- Añadir colecciones nuevas desde la UI (requeriría html_must_hear.py integrado)
