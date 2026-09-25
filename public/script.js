(() => {
  "use strict";

  /**
   * 動作モード（mode.js が決める）。
   *   "server" … server/ の API を使う。ログインあり、端末をまたいで同じデータ
   *   "local"  … localBackend.js が localStorage を読み書きする。ログインなし、端末ごと
   * GitHub Pages のような静的配信ではサーバーを動かせないので "local" を使う。
   */
  const LOCAL_MODE = window.TASK_APP_MODE === "local";

  /** 以前のバージョンがタスクを保存していた localStorage のキー（初回ログイン時にアカウントへ取り込む） */
  const LEGACY_STORAGE_KEY = "taskManagerApp.tasks";
  const REQUEST_TIMEOUT_MS = 15000;

  const $ = (id) => document.getElementById(id);

  const views = {
    loading: $("loading"),
    auth: $("auth-view"),
    forgot: $("forgot-view"),
    reset: $("reset-view"),
    verify: $("verify-view"),
    task: $("task-view"),
  };
  const notice = $("notice");

  const authTabs = document.querySelectorAll("[data-mode]");
  const authForm = $("auth-form");
  const authEmail = $("auth-email");
  const authPassword = $("auth-password");
  const authHint = $("auth-hint");
  const authError = $("auth-error");
  const authSubmit = $("auth-submit");

  const forgotForm = $("forgot-form");
  const forgotEmail = $("forgot-email");
  const forgotError = $("forgot-error");
  const forgotSubmit = $("forgot-submit");

  const resetForm = $("reset-form");
  const resetPassword = $("reset-password");
  const resetError = $("reset-error");
  const resetSubmit = $("reset-submit");

  const verifyEmail = $("verify-email");
  const verifyError = $("verify-error");
  const verifyResend = $("verify-resend");

  const userEmail = $("user-email");
  const userBar = document.querySelector(".user-bar");
  const localNote = $("local-note");
  const form = $("task-form");
  const input = $("task-input");
  const dueInput = $("task-due");
  const taskError = $("task-error");
  const list = $("task-list");
  const emptyState = $("empty-state");
  const countLabel = $("task-count");
  const clearCompletedBtn = $("clear-completed");
  const exportBtn = $("export-tasks");
  const importBtn = $("import-tasks");
  const exportDialog = $("export-dialog");
  const exportText = $("export-text");
  const exportNote = $("export-note");
  const exportCopyBtn = $("export-copy");
  const exportDownloadBtn = $("export-download");
  const exportCloseBtn = $("export-close");
  const importDialog = $("import-dialog");
  const importFile = $("import-file");
  const importText = $("import-text");
  const importError = $("import-error");
  const importConfirmBtn = $("import-confirm");
  const importCancelBtn = $("import-cancel");
  const deleteHint = $("delete-hint");
  const deleteDialog = $("delete-dialog");
  const deleteForm = $("delete-form");
  const deleteTarget = $("delete-target");
  const deletePassword = $("delete-password");
  const deleteError = $("delete-error");
  const deleteConfirm = $("delete-confirm");
  const deleteCancel = $("delete-cancel");
  const filterButtons = document.querySelectorAll("[data-filter]");

  /** @type {{id: string, text: string, completed: boolean, createdAt: number}[]} */
  let tasks = [];
  let currentFilter = "all";
  let authMode = "login";
  let signedIn = false;
  /** 管理者だけがタスクを削除できる。実際の可否はサーバーが毎回判定する */
  let isAdmin = false;
  /** 削除ダイアログで「はい」が押されたときに実行する処理 */
  let pendingDelete = null;
  /** メールのリンクから受け取ったパスワード再設定用トークン */
  let resetToken = null;

  // 同じブラウザの別タブへ変更を通知する
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("taskManagerApp") : null;

  function notifyOtherTabs(type) {
    if (channel) channel.postMessage(type);
  }

  // ---- API ----

  async function api(method, url, body) {
    // サーバーを使わない版では、同じ呼び出しを localStorage 側で処理する
    if (LOCAL_MODE) return window.TaskAppLocalBackend.request(method, url, body);

    const headers = { "X-Requested-With": "fetch" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        // 応答が返らないまま画面が止まらないよう、一定時間で打ち切る
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error("サーバーに接続できません。通信環境を確認してください"), { status: 0 });
    }

    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && data.error) || "通信に失敗しました";
      throw Object.assign(new Error(message), { status: res.status, code: data && data.code });
    }
    return data;
  }

  // ---- 画面切り替え ----

  function showMessage(el, message) {
    el.textContent = message || "";
    el.hidden = !message;
  }

  /** 画面を切り替える。画面上部のお知らせは切り替えのたびに差し替える */
  function showView(name, { message = "", kind = "success" } = {}) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    notice.dataset.kind = kind;
    showMessage(notice, message);
  }

  function showAuth(options) {
    signedIn = false;
    isAdmin = false;
    closeDeleteDialog();
    tasks = [];
    list.innerHTML = "";
    showMessage(authError, "");
    showView("auth", options);
  }

  function showVerify(user, options) {
    signedIn = false;
    verifyEmail.textContent = user.email;
    showMessage(verifyError, "");
    showView("verify", options);
  }

  async function showTasks(user, options) {
    signedIn = true;
    isAdmin = user.isAdmin === true;
    // 管理者以外には削除の導線そのものを見せない（サーバー側でも弾いている）
    clearCompletedBtn.hidden = !isAdmin;
    deleteHint.hidden = !isAdmin;
    userEmail.textContent = user.email;
    // ログインが無い版では、アカウント関係の導線を出さない
    userBar.hidden = LOCAL_MODE;
    localNote.hidden = !LOCAL_MODE;
    // 「管理者だけ」はアカウントのある版だけの話。静的版で言うと事実と違う
    deleteHint.textContent = LOCAL_MODE
      ? "完了したタスクのみ、合言葉を入力すると削除できます。"
      : "タスクを削除できるのは管理者だけです。完了したタスクのみ、合言葉を入力すると削除できます。";
    showMessage(taskError, "");
    await run(async () => {
      // 引き継ぎに失敗しても、サーバー上のタスクは表示する（localStorage 側は残るので次回再試行される）
      const importFailed = await importLegacyTasks().then(
        () => false,
        (err) => {
          if (err.status === 401 || err.status === 403) throw err;
          return true;
        }
      );
      await refreshTasks();
      if (importFailed) {
        showMessage(taskError, "以前のタスクの引き継ぎに失敗しました。再読み込みすると再試行します");
      }
    });
    if (!signedIn) return;
    showView("task", options);
  }

  /** タスク画面での操作を実行し、失敗したらメッセージを表示する */
  async function run(action) {
    showMessage(taskError, "");
    try {
      await action();
    } catch (err) {
      if (err.status === 401) {
        showAuth({ message: "ログインの有効期限が切れました。もう一度ログインしてください", kind: "error" });
      } else if (err.code === "email_unverified") {
        await init();
      } else {
        showMessage(taskError, err.message);
      }
    }
  }

  /** フォーム送信中はボタンを無効にし、失敗したらフォーム内にメッセージを表示する */
  async function submitForm(button, errorEl, action) {
    showMessage(errorEl, "");
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      showMessage(errorEl, err.message);
    } finally {
      button.disabled = false;
    }
  }

  /** ログイン状態を確認して、適切な画面を表示する */
  async function init(options) {
    try {
      const { user } = await api("GET", "/api/me");
      if (!user) showAuth(options);
      else if (!user.emailVerified) showVerify(user, options);
      else await showTasks(user, options);
    } catch (err) {
      showView("loading");
      showMessage(views.loading, err.message);
    }
  }

  /** URL の # 以降に付いたメールのリンク（確認・再設定）を処理してから画面を表示する */
  async function start() {
    // メールの確認・再設定リンクはサーバー版だけの仕組み
    if (LOCAL_MODE) return init();

    const params = new URLSearchParams(location.hash.slice(1));
    const verifyToken = params.get("verify");
    const passwordResetToken = params.get("reset");
    if (verifyToken !== null || passwordResetToken !== null) {
      // トークンを履歴やブックマークに残さない
      history.replaceState(null, "", location.pathname + location.search);
    }

    if (passwordResetToken) {
      resetToken = passwordResetToken;
      resetPassword.value = "";
      showMessage(resetError, "");
      showView("reset");
      return;
    }

    if (verifyToken) {
      try {
        await api("POST", "/api/verify-email", { token: verifyToken });
        notifyOtherTabs("auth");
        await init({ message: "メールアドレスを確認しました" });
      } catch (err) {
        await init({ message: err.message, kind: "error" });
      }
      return;
    }

    await init();
  }

  // ---- ログイン / 新規登録 ----

  function setAuthMode(mode) {
    authMode = mode;
    authTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
    const isRegister = mode === "register";
    authSubmit.textContent = isRegister ? "登録する" : "ログイン";
    authPassword.autocomplete = isRegister ? "new-password" : "current-password";
    if (isRegister) authPassword.minLength = 8;
    else authPassword.removeAttribute("minlength");
    authHint.hidden = !isRegister;
    showMessage(authError, "");
  }

  authTabs.forEach((btn) => btn.addEventListener("click", () => setAuthMode(btn.dataset.mode)));

  authForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitForm(authSubmit, authError, async () => {
      const { user } = await api("POST", authMode === "register" ? "/api/register" : "/api/login", {
        email: authEmail.value,
        password: authPassword.value,
      });
      authPassword.value = "";
      notifyOtherTabs("auth");
      if (user.emailVerified) await showTasks(user);
      else showVerify(user);
    });
  });

  document.querySelectorAll("[data-logout]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api("POST", "/api/logout");
      } catch {
        // 通信に失敗しても画面上はログアウトする
      }
      notifyOtherTabs("auth");
      showAuth();
    })
  );

  document.querySelectorAll("[data-back-to-login]").forEach((btn) =>
    btn.addEventListener("click", () => {
      resetToken = null;
      init();
    })
  );

  // ---- メールアドレスの確認 ----

  verifyResend.addEventListener("click", () =>
    submitForm(verifyResend, verifyError, async () => {
      try {
        await api("POST", "/api/verify-email/resend");
      } catch (err) {
        if (err.status === 401) return showAuth();
        throw err;
      }
      showView("verify", { message: "確認メールを再送しました" });
    })
  );

  // ---- パスワード再設定 ----

  $("forgot-link").addEventListener("click", () => {
    forgotEmail.value = authEmail.value;
    showMessage(forgotError, "");
    showView("forgot");
  });

  forgotForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitForm(forgotSubmit, forgotError, async () => {
      await api("POST", "/api/password-reset/request", { email: forgotEmail.value });
      showAuth({
        message:
          "入力したメールアドレスが登録されていれば、パスワード再設定用のメールを送信しました。届かない場合は迷惑メールフォルダも確認してください",
      });
    });
  });

  resetForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitForm(resetSubmit, resetError, async () => {
      const { user } = await api("POST", "/api/password-reset/confirm", {
        token: resetToken,
        password: resetPassword.value,
      });
      resetToken = null;
      resetPassword.value = "";
      notifyOtherTabs("auth");
      await showTasks(user, { message: "パスワードを変更しました" });
    });
  });

  // ---- タスク ----

  /** 以前のバージョンで localStorage に保存したタスクを、ログイン中のアカウントに移す */
  async function importLegacyTasks() {
    // サーバーを使わない版では、この localStorage のキーそのものが保存先。
    // 取り込んで消す相手がいない（消すとタスクが全部なくなる）
    if (LOCAL_MODE) return;

    let legacy;
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
    } catch {
      return; // 読めないデータは消さずに残しておく
    }
    if (!Array.isArray(legacy)) return;
    if (legacy.length > 0) await api("POST", "/api/tasks/import", { tasks: legacy });
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // localStorage が使えない環境では何もしない
    }
  }

  async function refreshTasks() {
    const data = await api("GET", "/api/tasks");
    tasks = data.tasks;
    render();
  }

  /** タスクを変更した後、画面と別タブを最新にする */
  function afterChange() {
    render();
    notifyOtherTabs("tasks");
  }

  async function addTask(text, dueDate) {
    const data = await api("POST", "/api/tasks", { text, dueDate: dueDate || null });
    tasks.unshift(data.task);
    afterChange();
  }

  async function toggleTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    try {
      const data = await api("PATCH", `/api/tasks/${encodeURIComponent(id)}`, { completed: !task.completed });
      tasks = tasks.map((t) => (t.id === id ? data.task : t));
      afterChange();
    } catch (err) {
      // 別の端末で削除済みなら最新の一覧を取り直す
      if (err.status === 404) return refreshTasks();
      throw err;
    }
  }

  async function deleteTask(id, password) {
    try {
      await api("DELETE", `/api/tasks/${encodeURIComponent(id)}`, { password });
    } catch (err) {
      // 既に消えている場合だけは成功扱いにする。権限・未完了・合言葉の誤りは呼び出し元に返す
      if (err.status !== 404) throw err;
    }
    tasks = tasks.filter((t) => t.id !== id);
    afterChange();
  }

  async function clearCompleted(password) {
    const data = await api("POST", "/api/tasks/clear-completed", { password });
    tasks = data.tasks;
    afterChange();
  }

  // ---- 削除の確認ダイアログ ----

  /**
   * 合言葉を聞いてから削除する。
   * @param {string} message 何を消すのかの説明
   * @param {(password: string) => Promise<void>} action
   */
  // ---- 書き出し / 読み込み ----

  /** 書き出す形。version を持たせて、後で形を変えたときに見分けられるようにする */
  const EXPORT_FORMAT = "task-manager-app";
  const EXPORT_VERSION = 1;
  /** サーバー側の MAX_IMPORT_TASKS と同じ。読み込む前に画面側でも弾く */
  const MAX_IMPORT_TASKS = 1000;

  function buildExport() {
    return JSON.stringify(
      {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        tasks: tasks.map((t) => ({
          text: t.text,
          completed: t.completed,
          createdAt: t.createdAt,
          dueDate: t.dueDate || null,
        })),
      },
      null,
      2
    );
  }

  function openExport() {
    exportText.value = buildExport();
    showMessage(exportNote, "");
    exportDialog.showModal();
    // showModal() が textarea に焦点を当てると末尾が見えるので、先頭に戻す
    exportText.scrollTop = 0;
  }

  function downloadExport() {
    const stamp = todayKey();
    const blob = new Blob([exportText.value], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasks-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // すぐ解放すると保存前に切れる環境があるため、少し待ってから開放する
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText.value);
      exportNote.dataset.kind = "success";
      showMessage(exportNote, "コピーしました");
    } catch {
      // 権限が無い環境では選択だけしておき、利用者が自分でコピーする
      exportText.select();
      exportNote.dataset.kind = "error";
      showMessage(exportNote, "コピーできませんでした。選択してあるので手動でコピーしてください");
    }
  }

  /**
   * 読み込む本文を解釈する。書き出した形のほか、タスクの配列だけでも受ける
   * （古い版が localStorage に持っていた形がそれなので、手で移したい人のため）。
   */
  function parseImport(raw) {
    const text = raw.trim();
    if (!text) throw new Error("読み込む内容がありません");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("ファイルの形式が正しくありません");
    }
    const list = Array.isArray(data) ? data : data && data.tasks;
    if (!Array.isArray(list)) throw new Error("タスクが見つかりません");
    const usable = list.filter((t) => t && typeof t.text === "string" && t.text.trim());
    if (usable.length === 0) throw new Error("取り込めるタスクがありません");
    if (usable.length > MAX_IMPORT_TASKS) {
      throw new Error(`一度に読み込めるのは ${MAX_IMPORT_TASKS} 件までです`);
    }
    return usable;
  }

  function openImport() {
    importFile.value = "";
    importText.value = "";
    showMessage(importError, "");
    importDialog.showModal();
  }

  async function runImport() {
    showMessage(importError, "");
    let raw = importText.value;
    if (importFile.files && importFile.files[0]) raw = await importFile.files[0].text();

    let list;
    try {
      list = parseImport(raw);
    } catch (err) {
      showMessage(importError, err.message);
      return;
    }

    importConfirmBtn.disabled = true;
    try {
      const data = await api("POST", "/api/tasks/import", { tasks: list });
      tasks = data.tasks;
      importDialog.close();
      afterChange();
      showMessage(taskError, "");
    } catch (err) {
      showMessage(importError, err.message);
    } finally {
      importConfirmBtn.disabled = false;
    }
  }

  exportBtn.addEventListener("click", openExport);
  exportCopyBtn.addEventListener("click", copyExport);
  exportDownloadBtn.addEventListener("click", downloadExport);
  exportCloseBtn.addEventListener("click", () => exportDialog.close());
  importBtn.addEventListener("click", openImport);
  importCancelBtn.addEventListener("click", () => importDialog.close());
  importConfirmBtn.addEventListener("click", runImport);

  function confirmDelete(message, action) {
    pendingDelete = action;
    deleteTarget.textContent = message;
    deletePassword.value = "";
    showMessage(deleteError, "");
    deleteDialog.showModal();
    deletePassword.focus();
  }

  function closeDeleteDialog() {
    pendingDelete = null;
    deletePassword.value = "";
    if (deleteDialog.open) deleteDialog.close();
  }

  /** きょうの日付を "YYYY-MM-DD" で返す（UTCではなく端末のローカル日付） */
  function todayKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 期日の見出し。きょう・あすは日付より言葉のほうが早く読める */
  function dueLabel(dueDate) {
    const today = todayKey();
    if (dueDate === today) return "きょうまで";
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const tKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    if (dueDate === tKey) return "あすまで";
    const [y, m, d] = dueDate.split("-");
    return `${Number(m)}/${Number(d)} まで`;
  }

  function getFilteredTasks() {
    if (currentFilter === "active") return tasks.filter((t) => !t.completed);
    if (currentFilter === "completed") return tasks.filter((t) => t.completed);
    return tasks;
  }

  function render() {
    const filtered = getFilteredTasks();
    list.innerHTML = "";

    filtered.forEach((task) => {
      const li = document.createElement("li");
      li.className = "task-item" + (task.completed ? " completed" : "");
      li.dataset.id = task.id;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "task-checkbox";
      checkbox.checked = task.completed;
      checkbox.setAttribute("aria-label", "完了にする");
      checkbox.addEventListener("change", () => run(() => toggleTask(task.id)));

      const span = document.createElement("span");
      span.className = "task-text";
      span.textContent = task.text;
      span.addEventListener("click", () => run(() => toggleTask(task.id)));

      li.appendChild(checkbox);
      li.appendChild(span);

      if (task.dueDate) {
        const due = document.createElement("span");
        due.className = "task-due";
        // 未完了で期日を過ぎたものだけ目立たせる。完了済みを赤くしても意味が無い
        if (!task.completed && task.dueDate < todayKey()) {
          due.classList.add("overdue");
          due.title = "期日を過ぎています";
        } else if (!task.completed && task.dueDate === todayKey()) {
          due.classList.add("today");
        }
        due.textContent = dueLabel(task.dueDate);
        li.appendChild(due);
      }

      // 削除は「管理者」かつ「完了済み」のときだけ。未完了のあいだはボタンを押せなくして
      // 理由を出す（消えていると、なぜ消せないのか分からないため）
      if (isAdmin) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "task-delete";
        deleteBtn.textContent = "✕";
        deleteBtn.setAttribute("aria-label", "削除");
        if (!task.completed) {
          deleteBtn.disabled = true;
          deleteBtn.title = "完了していないタスクは削除できません";
        } else {
          deleteBtn.addEventListener("click", () =>
            confirmDelete(`「${task.text}」を削除します。`, (password) => deleteTask(task.id, password))
          );
        }
        li.appendChild(deleteBtn);
      }

      list.appendChild(li);
    });

    emptyState.hidden = filtered.length !== 0;

    const activeCount = tasks.filter((t) => !t.completed).length;
    countLabel.textContent = `${tasks.length} 件のタスク（未完了 ${activeCount} 件）`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const dueDate = dueInput.value;
    input.value = "";
    dueInput.value = "";
    input.focus();
    run(async () => {
      try {
        await addTask(text, dueDate);
      } catch (err) {
        // 失敗したら入力内容を戻す（期日も一緒に戻さないと入れ直しになる）
        if (!input.value) {
          input.value = text;
          dueInput.value = dueDate;
        }
        throw err;
      }
    });
  });

  clearCompletedBtn.addEventListener("click", () => {
    const done = tasks.filter((t) => t.completed).length;
    if (done === 0) return showMessage(taskError, "完了済みのタスクがありません");
    showMessage(taskError, "");
    confirmDelete(`完了済みの ${done} 件をまとめて削除します。`, (password) => clearCompleted(password));
  });

  deleteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const action = pendingDelete;
    const password = deletePassword.value;
    if (!action) return closeDeleteDialog();
    submitForm(deleteConfirm, deleteError, async () => {
      await action(password);
      closeDeleteDialog();
    });
  });

  deleteCancel.addEventListener("click", closeDeleteDialog);
  // Esc で閉じたときも、入力した合言葉を残さない
  deleteDialog.addEventListener("close", () => {
    pendingDelete = null;
    deletePassword.value = "";
  });

  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      render();
    });
  });

  // ---- 他のタブ・端末との同期 ----

  if (channel) {
    channel.addEventListener("message", (e) => {
      // パスワード再設定の入力中は画面を切り替えない
      if (e.data === "auth" && views.reset.hidden && views.forgot.hidden) init();
      else if (e.data === "tasks" && signedIn) run(refreshTasks);
    });
  }

  // 画面に戻ってきたとき、別の端末での変更やメールアドレスの確認を取り込む
  function refreshOnReturn() {
    if (document.visibilityState !== "visible") return;
    if (signedIn) run(refreshTasks);
    else if (!views.verify.hidden) init();
  }
  window.addEventListener("focus", refreshOnReturn);
  document.addEventListener("visibilitychange", refreshOnReturn);
  window.addEventListener("hashchange", start);

  start();
})();
