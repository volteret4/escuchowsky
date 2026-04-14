#!/bin/sh
set -e

# Sustituir ${METRICS_ALLOWED_IP} en los configs de nginx antes de arrancar.
# Solo sustituye esta variable para no interferir con otras $ en los configs.
for f in /etc/nginx/conf.d/*.conf; do
    envsubst '${METRICS_ALLOWED_IP}' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

exec nginx -g "daemon off;"
