#!/bin/sh
set -e

# Genera el árbol de géneros si no existe o si la DB fue actualizada
DB="${DB_PATH:-/app/db/must_hear_rym_new.db}"
# Prefer rym_genres.json from mounted volume; fall back to bundled copy
if [ -f "/app/db/rym_genres.json" ]; then
  GENRES_JSON="/app/db/rym_genres.json"
else
  GENRES_JSON="/app_escuchowsky/rym_genres.json"
fi
OUT="/app_escuchowsky/rym_genre_tree.html"

if [ -f "$DB" ] && [ -f "$GENRES_JSON" ]; then
  echo "🌳 Generando árbol de géneros..."
  python3 app_genre_mermaid.py \
    --mh-db "$DB" \
    --genres-json "$GENRES_JSON" \
    --output "$OUT" \
    --yt-videos 15 \
    && echo "✅ rym_genre_tree.html generado" \
    || echo "⚠  Error generando árbol de géneros (la app seguirá sin /genres)"
else
  echo "⚠  DB o rym_genres.json no encontrados — /genres no estará disponible"
  echo "   DB_PATH=$DB"
  echo "   GENRES_JSON=$GENRES_JSON"
fi

mkdir -p /app/logs

exec gunicorn \
  -w 2 \
  --threads 4 \
  -b 0.0.0.0:5001 \
  --timeout 120 \
  --forwarded-allow-ips "*" \
  --access-logfile /app/logs/access.log \
  --error-logfile /app/logs/error.log \
  app_genres:app
