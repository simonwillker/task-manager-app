"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 日
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TASK_LENGTH = 200;
const MAX_IMPORT_TASKS = 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function setSecurityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
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
  throw new HttpError(400, "リクエストの形式が正しくありません");
}

function parseCredentials(body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, "メールアドレスの形式が正しくありません");
  }
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, "パスワードを入力してください");
  }
  return { email, password };
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

/**
 * HTTP リクエストハンドラーを作成する。
 * @param {{ db: import("node:sqlite").DatabaseSync, publicDir: string, secureCookies?: boolean }} options
 */
function createApp({ db, publicDir, secureCookies = false }) {
  const rootDir = path.resolve(publicDir);
  // 存在しないユーザーでもパスワード照合と同じ時間をかけ、登録有無を推測されにくくする
  const dummyHashPromise = hashPassword(crypto.randomBytes(16).toString("hex"));

  const stmts = {
    insertUser: db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)"),
    findUserByEmail: db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    findSessionUser: db.prepare(`
      SELECT users.id, users.email FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    listTasks: db.prepare(`
      SELECT id, text, completed, created_at FROM tasks
      WHERE user_id = ? ORDER BY created_at DESC, rowid DESC
    `),
    findTask: db.prepare("SELECT id, text, completed, created_at FROM tasks WHERE id = ? AND user_id = ?"),
    insertTask: db.prepare(
      "INSERT INTO tasks (id, user_id, text, completed, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    updateTaskCompleted: db.prepare("UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?"),
    deleteTask: db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?"),
    deleteCompletedTasks: db.prepare("DELETE FROM tasks WHERE user_id = ? AND completed = 1"),
  };

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
    return token ? stmts.findSessionUser.get(sha256(token), Date.now()) || null : null;
  }

  function startSession(req, res, userId) {
    // 以前のセッションは破棄する（セッション固定攻撃の対策）
    const previous = sessionToken(req);
    if (previous) stmts.deleteSession.run(sha256(previous));

    const now = Date.now();
    stmts.deleteExpiredSessions.run(now);
    const token = crypto.randomBytes(32).toString("base64url");
    stmts.insertSession.run(sha256(token), userId, now + SESSION_TTL_MS);
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
  }

  function listTasks(userId) {
    return stmts.listTasks.all(userId).map(toTask);
  }

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async function register(req, res) {
    const { email, password } = parseCredentials(await readJson(req));
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください`);
    }
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
    startSession(req, res, userId);
    sendJson(res, 201, { user: { email } });
  }

  async function login(req, res) {
    const { email, password } = parseCredentials(await readJson(req));
    const user = stmts.findUserByEmail.get(email);
    const valid = await verifyPassword(password, user ? user.password_hash : await dummyHashPromise);
    if (!user || !valid) {
      throw new HttpError(401, "メールアドレスまたはパスワードが違います");
    }
    startSession(req, res, user.id);
    sendJson(res, 200, { user: { email: user.email } });
  }

  function logout(req, res) {
    const token = sessionToken(req);
    if (token) stmts.deleteSession.run(sha256(token));
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    sendNoContent(res);
  }

  async function createTask(req, res, user) {
    const text = parseTaskText((await readJson(req)).text);
    const id = crypto.randomUUID();
    stmts.insertTask.run(id, user.id, text, 0, Date.now());
    sendJson(res, 201, { task: toTask(stmts.findTask.get(id, user.id)) });
  }

  /** ブラウザの localStorage に残っていた以前のタスクをアカウントに取り込む */
  async function importTasks(req, res, user) {
    const { tasks } = await readJson(req);
    if (!Array.isArray(tasks)) throw new HttpError(400, "リクエストの形式が正しくありません");
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

  async function updateTask(req, res, user, id) {
    const { completed } = await readJson(req);
    if (typeof completed !== "boolean") {
      throw new HttpError(400, "リクエストの形式が正しくありません");
    }
    const { changes } = stmts.updateTaskCompleted.run(completed ? 1 : 0, id, user.id);
    if (changes === 0) throw new HttpError(404, "タスクが見つかりません");
    sendJson(res, 200, { task: toTask(stmts.findTask.get(id, user.id)) });
  }

  function deleteTask(res, user, id) {
    const { changes } = stmts.deleteTask.run(id, user.id);
    if (changes === 0) throw new HttpError(404, "タスクが見つかりません");
    sendNoContent(res);
  }

  function clearCompleted(res, user) {
    stmts.deleteCompletedTasks.run(user.id);
    sendJson(res, 200, { tasks: listTasks(user.id) });
  }

  async function handleApi(req, res, pathname) {
    const { method } = req;

    // CSRF 対策: 変更系リクエストはカスタムヘッダー必須（クロスサイトからは CORS で送れない）
    if (method !== "GET" && method !== "HEAD" && req.headers["x-requested-with"] !== "fetch") {
      throw new HttpError(403, "不正なリクエストです");
    }

    if (pathname === "/api/register" && method === "POST") return register(req, res);
    if (pathname === "/api/login" && method === "POST") return login(req, res);
    if (pathname === "/api/logout" && method === "POST") return logout(req, res);

    const user = currentUser(req);
    if (pathname === "/api/me" && method === "GET") {
      return sendJson(res, 200, { user: user ? { email: user.email } : null });
    }
    if (!user) throw new HttpError(401, "ログインしてください");

    if (pathname === "/api/tasks") {
      if (method === "GET") return sendJson(res, 200, { tasks: listTasks(user.id) });
      if (method === "POST") return createTask(req, res, user);
    }
    if (pathname === "/api/tasks/import" && method === "POST") return importTasks(req, res, user);
    if (pathname === "/api/tasks/clear-completed" && method === "POST") return clearCompleted(res, user);

    const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "PATCH") return updateTask(req, res, user, id);
      if (method === "DELETE") return deleteTask(res, user, id);
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
      sendJson(res, known ? err.status : 500, {
        error: known ? err.message : "サーバーでエラーが発生しました",
      });
    }
  };
}

module.exports = { createApp };
