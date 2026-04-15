#!/bin/sh
# Scrape CrowdSec Prometheus metrics and write to node_exporter textfile collector.
# Deploy to: ~/.local/bin/crowdsec-metrics.sh  (chmod +x)
#
# El directorio destino es compartido con docker_webs (grupo fusion).
# CrowdSec incluye timestamps en sus métricas; se eliminan porque el textfile
# collector de node_exporter solo acepta métricas sin timestamp.

TEXTFILE_DIR="/home/docker_webs/contenedores/nginx/crowdsec_textfiles"
umask 022  # archivos creados con permisos 644 (legibles por todos)

while true; do
    curl -sf http://127.0.0.1:6060/metrics \
        | awk '/^#/{print; next} NF==3 && $3~/^[0-9]{10,}$/{print $1, $2; next} {print}' \
        > "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
    && mv "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
          "${TEXTFILE_DIR}/crowdsec.prom"
    sleep 60
done
