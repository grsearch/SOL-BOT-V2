FROM node:20-bookworm-slim AS builder

WORKDIR /app

# 编译 better-sqlite3 需要 build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 复制 builder 阶段的 node_modules（含原生编译产物）和 dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/schema.sql ./dist/db/schema.sql
COPY package.json ./

# 数据持久化目录（keystore + sqlite）通过 volume 挂载
VOLUME ["/app/data"]
ENV DATABASE_PATH=/app/data/data.db

EXPOSE 3001

CMD ["node", "dist/index.js"]
