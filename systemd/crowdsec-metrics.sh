#!/bin/sh
# Scrape CrowdSec Prometheus metrics and write to node_exporter textfile collector.
# Deploy to: ~/.local/bin/crowdsec-metrics.sh  (chmod +x)
#
# El directorio destino es compartido con docker_webs (grupo fusion).
# CrowdSec incluye timestamps en sus métricas; se eliminan porque el textfile
# collector de node_exporter solo acepta métricas sin timestamp.

TEXTFILE_DIR="/home/docker_webs/contenedores/nginx/crowdsec_textfiles"

while true; do
    curl -sf http://127.0.0.1:6060/metrics \
        | sed '/^[^#]/s/ [0-9][0-9]*$//' \
        > "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
    && mv "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
          "${TEXTFILE_DIR}/crowdsec.prom"
    sleep 60
done
