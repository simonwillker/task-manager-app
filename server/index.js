"use strict";

const http = require("http");
const path = require("path");
const { loadConfig } = require("./config");
const { openDatabase } = require("./db");
const { createMailer } = require("./mailer");
const { createApp } = require("./app");

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const server = http.createServer(
  createApp({
    db,
    publicDir: path.join(__dirname, "..", "public"),
    mailer: createMailer(config.mail),
    appBaseUrl: config.appBaseUrl,
    secureCookies: config.secureCookies,
    trustProxy: config.trustProxy,
    authRateLimitPerIp: config.authRateLimitPerIp,
  })
);

server.listen(config.port, config.host, () => {
  console.log(`Task Manager listening on http://${config.host}:${config.port} (db: ${config.dbPath})`);
  if (config.mail.transport === "console") {
    console.log("MAIL_TRANSPORT=console: メールは送信されず、このログに出力されます");
  }
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
