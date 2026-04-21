#!/usr/bin/env bash
# Escanea todas las imágenes del proyecto con Trivy.
# Las imágenes custom se leen de los contenedores en ejecución (no se reconstruyen).
# Uso: ./scan_images.sh [--severity CRITICAL,HIGH] [--fix-only]
set -euo pipefail

SEVERITY="${SEVERITY:-CRITICAL,HIGH}"
OUTPUT_DIR="${OUTPUT_DIR:-./trivy_reports}"
BUILD_CONTEXT="$(cd "$(dirname "$0")" && pwd)"

while [[ $# -gt 0 ]]; do
  case $1 in
    --severity) SEVERITY="$2"; shift 2 ;;
    --fix-only) SEVERITY="CRITICAL"; shift ;;
    *) echo "Uso: $0 [--severity CRITICAL,HIGH] [--fix-only]"; exit 1 ;;
  esac
done

if ! command -v trivy &>/dev/null; then
  echo "Trivy no está instalado."
  echo "Instalar: curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FAILED=()

scan_image() {
  local label="$1"
  local ref="$2"  # puede ser nombre:tag, sha256, o image ID
  local report="$OUTPUT_DIR/${label}_${TIMESTAMP}.txt"

  echo ""
  echo "══════════════════════════════════════════════"
  echo "  Escaneando: $label  ($ref)"
  echo "══════════════════════════════════════════════"

  if trivy image \
      --severity "$SEVERITY" \
      --no-progress \
      --output "$report" \
      "$ref"; then
    echo "  → OK. Reporte: $report"
  else
    echo "  → VULNERABILIDADES ENCONTRADAS: $report"
    FAILED+=("$label")
  fi
}

# Obtiene el image ID de un contenedor por nombre; vacío si no existe/no corre
image_id_of() {
  docker inspect --format='{{.Image}}' "$1" 2>/dev/null || true
}

# ── Imágenes remotas (ya descargadas o se descargan ahora) ───────────────────
scan_image "owasp_modsecurity_crs_nginx" \
  "owasp/modsecurity-crs:nginx@sha256:d5075e29201de332751b1a691186944ae0af1f4d9dda37275daa342d18117902"

scan_image "nginx_prometheus_exporter" \
  "nginx/nginx-prometheus-exporter@sha256:bf76e58df548a13e52bd543ac70f6d3d667e14884e8b51c149bd81994ca75ccd"

scan_image "node_exporter" \
  "prom/node-exporter@sha256:e9cff4fc67b1818f8c97adb115b9f12c9a54b533de86765d4a0effc01b357205"

# ── Imágenes custom: escanear la imagen del contenedor en ejecución ──────────
# Si el contenedor no está corriendo, avisar y saltar.
for container in nginx escuchowsky tumtumpa; do
  img_id="$(image_id_of "$container")"
  if [[ -z "$img_id" ]]; then
    echo ""
    echo "  AVISO: contenedor '$container' no está corriendo — no se puede escanear."
    echo "  Arráncalo con 'docker compose up -d $container' y vuelve a ejecutar."
    FAILED+=("custom:$container (no corriendo)")
  else
    scan_image "custom_${container}" "$img_id"
  fi
done

# ── Resumen ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  RESUMEN  (severidad: $SEVERITY)"
echo "══════════════════════════════════════════════"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "  Sin vulnerabilidades $SEVERITY encontradas."
else
  echo "  Imágenes con problemas:"
  for img in "${FAILED[@]}"; do
    echo "    ✗ $img"
  done
fi
echo "  Reportes en: $OUTPUT_DIR/"
echo ""
