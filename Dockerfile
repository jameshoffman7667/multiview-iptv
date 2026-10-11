FROM node:22-alpine
ENV NODE_ENV=production PORT=1234 DATA_DIR=/data
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
