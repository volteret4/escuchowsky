#!/bin/sh
set -e

# Genera el árbol de géneros si no existe o si la DB fue actualizada
DB="${DB_PATH:-/app/db/must_hear.db}"
# Prefer genres.json from mounted volume; fall back to bundled copy
if [ -f "/app/db/genres.json" ]; then
  GENRES_JSON="/app/db/genres.json"
else
  GENRES_JSON="/app_escuchowsky/genres.json"
fi
OUT="/tmp/genre_tree.html"

if [ -f "$DB" ] && [ -f "$GENRES_JSON" ]; then
  echo "Generando árbol de géneros..."
  python3 app_genre_mermaid.py \
    --mh-db "$DB" \
    --genres-json "$GENRES_JSON" \
    --output "$OUT" \
    --yt-videos 20 \
    && echo "genre_tree.html generado" \
    || echo "Error generando árbol de géneros (la app seguirá sin /genres)"
else
  echo "DB o genres.json no encontrados — /genres no estará disponible"
  echo "   DB_PATH=$DB"
  echo "   GENRES_JSON=$GENRES_JSON"
fi

exec gunicorn \
  -w 2 \
  --threads 4 \
  -b 0.0.0.0:5001 \
  --timeout 120 \
  --max-requests 1000 \
  --max-requests-jitter 100 \
  --forwarded-allow-ips "172.20.0.10" \
  --access-logfile /app/logs/access.log \
  --error-logfile /app/logs/error.log \
  app_genres:app
