#!/bin/sh
## Script de preparación del servidor LOCAL para el túnel rsyslog
## Ejecutar UNA VEZ en el servidor local como root.

set -e

# Usuario dedicado a autossh
useradd --system --no-create-home --shell /usr/sbin/nologin autossh 2>/dev/null || true
mkdir -p /etc/autossh
chmod 700 /etc/autossh

# Generar par de claves ED25519 para el túnel (sin passphrase — es un servicio)
if [ ! -f /etc/autossh/rsyslog_tunnel_key ]; then
    ssh-keygen -t ed25519 \
        -f /etc/autossh/rsyslog_tunnel_key \
        -N "" \
        -C "rsyslog-tunnel@local"
    echo ""
    echo "Par de claves generado."
fi

chown -R autossh:autossh /etc/autossh
chmod 600 /etc/autossh/rsyslog_tunnel_key
chmod 644 /etc/autossh/rsyslog_tunnel_key.pub

# Hacer ssh una vez manualmente para guardar el fingerprint del host AWS
# (StrictHostKeyChecking=yes en el servicio requiere que este archivo exista)
echo ""
echo "SIGUIENTE PASO — ejecuta esto manualmente para guardar el fingerprint del AWS:"
echo ""
echo "  ssh -i /etc/autossh/rsyslog_tunnel_key \\"
echo "      -o UserKnownHostsFile=/etc/autossh/known_hosts \\"
echo "      tunnel@aws-server.example.com echo ok"
echo ""
echo "Clave pública a copiar al servidor AWS:"
echo ""
cat /etc/autossh/rsyslog_tunnel_key.pub
