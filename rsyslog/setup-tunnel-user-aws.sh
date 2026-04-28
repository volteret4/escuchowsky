#!/bin/sh
## Script de preparación del servidor AWS para el túnel rsyslog
## Ejecutar UNA VEZ en el servidor AWS como root.
## Después, copiar la clave pública del servidor local a authorized_keys.fragment
## y pegarla en /home/tunnel/.ssh/authorized_keys

set -e

# Usuario dedicado solo al túnel — sin shell, sin home real
useradd --system --no-create-home --shell /usr/sbin/nologin tunnel 2>/dev/null || true

mkdir -p /home/tunnel/.ssh
chmod 700 /home/tunnel/.ssh
chown tunnel:tunnel /home/tunnel/.ssh

# Crear authorized_keys vacío con permisos correctos
touch /home/tunnel/.ssh/authorized_keys
chmod 600 /home/tunnel/.ssh/authorized_keys
chown tunnel:tunnel /home/tunnel/.ssh/authorized_keys

echo ""
echo "Usuario 'tunnel' creado."
echo ""
echo "Pega ahora la clave pública del servidor local en:"
echo "  /home/tunnel/.ssh/authorized_keys"
echo ""
echo "Con el prefijo restrict,port-forwarding (ver authorized_keys.fragment)"
echo ""
echo "Verificar que sshd_config tenga:"
grep -E "^AllowTcpForwarding|^GatewayPorts" /etc/ssh/sshd_config || echo "  AllowTcpForwarding yes   (ausente — comprueba sshd_config)"
