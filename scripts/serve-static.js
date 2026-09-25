#!/usr/bin/env node
/**
 * site/ を配信するだけの小さなサーバー。テストと手元確認に使う。
 * 本番の GitHub Pages はこれを使わない（Pages 側が配信する）。
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "site");
const port = Number(process.env.PORT || 8766);
const host = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

http
  .createServer((req, res) => {
    const requested = decodeURIComponent((req.url || "/").split("?")[0]);
    const relative = requested.endsWith("/") ? `${requested}index.html` : requested;
    // site/ の外へ出さない
    const file = path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  })
  .listen(port, host, () => console.log(`static site: http://${host}:${port}/`));
