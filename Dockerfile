FROM nginxinc/nginx-unprivileged

USER root
COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
RUN chown -R 1003:1003 /etc/nginx/conf.d /etc/nginx/ssl
USER 1003
