#!/bin/sh
# Scrape CrowdSec Prometheus metrics and write to node_exporter textfile collector.
# Deploy to: ~/.local/bin/crowdsec-metrics.sh  (chmod +x)

TEXTFILE_DIR="${HOME}/.local/share/node_exporter/textfiles"

while true; do
    curl -sf http://127.0.0.1:6060/metrics \
        > "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
    && mv "${TEXTFILE_DIR}/crowdsec.prom.tmp" \
          "${TEXTFILE_DIR}/crowdsec.prom"
    sleep 60
done
