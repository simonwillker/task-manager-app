"use strict";

const http = require("http");
const path = require("path");
const { openDatabase } = require("./db");
const { createApp } = require("./app");

const PORT = Number(process.env.PORT || 3000);
// ローカルでは 127.0.0.1。サーバーやコンテナで公開するときは HOST=0.0.0.0 を指定する
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "tasks.db");
// HTTPS で配信するときは SECURE_COOKIES=true を指定する
const SECURE_COOKIES = process.env.SECURE_COOKIES === "true";

const db = openDatabase(DB_PATH);
const server = http.createServer(
  createApp({ db, publicDir: path.join(__dirname, "..", "public"), secureCookies: SECURE_COOKIES })
);

server.listen(PORT, HOST, () => {
  console.log(`Task Manager listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
