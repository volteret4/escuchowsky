FROM owasp/modsecurity-crs:nginx@sha256:d5075e29201de332751b1a691186944ae0af1f4d9dda37275daa342d18117902

USER root
# Eliminar config de servidor por defecto de la imagen OWASP
RUN rm -f /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/crs-setup.conf.example

COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
RUN chmod -R 644 /etc/nginx/conf.d /etc/nginx/ssl && \
    chmod 755 /etc/nginx/conf.d /etc/nginx/ssl

# Usa el entrypoint de la imagen OWASP (envsubst para modsec + exec nginx)
