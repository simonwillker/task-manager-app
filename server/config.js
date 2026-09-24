"use strict";

const path = require("path");

const MAIL_TRANSPORTS = ["console", "file", "resend"];

/**
 * ADMIN_EMAILS はカンマ区切り。前後の空白を落とし、小文字にそろえて比較する。
 * "@example.com" のように @ で始めると、そのドメインのアドレス全員が管理者になる。
 */
function parseAdminEmails(raw) {
  return (raw || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function positiveInt(name, fallback, env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * 環境変数から設定を読み込み、足りない設定があればエラーにする。
 * @param {NodeJS.ProcessEnv} env
 */
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const port = positiveInt("PORT", 3000, env);

  const config = {
    production,
    port,
    // ローカルでは 127.0.0.1。サーバーやコンテナで公開するときは 0.0.0.0
    host: env.HOST || "127.0.0.1",
    dbPath: env.DB_PATH || path.join(__dirname, "..", "data", "tasks.db"),
    // メール内のリンクに使う公開 URL。Host ヘッダーから組み立てると偽装されるため設定で固定する
    appBaseUrl: (env.APP_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    // HTTPS で配信するとき true（Cookie に Secure を付け、HSTS を返す）
    secureCookies: env.SECURE_COOKIES === "true",
    // リバースプロキシの後ろで動かすとき true（X-Forwarded-For からクライアントの IP を取る）
    trustProxy: env.TRUST_PROXY === "true",
    // プロキシがクライアントの IP を入れるヘッダー名（Fly.io なら fly-client-ip）。TRUST_PROXY より優先する
    clientIpHeader: (env.CLIENT_IP_HEADER || "").trim().toLowerCase(),
    authRateLimitPerIp: positiveInt("AUTH_RATE_LIMIT_PER_IP", 60, env),
    // タスクを削除できる管理者のメールアドレス（カンマ区切り）。
    // 指定が無くても、最初に登録したユーザーは管理者になる（db.js のマイグレーション3）。
    adminEmails: parseAdminEmails(env.ADMIN_EMAILS),
    // タスク削除時に入力させる合言葉。画面には送らず、サーバー側だけで照合する。
    deletePassword: env.DELETE_PASSWORD || "123456",
    mail: {
      transport: env.MAIL_TRANSPORT || "console",
      from: env.MAIL_FROM || "Task Manager <no-reply@example.com>",
      resendApiKey: env.RESEND_API_KEY || "",
      outboxDir: env.MAIL_OUTBOX_DIR || path.join(__dirname, "..", "data", "mail-outbox"),
    },
  };

  const errors = [];
  if (!config.deletePassword) errors.push("DELETE_PASSWORD must not be empty");
  if (!MAIL_TRANSPORTS.includes(config.mail.transport)) {
    errors.push(`MAIL_TRANSPORT must be one of: ${MAIL_TRANSPORTS.join(", ")}`);
  }
  if (config.mail.transport === "resend" && !config.mail.resendApiKey) {
    errors.push("RESEND_API_KEY is required when MAIL_TRANSPORT=resend");
  }
  try {
    new URL(config.appBaseUrl);
  } catch {
    errors.push("APP_BASE_URL must be an absolute URL (e.g. https://tasks.example.com)");
  }

  if (production) {
    if (!env.APP_BASE_URL) errors.push("APP_BASE_URL is required in production");
    else if (!config.appBaseUrl.startsWith("https://")) errors.push("APP_BASE_URL must use https:// in production");
    if (!config.secureCookies) errors.push("SECURE_COOKIES=true is required in production");
    if (config.mail.transport !== "resend") errors.push("MAIL_TRANSPORT=resend is required in production");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
  return config;
}

module.exports = { loadConfig };
