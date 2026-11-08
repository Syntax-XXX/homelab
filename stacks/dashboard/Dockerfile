FROM node:22-alpine
WORKDIR /app
COPY server.js telegram.js overrides.json bookmarks.json ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
RUN apk add --no-cache ipmitool
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
