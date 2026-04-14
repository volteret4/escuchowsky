FROM nginxinc/nginx-unprivileged

USER root
COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
COPY entrypoint_nginx.sh /entrypoint_nginx.sh
RUN chmod -R 644 /etc/nginx/conf.d /etc/nginx/ssl && \
    chmod 755 /etc/nginx/conf.d /etc/nginx/ssl && \
    chmod +x /entrypoint_nginx.sh
USER 101

ENTRYPOINT ["/entrypoint_nginx.sh"]
