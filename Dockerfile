FROM nginxinc/nginx-unprivileged

USER root
COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
# RUN chown -R 101:101 /etc/nginx/conf.d /etc/nginx/ssl
# USER 101
RUN chmod -R 644 /etc/nginx/conf.d /etc/nginx/ssl && \
    chmod 755 /etc/nginx/conf.d /etc/nginx/ssl
