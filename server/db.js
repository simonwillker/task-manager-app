"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

/**
 * スキーマの変更履歴。先頭から順に 1 回だけ適用され、適用済みの番号は PRAGMA user_version に記録される。
 * 既存の手順は書き換えず、変更するときは末尾に追加すること。
 */
const MIGRATIONS = [
  // 1: ユーザー・セッション・タスク
  `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text       TEXT    NOT NULL,
      completed  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at);
  `,
  // 2: メールアドレスの確認とパスワード再設定（既存ユーザーは確認済みとして扱う）
  `
    ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
    UPDATE users SET email_verified_at = created_at;

    CREATE TABLE email_tokens (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose    TEXT    NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);
  `,
];

/** SQLite データベースを開き、未適用のマイグレーションを実行する（":memory:" も指定可） */
function openDatabase(filename) {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const { user_version: currentVersion } = db.prepare("PRAGMA user_version").get();
  for (let version = currentVersion + 1; version <= MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version - 1]);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${version} failed: ${err.message}`);
    }
  }
  return db;
}

module.exports = { openDatabase };
