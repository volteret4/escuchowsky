FROM nginxinc/nginx-unprivileged

USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY conf.d /etc/nginx/conf.d
COPY ssl /etc/nginx/ssl
RUN chown -R 101:101 /etc/nginx/conf.d /etc/nginx/ssl
USER 101
