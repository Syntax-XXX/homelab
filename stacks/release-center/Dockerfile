FROM ghcr.io/gitleaks/gitleaks:v8.28.0 AS gitleaks
FROM node:22-alpine
RUN apk add --no-cache git
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
WORKDIR /app
COPY server.js ./
COPY public ./public
USER node
ENV DATA_DIR=/data
CMD ["node", "server.js"]
