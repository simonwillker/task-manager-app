"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { RateLimiter } = require("./rate-limit");

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 日
const VERIFY_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 時間
const RESET_PASSWORD_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 時間
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TASK_LENGTH = 200;
const MAX_IMPORT_TASKS = 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MINUTE = 60 * 1000;
/** ログイン・登録などの API（IP アドレスごとの回数制限の対象） */
const AUTH_PATHS = new Set([
  "/api/register",
  "/api/login",
  "/api/verify-email",
  "/api/verify-email/resend",
  "/api/password-reset/request",
  "/api/password-reset/confirm",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  /** @param {{ code?: string, retryAfterSeconds?: number }} [extra] */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = extra.code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

const invalidRequest = () => new HttpError(400, "リクエストの形式が正しくありません");
const invalidLink = () => new HttpError(400, "リンクが無効か、有効期限が切れています。もう一度やり直してください");

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split("$");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** 長さや先頭の一致具合から中身を推測されないよう、一定時間で文字列を比べる */
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  // 長さが違うと crypto.timingSafeEqual が例外を投げるので、同じ長さに畳んでから比べる
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res) {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "リクエストが大きすぎます");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // 下で 400 を返す
  }
  throw invalidRequest();
}

function parseEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, "メールアドレスの形式が正しくありません");
  }
  return email;
}

function parseCredentials(body) {
  const email = parseEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, "パスワードを入力してください");
  }
  return { email, password };
}

/** 新しく設定するパスワードの長さを確認する */
function parseNewPassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `パスワードは ${MAX_PASSWORD_LENGTH} 文字以内にしてください`);
  }
  return password;
}

function parseToken(value) {
  if (typeof value !== "string" || !value || value.length > 100) throw invalidLink();
  return value;
}

function parseTaskText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, "タスクを入力してください");
  if (text.length > MAX_TASK_LENGTH) {
    throw new HttpError(400, `タスクは ${MAX_TASK_LENGTH} 文字以内で入力してください`);
  }
  return text;
}

function toTask(row) {
  return {
    id: row.id,
    text: row.text,
    completed: Boolean(row.completed),
    createdAt: row.created_at,
  };
}

function toPublicUser(row) {
  return {
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    // 画面の出し分けに使う。実際の可否はサーバー側で毎回確かめる
    isAdmin: Boolean(row.is_admin),
  };
}

/**
 * HTTP リクエストハンドラーを作成する。
 * @param {{
 *   db: import("node:sqlite").DatabaseSync,
 *   publicDir: string,
 *   mailer: { send(message: { to: string, subject: string, text: string }): Promise<void> },
 *   appBaseUrl: string,
 *   secureCookies?: boolean,
 *   trustProxy?: boolean,
 *   clientIpHeader?: string,
 *   authRateLimitPerIp?: number,
 *   adminEmails?: string[],
 *   deletePassword?: string,
 * }} options
 */
function createApp({
  db,
  publicDir,
  mailer,
  appBaseUrl,
  secureCookies = false,
  trustProxy = false,
  clientIpHeader = "",
  authRateLimitPerIp = 60,
  adminEmails = [],
  deletePassword = "",
}) {
  const rootDir = path.resolve(publicDir);
  // 存在しないユーザーでもパスワード照合と同じ時間をかけ、登録有無を推測されにくくする
  const dummyHashPromise = hashPassword(randomToken());

  const limiters = {
    // 登録・ログインなど認証系 API へのリクエスト数（IP アドレスごと）
    authPerIp: new RateLimiter({ max: authRateLimitPerIp, windowMs: 15 * MINUTE }),
    // ログインの失敗回数（IP アドレス + メールアドレスごと）
    loginFailures: new RateLimiter({ max: 5, windowMs: 15 * MINUTE }),
    // 確認メール・再設定メールの送信回数（大量送信の防止）
    verifyEmails: new RateLimiter({ max: 3, windowMs: 60 * MINUTE }),
    resetEmails: new RateLimiter({ max: 3, windowMs: 60 * MINUTE }),
    // 削除パスワードの誤り回数（IP アドレス + ユーザーごと）。
    // 短い合言葉なので、総当たりされないようにここで止める。
    deleteFailures: new RateLimiter({ max: 5, windowMs: 15 * MINUTE }),
  };
  setInterval(() => Object.values(limiters).forEach((limiter) => limiter.prune()), MINUTE).unref();

  const stmts = {
    insertUser: db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)"),
    findUserById: db.prepare("SELECT id, email, email_verified_at, is_admin FROM users WHERE id = ?"),
    findUserByEmail: db.prepare(
      "SELECT id, email, password_hash, email_verified_at, is_admin FROM users WHERE email = ?"
    ),
    markEmailVerified: db.prepare(
      "UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL"
    ),
    updatePassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
    setAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ? AND is_admin != ?"),
    firstUserId: db.prepare("SELECT MIN(id) AS id FROM users"),

    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    findSessionUser: db.prepare(`
      SELECT users.id, users.email, users.email_verified_at, users.is_admin FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),

    insertEmailToken: db.prepare(
      "INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)"
    ),
    findEmailToken: db.prepare(`
      SELECT users.id, users.email FROM email_tokens
      JOIN users ON users.id = email_tokens.user_id
      WHERE email_tokens.token_hash = ? AND email_tokens.purpose = ? AND email_tokens.expires_at > ?
    `),
    deleteEmailTokens: db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?"),
    deleteAllEmailTokens: db.prepare("DELETE FROM email_tokens WHERE user_id = ?"),
    deleteExpiredEmailTokens: db.prepare("DELETE FROM email_tokens WHERE expires_at <= ?"),

    listTasks: db.prepare(`
      SELECT id, text, completed, created_at FROM tasks
      WHERE user_id = ? ORDER BY created_at DESC, rowid DESC
    `),
    findTask: db.prepare("SELECT id, text, completed, created_at FROM tasks WHERE id = ? AND user_id = ?"),
    insertTask: db.prepare(
      "INSERT INTO tasks (id, user_id, text, completed, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    updateTaskCompleted: db.prepare("UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?"),
    deleteTask: db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ? AND completed = 1"),
    deleteCompletedTasks: db.prepare("DELETE FROM tasks WHERE user_id = ? AND completed = 1"),
  };

  /** ADMIN_EMAILS に載っているか。"@example.com" 形式ならドメイン全体が対象 */
  function isAdminEmail(email) {
    const value = String(email).toLowerCase();
    return adminEmails.some((entry) =>
      entry.startsWith("@") ? value.endsWith(entry) : value === entry
    );
  }

  /** 最初に登録したユーザーの id（まだ誰もいなければ null） */
  function firstUserId() {
    const row = stmts.firstUserId.get();
    return row && row.id !== null ? Number(row.id) : null;
  }

  /** ADMIN_EMAILS に載っているユーザーを管理者にする（外れたら外す）。起動時とログイン・登録時に呼ぶ */
  function syncAdmin(user) {
    if (!user) return user;
    // ADMIN_EMAILS が未設定のときは触らない（最初に登録したユーザーが管理者のまま）
    if (adminEmails.length === 0) return user;
    // 設定されているときは、その一覧だけが管理者。ここで増減を反映する
    const shouldBeAdmin = isAdminEmail(user.email) ? 1 : 0;
    if (Boolean(user.is_admin) !== Boolean(shouldBeAdmin)) {
      stmts.setAdmin.run(shouldBeAdmin, user.id, shouldBeAdmin);
      return { ...user, is_admin: shouldBeAdmin };
    }
    return user;
  }

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function setSecurityHeaders(res) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  // ---- 回数制限 ----

  function clientIp(req) {
    if (clientIpHeader) {
      const value = req.headers[clientIpHeader];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    if (trustProxy) {
      // リバースプロキシが末尾に追加した値を使う（先頭側はクライアントが偽装できる）
      const forwarded = String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (forwarded.length > 0) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress || "unknown";
  }

  /** 回数制限に達していたら 429 を返す */
  function enforceLimit(limiter, key) {
    const ms = limiter.retryAfterMs(key);
    if (ms > 0) {
      throw new HttpError(
        429,
        `試行回数が多すぎます。${Math.ceil(ms / MINUTE)} 分ほど待ってからもう一度お試しください`,
        { retryAfterSeconds: Math.ceil(ms / 1000) }
      );
    }
  }

  // ---- セッション ----

  function sessionCookie(value, maxAgeSeconds) {
    return [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
      secureCookies && "Secure",
    ]
      .filter(Boolean)
      .join("; ");
  }

  function sessionToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  }

  function currentUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const user = stmts.findSessionUser.get(sha256(token), Date.now()) || null;
    return syncAdmin(user);
  }

  function startSession(req, res, userId) {
    // 以前のセッションは破棄する（セッション固定攻撃の対策）
    const previous = sessionToken(req);
    if (previous) stmts.deleteSession.run(sha256(previous));

    const now = Date.now();
    stmts.deleteExpiredSessions.run(now);
    const token = randomToken();
    stmts.insertSession.run(sha256(token), userId, now + SESSION_TTL_MS);
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
  }

  // ---- メール ----

  /** メール内リンク用のトークンを発行する（同じ用途の古いリンクは無効になる） */
  function issueEmailToken(userId, purpose, ttlMs) {
    const now = Date.now();
    stmts.deleteExpiredEmailTokens.run(now);
    stmts.deleteEmailTokens.run(userId, purpose);
    const token = randomToken();
    stmts.insertEmailToken.run(sha256(token), userId, purpose, now + ttlMs);
    return token;
  }

  /** メールを送る。送信の成否や所要時間から登録有無を推測されないよう、完了を待たずに応答する */
  function deliver(message) {
    mailer.send(message).catch((err) => console.error("Failed to send email:", err));
  }

  function sendVerificationEmail(user) {
    limiters.verifyEmails.hit(String(user.id));
    const token = issueEmailToken(user.id, "verify_email", VERIFY_EMAIL_TOKEN_TTL_MS);
    deliver({
      to: user.email,
      subject: "【タスク管理】メールアドレスの確認",
      text: [
        "タスク管理アプリへのご登録ありがとうございます。",
        "",
        "以下のリンクを開いて、メールアドレスの確認を完了してください（24 時間有効）。",
        `${appBaseUrl}/#verify=${token}`,
        "",
        "お心当たりがない場合は、このメールを破棄してください。",
      ].join("\n"),
    });
  }

  function sendPasswordResetEmail(user) {
    const token = issueEmailToken(user.id, "reset_password", RESET_PASSWORD_TOKEN_TTL_MS);
    deliver({
      to: user.email,
      subject: "【タスク管理】パスワードの再設定",
      text: [
        "パスワード再設定のリクエストを受け付けました。",
        "",
        "以下のリンクを開いて、新しいパスワードを設定してください（1 時間有効）。",
        `${appBaseUrl}/#reset=${token}`,
        "",
        "お心当たりがない場合は、このメールを破棄してください。パスワードは変更されません。",
      ].join("\n"),
    });
  }

  // ---- 認証 API ----

  async function register(req, res) {
    const body = await readJson(req);
    const { email } = parseCredentials(body);
    const password = parseNewPassword(body.password);
    const alreadyRegistered = new HttpError(409, "このメールアドレスは既に登録されています");
    if (stmts.findUserByEmail.get(email)) throw alreadyRegistered;

    const passwordHash = await hashPassword(password);
    let userId;
    try {
      userId = Number(stmts.insertUser.run(email, passwordHash, Date.now()).lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/.test(String(err.message))) throw alreadyRegistered;
      throw err;
    }
    // ADMIN_EMAILS が無い環境では、最初に登録したユーザーを管理者にする。
    // そうしないと誰もタスクを削除できないアプリになってしまう。
    if (adminEmails.length === 0 && firstUserId() === userId) stmts.setAdmin.run(1, userId, 1);
    startSession(req, res, userId);
    const user = syncAdmin(stmts.findUserById.get(userId));
    sendVerificationEmail(user);
    sendJson(res, 201, { user: toPublicUser(user) });
  }

  async function login(req, res) {
    const { email, password } = parseCredentials(await readJson(req));
    const failureKey = `${clientIp(req)}|${email}`;
    enforceLimit(limiters.loginFailures, failureKey);

    const user = stmts.findUserByEmail.get(email);
    const valid = await verifyPassword(password, user ? user.password_hash : await dummyHashPromise);
    if (!user || !valid) {
      limiters.loginFailures.hit(failureKey);
      throw new HttpError(401, "メールアドレスまたはパスワードが違います");
    }
    limiters.loginFailures.reset(failureKey);
    startSession(req, res, user.id);
    sendJson(res, 200, { user: toPublicUser(syncAdmin(user)) });
  }

  function logout(req, res) {
    const token = sessionToken(req);
    if (token) stmts.deleteSession.run(sha256(token));
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    sendNoContent(res);
  }

  async function verifyEmail(req, res) {
    const token = parseToken((await readJson(req)).token);
    const user = stmts.findEmailToken.get(sha256(token), "verify_email", Date.now());
    if (!user) throw invalidLink();
    transaction(() => {
      stmts.markEmailVerified.run(Date.now(), user.id);
      stmts.deleteEmailTokens.run(user.id, "verify_email");
    });
    sendJson(res, 200, { email: user.email });
  }

  function resendVerification(res, user) {
    if (user.email_verified_at !== null) throw new HttpError(400, "メールアドレスは確認済みです");
    enforceLimit(limiters.verifyEmails, String(user.id));
    sendVerificationEmail(user);
    sendNoContent(res);
  }

  async function requestPasswordReset(req, res) {
    const email = parseEmail((await readJson(req)).email);
    // 登録の有無にかかわらず同じ回数で制限し、同じ応答を返す（登録有無を推測されないようにする）
    enforceLimit(limiters.resetEmails, email);
    limiters.resetEmails.hit(email);
    const user = stmts.findUserByEmail.get(email);
    if (user) sendPasswordResetEmail(user);
    sendNoContent(res);
  }

  async function confirmPasswordReset(req, res) {
    const body = await readJson(req);
    const token = parseToken(body.token);
    const passwordHash = await hashPassword(parseNewPassword(body.password));

    const user = transaction(() => {
      const found = stmts.findEmailToken.get(sha256(token), "reset_password", Date.now());
      if (!found) return null;
      stmts.updatePassword.run(passwordHash, found.id);
      // メールのリンクを開けた = メールアドレスの持ち主なので、確認済みにする
      stmts.markEmailVerified.run(Date.now(), found.id);
      stmts.deleteAllEmailTokens.run(found.id);
      // 他の端末に残っているログインはすべて無効にする
      stmts.deleteUserSessions.run(found.id);
      return found;
    });
    if (!user) throw invalidLink();

    limiters.loginFailures.reset(`${clientIp(req)}|${user.email}`);
    startSession(req, res, user.id);
    sendJson(res, 200, { user: toPublicUser(stmts.findUserById.get(user.id)) });
  }

  // ---- タスク API ----

  async function createTask(req, res, user) {
    const text = parseTaskText((await readJson(req)).text);
    const id = crypto.randomUUID();
    stmts.insertTask.run(id, user.id, text, 0, Date.now());
    sendJson(res, 201, { task: toTask(stmts.findTask.get(id, user.id)) });
  }

  /** ブラウザの localStorage に残っていた以前のタスクをアカウントに取り込む */
  async function importTasks(req, res, user) {
    const { tasks } = await readJson(req);
    if (!Array.isArray(tasks)) throw invalidRequest();
    if (tasks.length > MAX_IMPORT_TASKS) {
      throw new HttpError(400, `一度に取り込めるのは ${MAX_IMPORT_TASKS} 件までです`);
    }

    const now = Date.now();
    transaction(() => {
      for (const item of tasks) {
        if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
        const createdAt = Number(item.createdAt);
        stmts.insertTask.run(
          crypto.randomUUID(),
          user.id,
          item.text.trim().slice(0, MAX_TASK_LENGTH),
          item.completed === true ? 1 : 0,
          Number.isFinite(createdAt) && createdAt > 0 && createdAt <= now ? createdAt : now
        );
      }
    });
    sendJson(res, 200, { tasks: listTasks(user.id) });
  }

  function listTasks(userId) {
    return stmts.listTasks.all(userId).map(toTask);
  }

  async function updateTask(req, res, user, id) {
    const { completed } = await readJson(req);
    if (typeof completed !== "boolean") throw invalidRequest();
    const { changes } = stmts.updateTaskCompleted.run(completed ? 1 : 0, id, user.id);
    if (changes === 0) throw new HttpError(404, "タスクが見つかりません");
    sendJson(res, 200, { task: toTask(stmts.findTask.get(id, user.id)) });
  }

  /**
   * タスクを削除してよいかを確かめる。3つとも満たさないと削除させない。
   *   1. 管理者であること
   *   2. （個別削除のとき）そのタスクが完了していること
   *   3. 削除用パスワードが合っていること
   * 画面側でもボタンを出し分けるが、判定はここが本番。API を直接叩かれても通らない。
   */
  function authorizeDelete(req, user, body) {
    if (!user.is_admin) {
      throw new HttpError(403, "タスクを削除できるのは管理者だけです", { code: "not_admin" });
    }
    // 短い合言葉なので、誤りが続いたらしばらく受け付けない
    const failureKey = `${clientIp(req)}|${user.id}`;
    enforceLimit(limiters.deleteFailures, failureKey);

    const given = typeof body?.password === "string" ? body.password : "";
    if (!timingSafeEqual(given, deletePassword)) {
      limiters.deleteFailures.hit(failureKey);
      throw new HttpError(403, "削除用パスワードが違います", { code: "bad_delete_password" });
    }
    limiters.deleteFailures.reset(failureKey);
  }

  async function deleteTask(req, res, user, id) {
    authorizeDelete(req, user, await readJson(req));

    const task = stmts.findTask.get(id, user.id);
    if (!task) throw new HttpError(404, "タスクが見つかりません");
    if (!task.completed) {
      throw new HttpError(409, "完了していないタスクは削除できません", { code: "task_not_completed" });
    }

    // SQL 側でも completed = 1 を条件にしてある（確認と削除の間に未完了へ戻された場合の保険）
    const { changes } = stmts.deleteTask.run(id, user.id);
    if (changes === 0) throw new HttpError(409, "完了していないタスクは削除できません", { code: "task_not_completed" });
    sendNoContent(res);
  }

  async function clearCompleted(req, res, user) {
    // まとめて消すほうも同じ扱いにしないと、1件ずつの制限を素通りできてしまう
    authorizeDelete(req, user, await readJson(req));
    stmts.deleteCompletedTasks.run(user.id);
    sendJson(res, 200, { tasks: listTasks(user.id) });
  }

  // ---- ルーティング ----

  async function handleApi(req, res, pathname) {
    const { method } = req;

    if (pathname === "/api/health" && method === "GET") {
      db.prepare("SELECT 1").get();
      return sendJson(res, 200, { ok: true });
    }

    // CSRF 対策: 変更系リクエストはカスタムヘッダー必須（クロスサイトからは CORS で送れない）
    if (method !== "GET" && method !== "HEAD" && req.headers["x-requested-with"] !== "fetch") {
      throw new HttpError(403, "不正なリクエストです");
    }

    if (AUTH_PATHS.has(pathname) && method === "POST") {
      const ip = clientIp(req);
      enforceLimit(limiters.authPerIp, ip);
      limiters.authPerIp.hit(ip);
    }

    if (method === "POST") {
      if (pathname === "/api/register") return register(req, res);
      if (pathname === "/api/login") return login(req, res);
      if (pathname === "/api/logout") return logout(req, res);
      if (pathname === "/api/verify-email") return verifyEmail(req, res);
      if (pathname === "/api/password-reset/request") return requestPasswordReset(req, res);
      if (pathname === "/api/password-reset/confirm") return confirmPasswordReset(req, res);
    }

    const user = currentUser(req);
    if (pathname === "/api/me" && method === "GET") {
      return sendJson(res, 200, { user: user ? toPublicUser(user) : null });
    }
    if (!user) throw new HttpError(401, "ログインしてください");

    if (pathname === "/api/verify-email/resend" && method === "POST") return resendVerification(res, user);

    if (user.email_verified_at === null) {
      throw new HttpError(403, "メールアドレスの確認が必要です", { code: "email_unverified" });
    }

    if (pathname === "/api/tasks") {
      if (method === "GET") return sendJson(res, 200, { tasks: listTasks(user.id) });
      if (method === "POST") return createTask(req, res, user);
    }
    if (pathname === "/api/tasks/import" && method === "POST") return importTasks(req, res, user);
    if (pathname === "/api/tasks/clear-completed" && method === "POST") return clearCompleted(req, res, user);

    const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "PATCH") return updateTask(req, res, user, id);
      if (method === "DELETE") return deleteTask(req, res, user, id);
    }

    throw new HttpError(404, "見つかりません");
  }

  function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, "Bad Request");
    }
    if (decoded.includes("\0")) return sendText(res, 400, "Bad Request");

    const filePath = path.resolve(rootDir, "." + (decoded === "/" ? "/index.html" : decoded));
    // public ディレクトリ外（DB ファイルやサーバーコード）へのアクセスを拒否する
    if (!filePath.startsWith(rootDir + path.sep)) return sendText(res, 403, "Forbidden");

    fs.readFile(filePath, (err, data) => {
      if (err) return sendText(res, 404, "Not Found");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  return async function handleRequest(req, res) {
    setSecurityHeaders(res);
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
      } else if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res, pathname);
      } else {
        sendText(res, 405, "Method Not Allowed");
      }
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error(err);
      if (res.headersSent) return res.end();
      if (known && err.retryAfterSeconds) res.setHeader("Retry-After", String(err.retryAfterSeconds));
      sendJson(res, known ? err.status : 500, {
        error: known ? err.message : "サーバーでエラーが発生しました",
        ...(known && err.code ? { code: err.code } : {}),
      });
    }
  };
}

module.exports = { createApp };
