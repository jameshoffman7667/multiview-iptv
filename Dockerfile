FROM node:22-alpine
ENV NODE_ENV=production PORT=1234 DATA_DIR=/data
# ffmpeg: local capture cards, the shared screen and 480p tile transcoding.
# The VA drivers let ffmpeg encode on an Intel (intel-media-driver, Quick Sync) or AMD (mesa-va-gallium) GPU when
# /dev/dri is passed into the container; without a GPU everything falls back to the CPU encoder.
RUN apk add --no-cache su-exec ffmpeg \
 && for pkg in libva-utils mesa-va-gallium intel-media-driver; do apk add --no-cache "$pkg" || echo "note: $pkg is not available for this CPU type"; done
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
