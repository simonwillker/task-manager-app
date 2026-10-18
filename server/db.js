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
  // 3: 管理者フラグ（タスクを削除できるのは管理者だけ）
  //    既存のデータベースでは全員が非管理者になり、誰もタスクを削除できなくなる。
  //    最初に登録したユーザーを管理者にして、必ず1人は削除できる状態にしておく。
  //    それ以外は ADMIN_EMAILS で指定する（起動時に同期される）。
  `
    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
    UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users);
  `,
  // 4: タスクの期日（任意）。"YYYY-MM-DD" の文字列で持つ。
  //    時刻もタイムゾーンも扱わない——「その日まで」しか意味しないため、
  //    UTCミリ秒で持つと端末の時差で1日ずれる。
  `
    ALTER TABLE tasks ADD COLUMN due_date TEXT;
  `,
  // 5: タスクの作業記録。開始ボタンで行を足し、終了ボタンで ended_at を埋める。
  //    ended_at が NULL の行が「いま進行中」。1つのタスクで同時に進行中にできるのは1行まで。
  `
    CREATE TABLE task_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE INDEX idx_task_sessions_task ON task_sessions(task_id);
    CREATE UNIQUE INDEX idx_task_sessions_open ON task_sessions(task_id) WHERE ended_at IS NULL;
  `,
  // 6: タスクのコメント。「終了」を押すたびに作業時間が1行ずつ追記される。編集画面で直せる。
  `
    ALTER TABLE tasks ADD COLUMN comment TEXT NOT NULL DEFAULT '';
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
