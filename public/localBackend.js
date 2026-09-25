/**
 * サーバーを使わない版（GitHub Pages 用）の「API」。
 *
 * server/app.js と同じ method + URL + 本文を受け取り、同じ形の応答を返す。
 * そうすることで、画面まわりのコード（script.js）は2つのモードで共通にできる。
 * 失敗時は status と code を持つ Error を投げる。これも server/app.js に合わせてある。
 *
 * 保存先は localStorage の "taskManagerApp.tasks"。
 * 以前 GitHub Pages で配信していた版と同じキー・同じ形なので、
 * すでに端末に入っているタスクはそのまま引き継がれる（dueDate は後から足した任意項目）。
 */
(() => {
  "use strict";

  const STORAGE_KEY = "taskManagerApp.tasks";
  const DELETE_STATE_KEY = "taskManagerApp.deleteState";
  const MAX_TASK_LENGTH = 200;
  // サーバー版の MAX_IMPORT_TASKS と同じ
  const MAX_IMPORT_TASKS = 1000;

  // サーバー版の DELETE_PASSWORD にあたるもの。
  // 静的配信では値を隠せない（このファイルを読めば分かる）。
  // 「うっかり消さないための合言葉」であって、秘密ではない。
  const DELETE_PASSWORD = "123456";

  // 合言葉を続けて間違えたらしばらく受け付けない。サーバー版と同じ回数・時間にしてある
  const MAX_DELETE_FAILURES = 5;
  const DELETE_LOCK_MS = 15 * 60 * 1000;

  function fail(status, message, code) {
    throw Object.assign(new Error(message), { status, code });
  }

  // ---- 保存 ----

  function readTasks() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // プライベートモードなどで localStorage が使えない
      return [];
    }
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => t && typeof t.id === "string" && typeof t.text === "string").map(normalize);
  }

  /** 古い版が書いた項目にも dueDate と createdAt を補う */
  function normalize(task) {
    return {
      id: task.id,
      text: task.text,
      completed: task.completed === true,
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : 0,
      dueDate: isValidDueDate(task.dueDate) ? task.dueDate : null,
    };
  }

  function writeTasks(tasks) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      fail(507, "端末の保存領域がいっぱいで保存できません");
    }
  }

  /** 一覧はサーバー版と同じ並び（新しいものが上） */
  function sorted(tasks) {
    return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // ---- 入力の確かめ（server/app.js の parseTaskText / parseDueDate と同じ条件） ----

  function parseTaskText(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) fail(400, "タスクを入力してください");
    if (text.length > MAX_TASK_LENGTH) fail(400, `タスクは ${MAX_TASK_LENGTH} 文字以内で入力してください`);
    return text;
  }

  function isValidDueDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  function parseDueDate(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail(400, "期日は YYYY-MM-DD の形式で指定してください");
    }
    if (!isValidDueDate(value)) fail(400, "存在しない日付です");
    return value;
  }

  // ---- 削除の可否 ----

  function readDeleteState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DELETE_STATE_KEY) || "{}");
      return {
        failures: Number.isFinite(parsed.failures) ? parsed.failures : 0,
        lockedUntil: Number.isFinite(parsed.lockedUntil) ? parsed.lockedUntil : 0,
      };
    } catch {
      return { failures: 0, lockedUntil: 0 };
    }
  }

  function writeDeleteState(state) {
    try {
      localStorage.setItem(DELETE_STATE_KEY, JSON.stringify(state));
    } catch {
      // 記録できなくても削除の判定自体は続ける
    }
  }

  /**
   * 合言葉を確かめる。
   *
   * サーバー版の1つ目の条件「管理者であること」は、アカウントが無いこの版では
   * 判定しようがない。この版では「合言葉を知っている人＝消してよい人」として扱う。
   * 端末に入っているデータなので、本当に守りたいものはサーバー版を使うこと。
   */
  function authorizeDelete(body) {
    const state = readDeleteState();
    if (state.lockedUntil > Date.now()) {
      const minutes = Math.ceil((state.lockedUntil - Date.now()) / 60000);
      fail(429, `間違いが続いたため、あと約${minutes}分は削除できません`, "too_many_requests");
    }

    const given = typeof body?.password === "string" ? body.password : "";
    if (given !== DELETE_PASSWORD) {
      const failures = state.failures + 1;
      writeDeleteState({
        failures: failures >= MAX_DELETE_FAILURES ? 0 : failures,
        lockedUntil: failures >= MAX_DELETE_FAILURES ? Date.now() + DELETE_LOCK_MS : 0,
      });
      fail(403, "削除用パスワードが違います", "bad_delete_password");
    }
    writeDeleteState({ failures: 0, lockedUntil: 0 });
  }

  // ---- 振り分け ----

  const TASK_ID_PATTERN = /^\/api\/tasks\/(.+)$/;

  function request(method, url, body) {
    const path = url.split("?")[0];

    if (path === "/api/me" && method === "GET") {
      // ログインが無いので、常に「この端末の利用者」として扱う
      return { user: { email: "この端末", emailVerified: true, isAdmin: true } };
    }

    if (path === "/api/tasks/import" && method === "POST") {
      // サーバー版の importTasks と同じ扱い。既存は消さず、読み込んだぶんを足す。
      // 壊れた期日は捨ててタスク自体は取り込む
      const incoming = Array.isArray(body?.tasks) ? body.tasks : null;
      if (!incoming) fail(400, "リクエストの形式が正しくありません");
      if (incoming.length > MAX_IMPORT_TASKS) {
        fail(400, `一度に取り込めるのは ${MAX_IMPORT_TASKS} 件までです`);
      }

      const now = Date.now();
      const tasks = readTasks();
      for (const item of incoming) {
        if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
        const createdAt = Number(item.createdAt);
        tasks.push({
          id: makeId(),
          text: item.text.trim().slice(0, MAX_TASK_LENGTH),
          completed: item.completed === true,
          createdAt: Number.isFinite(createdAt) && createdAt > 0 && createdAt <= now ? createdAt : now,
          dueDate: isValidDueDate(item.dueDate) ? item.dueDate : null,
        });
      }
      writeTasks(tasks);
      return { tasks: sorted(tasks) };
    }

    if (path === "/api/tasks/clear-completed" && method === "POST") {
      authorizeDelete(body);
      const remaining = readTasks().filter((t) => !t.completed);
      writeTasks(remaining);
      return { tasks: sorted(remaining) };
    }

    if (path === "/api/tasks") {
      if (method === "GET") return { tasks: sorted(readTasks()) };
      if (method === "POST") {
        const text = parseTaskText(body?.text);
        const dueDate = parseDueDate(body?.dueDate);
        const task = { id: makeId(), text, completed: false, createdAt: Date.now(), dueDate };
        const tasks = readTasks();
        tasks.push(task);
        writeTasks(tasks);
        return { task };
      }
      fail(405, "この操作には対応していません");
    }

    const matched = TASK_ID_PATTERN.exec(path);
    if (matched) {
      const id = decodeURIComponent(matched[1]);
      const tasks = readTasks();
      const index = tasks.findIndex((t) => t.id === id);

      if (method === "PATCH") {
        const hasCompleted = body && Object.prototype.hasOwnProperty.call(body, "completed");
        const hasDueDate = body && Object.prototype.hasOwnProperty.call(body, "dueDate");
        if (!hasCompleted && !hasDueDate) fail(400, "変更する内容がありません");
        if (index === -1) fail(404, "タスクが見つかりません");

        if (hasCompleted) {
          if (typeof body.completed !== "boolean") fail(400, "completed には true か false を指定してください");
          tasks[index].completed = body.completed;
        }
        if (hasDueDate) tasks[index].dueDate = parseDueDate(body.dueDate);

        writeTasks(tasks);
        return { task: tasks[index] };
      }

      if (method === "DELETE") {
        // 合言葉を先に確かめる。どのタスクがあるかを当てさせないため、順番はサーバー版と同じ
        authorizeDelete(body);
        if (index === -1) fail(404, "タスクが見つかりません");
        if (!tasks[index].completed) {
          fail(409, "完了していないタスクは削除できません", "task_not_completed");
        }
        tasks.splice(index, 1);
        writeTasks(tasks);
        return null;
      }
    }

    fail(404, "この操作には対応していません");
  }

  window.TaskAppLocalBackend = {
    // script.js の api() と同じく Promise を返す
    request: (method, url, body) => Promise.resolve().then(() => request(method, url, body)),
    STORAGE_KEY,
  };
})();
