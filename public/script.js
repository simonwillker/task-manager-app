(() => {
  "use strict";

  /** 以前のバージョンがタスクを保存していた localStorage のキー（初回ログイン時にアカウントへ取り込む） */
  const LEGACY_STORAGE_KEY = "taskManagerApp.tasks";
  const REQUEST_TIMEOUT_MS = 15000;

  const loading = document.getElementById("loading");

  const authView = document.getElementById("auth-view");
  const authTabs = document.querySelectorAll("[data-mode]");
  const authForm = document.getElementById("auth-form");
  const authEmail = document.getElementById("auth-email");
  const authPassword = document.getElementById("auth-password");
  const authHint = document.getElementById("auth-hint");
  const authError = document.getElementById("auth-error");
  const authSubmit = document.getElementById("auth-submit");

  const taskView = document.getElementById("task-view");
  const userEmail = document.getElementById("user-email");
  const logoutBtn = document.getElementById("logout-btn");
  const form = document.getElementById("task-form");
  const input = document.getElementById("task-input");
  const taskError = document.getElementById("task-error");
  const list = document.getElementById("task-list");
  const emptyState = document.getElementById("empty-state");
  const countLabel = document.getElementById("task-count");
  const clearCompletedBtn = document.getElementById("clear-completed");
  const filterButtons = document.querySelectorAll("[data-filter]");

  /** @type {{id: string, text: string, completed: boolean, createdAt: number}[]} */
  let tasks = [];
  let currentFilter = "all";
  let authMode = "login";
  let signedIn = false;

  // 同じブラウザの別タブへ変更を通知する
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("taskManagerApp") : null;

  function notifyOtherTabs(type) {
    if (channel) channel.postMessage(type);
  }

  // ---- API ----

  async function api(method, url, body) {
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
      throw Object.assign(new Error(message), { status: res.status });
    }
    return data;
  }

  // ---- 画面切り替え ----

  function showMessage(el, message) {
    el.textContent = message || "";
    el.hidden = !message;
  }

  function showAuth() {
    signedIn = false;
    tasks = [];
    loading.hidden = true;
    taskView.hidden = true;
    authView.hidden = false;
  }

  async function showTasks(user) {
    signedIn = true;
    userEmail.textContent = user.email;
    showMessage(taskError, "");
    await run(async () => {
      // 引き継ぎに失敗しても、サーバー上のタスクは表示する（localStorage 側は残るので次回再試行される）
      const importFailed = await importLegacyTasks().then(
        () => false,
        (err) => {
          if (err.status === 401) throw err;
          return true;
        }
      );
      await refreshTasks();
      if (importFailed) {
        showMessage(taskError, "以前のタスクの引き継ぎに失敗しました。再読み込みすると再試行します");
      }
    });
    if (!signedIn) return;
    loading.hidden = true;
    authView.hidden = true;
    taskView.hidden = false;
  }

  /** 操作を実行し、失敗したらメッセージを表示する。セッション切れならログイン画面に戻す */
  async function run(action) {
    showMessage(taskError, "");
    try {
      await action();
    } catch (err) {
      if (err.status === 401) {
        showAuth();
        showMessage(authError, "ログインの有効期限が切れました。もう一度ログインしてください");
        return;
      }
      showMessage(taskError, err.message);
    }
  }

  async function init() {
    try {
      const { user } = await api("GET", "/api/me");
      if (user) await showTasks(user);
      else showAuth();
    } catch (err) {
      showMessage(loading, err.message);
    }
  }

  // ---- 認証 ----

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

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showMessage(authError, "");
    authSubmit.disabled = true;
    try {
      const { user } = await api("POST", authMode === "register" ? "/api/register" : "/api/login", {
        email: authEmail.value,
        password: authPassword.value,
      });
      authPassword.value = "";
      notifyOtherTabs("auth");
      await showTasks(user);
    } catch (err) {
      showMessage(authError, err.message);
    } finally {
      authSubmit.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", () =>
    run(async () => {
      await api("POST", "/api/logout");
      notifyOtherTabs("auth");
      showAuth();
    })
  );

  // ---- タスク ----

  /** 以前のバージョンで localStorage に保存したタスクを、ログイン中のアカウントに移す */
  async function importLegacyTasks() {
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

  async function addTask(text) {
    const data = await api("POST", "/api/tasks", { text });
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

  async function deleteTask(id) {
    try {
      await api("DELETE", `/api/tasks/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    tasks = tasks.filter((t) => t.id !== id);
    afterChange();
  }

  async function clearCompleted() {
    const data = await api("POST", "/api/tasks/clear-completed");
    tasks = data.tasks;
    afterChange();
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

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "task-delete";
      deleteBtn.textContent = "✕";
      deleteBtn.setAttribute("aria-label", "削除");
      deleteBtn.addEventListener("click", () => run(() => deleteTask(task.id)));

      li.appendChild(checkbox);
      li.appendChild(span);
      li.appendChild(deleteBtn);
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
    input.value = "";
    input.focus();
    run(async () => {
      try {
        await addTask(text);
      } catch (err) {
        if (!input.value) input.value = text; // 失敗したら入力内容を戻す
        throw err;
      }
    });
  });

  clearCompletedBtn.addEventListener("click", () => run(clearCompleted));

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
      if (e.data === "auth") init();
      else if (e.data === "tasks" && signedIn) run(refreshTasks);
    });
  }

  // 別の端末で変更された内容を、画面に戻ってきたときに取り込む
  function refreshIfSignedIn() {
    if (signedIn && document.visibilityState === "visible") run(refreshTasks);
  }
  window.addEventListener("focus", refreshIfSignedIn);
  document.addEventListener("visibilitychange", refreshIfSignedIn);

  init();
})();
