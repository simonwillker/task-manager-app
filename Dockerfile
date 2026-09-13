# node:sqlite を使うため Node.js 22.13 以上が必要
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/tasks.db

WORKDIR /app

# 実行時の依存パッケージはないため、アプリのファイルだけをコピーする
COPY package.json ./
COPY server ./server
COPY public ./public

# DB はボリューム（/data）に置き、root 以外のユーザーで動かす
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server/index.js"]
