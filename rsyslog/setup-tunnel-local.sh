#!/bin/sh
## Script de preparación del servidor LOCAL para el túnel rsyslog
## Ejecutar UNA VEZ en el servidor local como root.

set -e

# Usuario con home propio para que pueda leer/escribir sus propios archivos
useradd --system --create-home --home-dir /home/autossh --shell /usr/sbin/nologin autossh 2>/dev/null || true

KEY_DIR="/home/autossh/.ssh"
KEY_FILE="${KEY_DIR}/rsyslog_tunnel_key"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

# Generar par de claves ED25519 (sin passphrase — es un servicio)
if [ ! -f "$KEY_FILE" ]; then
    ssh-keygen -t ed25519 \
        -f "$KEY_FILE" \
        -N "" \
        -C "rsyslog-tunnel@pepecono"
    echo ""
    echo "Par de claves generado."
fi

chown -R autossh:autossh "$KEY_DIR"
chmod 600 "$KEY_FILE"
chmod 644 "${KEY_FILE}.pub"

# Primer SSH manual para aceptar el fingerprint y guardarlo en known_hosts
# (StrictHostKeyChecking=yes en el servicio requiere que exista)
echo ""
echo "SIGUIENTE PASO — ejecuta esto como el usuario autossh para guardar el fingerprint:"
echo ""
echo "  sudo -u autossh ssh -p 2145 \\"
echo "      -i ${KEY_FILE} \\"
echo "      tunnel@aws-server.example.com echo ok"
echo ""
echo "Escribe 'yes' cuando pregunte por el fingerprint."
echo ""
echo "Clave pública a copiar al servidor AWS:"
echo ""
cat "${KEY_FILE}.pub"
