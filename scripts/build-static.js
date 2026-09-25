#!/usr/bin/env node
/**
 * GitHub Pages 用の静的サイトを site/ に組み立てる。
 *
 * public/ をそのまま写したうえで、mode.js だけ "local" 版に差し替える。
 * これでサーバーの API ではなく localBackend.js（localStorage）を使う版になる。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "public");
const out = path.join(root, "site");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

fs.writeFileSync(
  path.join(out, "mode.js"),
  [
    "// scripts/build-static.js が生成。GitHub Pages ではサーバーを動かせないため、",
    "// localStorage だけで動く版にする。編集しても次のビルドで上書きされる。",
    'window.TASK_APP_MODE = "local";',
    "",
  ].join("\n")
);

// Jekyll に処理させない（_ で始まるファイルが無視されるのを防ぐ）
fs.writeFileSync(path.join(out, ".nojekyll"), "");

const files = fs.readdirSync(out).sort();
console.log(`site/ を作成しました: ${files.join(", ")}`);
