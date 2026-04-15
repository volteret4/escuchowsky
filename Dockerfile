FROM owasp/modsecurity-crs:nginx-alpine-unprivileged

USER root
# Eliminar config de servidor por defecto de la imagen OWASP
RUN rm -f /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/crs-setup.conf.example

COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
RUN chmod -R 644 /etc/nginx/conf.d /etc/nginx/ssl && \
    chmod 755 /etc/nginx/conf.d /etc/nginx/ssl
USER 101

# Usa el entrypoint de la imagen OWASP (envsubst para modsec + exec nginx)
