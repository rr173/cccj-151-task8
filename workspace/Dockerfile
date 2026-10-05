FROM node:20-alpine

# 零第三方依赖：仅用 Node 内置 http / test / crypto
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY adapters ./adapters
COPY scripts ./scripts

RUN mkdir -p /app/data && adduser -D -u 10001 duty && chown -R duty:duty /app
USER duty

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    SEED_ON_START=1 \
    ENABLE_DEV_TOOLS=1

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
