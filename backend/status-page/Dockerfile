FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src
COPY public ./public
COPY incidents.json ./incidents.json

USER node
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${STATUS_PORT:-3005}/healthz || exit 1

CMD ["node", "src/server.js"]
