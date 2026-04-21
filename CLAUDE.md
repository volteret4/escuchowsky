# CLAUDE.md / CLOUD.md — Security Mission

## Contexto del proyecto

Este proyecto no se ejecuta en el servidor local desde el que se gestiona, sino en un servidor externo alojado en Amazon.

La arquitectura actual incluye:

* Dos aplicaciones Python (Flask + Gunicorn) en contenedores separados
* Un contenedor Nginx actuando como reverse proxy
* ModSecurity (WAF) integrado en Nginx
* Docker en modo rootless
* CrowdSec analizando logs del sistema y aplicaciones
* Monitorización externa mediante Prometheus y Grafana (en otro servidor independiente)
* Exposición pública limitada a puertos 80 y 443, redirigidos mediante iptables hacia Nginx
* Certificados ssl para las paginas, y uno que solo puede uasr prometheus renovados con acme.sh

---

## Objetivo principal

El objetivo de este proyecto es único y no debe desviarse:

> **Asegurar completamente el servidor y todos los componentes que ejecuta.**

No estamos desarrollando nuevas funcionalidades.
No estamos optimizando rendimiento.
No estamos añadiendo features.

**Toda la tarea consiste en reducir superficie de ataque, prevenir intrusiones y limitar el impacto de cualquier posible compromiso.**

---

## Principios clave

1. **Minimizar superficie de ataque**

   * Solo exponer lo estrictamente necesario (80/443)
   * Aislar servicios entre sí

2. **Defensa en profundidad**

   * Nginx + ModSecurity + CrowdSec + iptables
   * Ninguna capa es suficiente por sí sola

3. **Asumir compromiso**

   * Diseñar el sistema como si eventualmente fuese comprometido
   * Limitar movimiento lateral y escalado

4. **Zero trust interno**

   * No confiar en contenedores entre sí
   * No confiar en tráfico interno

---

## Líneas de trabajo obligatorias

### 1. Endurecimiento de Nginx

* Añadir headers de seguridad estrictos
* Configurar rate limiting
* Limitar tamaño de requests
* Reducir timeouts (anti slow attacks)
* Forzar HTTPS + HSTS

---

### 2. Configuración avanzada de ModSecurity

* Integrar OWASP CRS
* Ajustar paranoia level (mínimo PL2)
* Activar logs en formato JSON
* Eliminar falsos positivos sin relajar reglas globales

---

### 3. CrowdSec (detección + respuesta)

* Implementar bouncer en Nginx (bloqueo activo)
* Crear escenarios personalizados:

  * exceso de 403
  * escaneo de rutas (404)
* Aprovechar listas de reputación comunitarias

---

### 4. Aislamiento en Docker

* Separar redes:

  * frontend (Nginx)
  * backend (Flask)
* Flask NO accesible externamente
* Aplicar:

  * `cap_drop: ALL`
  * filesystem read-only
  * uso de `tmpfs`
* Limitar CPU y memoria por contenedor

---

### 5. Seguridad en aplicaciones Python

* Validación estricta de inputs
* Evitar ejecución dinámica (`eval`, `exec`)
* Uso de ORM para prevenir SQL injection
* Configuración segura de Gunicorn:

  * límites de requests
  * timeouts controlados

---

### 6. Firewall (iptables)

* Política por defecto: DROP
* Permitir solo:

  * conexiones establecidas
  * puertos 80 y 443
* Evitar tráfico lateral innecesario

---

### 7. TLS

* Solo TLS 1.2 y 1.3
* Cifrados modernos
* OCSP stapling

---

### 8. Monitorización y alertas

* No limitarse a dashboards
* Definir alertas reales:

  * picos de tráfico
  * errores 5xx
  * bloqueos de CrowdSec

---

## Riesgos identificados

* Nginx como punto único de fallo
* Dependencia total del reverse proxy
* Posible mala configuración de ModSecurity
* Falta de aislamiento entre contenedores
* Seguridad delegada erróneamente al WAF

---

## Enfoque operativo

Cada cambio debe responder a una de estas preguntas:

* ¿Reduce superficie de ataque?
* ¿Limita impacto de un compromiso?
* ¿Evita acceso no autorizado?
* ¿Mejora visibilidad o respuesta ante ataques?

Si la respuesta es “no”, no se implementa.

---

## Regla fundamental

> **Este proyecto no trata de construir, sino de defender.**

Todo el esfuerzo debe centrarse en endurecer, aislar y monitorizar.

Cualquier decisión que aumente complejidad sin mejorar seguridad debe descartarse.
