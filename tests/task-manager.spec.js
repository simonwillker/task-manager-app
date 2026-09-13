// @ts-check
const { test, expect } = require("@playwright/test");

const PASSWORD = "password123";
const API_HEADERS = { "X-Requested-With": "fetch" };

/** テストごとに重複しないメールアドレスを作る */
function uniqueEmail() {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** 画面から新規登録し、タスク画面が表示されるまで待つ */
async function register(page, email = uniqueEmail(), password = PASSWORD) {
  await page.goto("/");
  await page.click('[data-mode="register"]');
  await page.fill("#auth-email", email);
  await page.fill("#auth-password", password);
  await page.click("#auth-submit");
  await expect(page.locator("#task-view")).toBeVisible();
  return { email, password };
}

/** 画面からログインし、タスク画面が表示されるまで待つ */
async function login(page, email, password = PASSWORD) {
  await page.goto("/");
  await page.fill("#auth-email", email);
  await page.fill("#auth-password", password);
  await page.click("#auth-submit");
  await expect(page.locator("#task-view")).toBeVisible();
}

/** タスクを順番に追加し、それぞれがサーバーに保存されて表示されるまで待つ */
async function addTasks(page, texts) {
  for (const text of texts) {
    await page.fill("#task-input", text);
    await page.click("#task-form .btn-primary");
    await expect(page.locator(".task-text").first()).toHaveText(text);
  }
}

/** n 番目のタスクを完了にし、保存されるまで待つ */
async function completeTask(page, index) {
  const item = page.locator(".task-item").nth(index);
  await item.locator(".task-checkbox").check();
  await expect(item).toHaveClass(/completed/);
}

test.describe("認証", () => {
  test("未ログインのときはログイン画面が表示される", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#auth-view")).toBeVisible();
    await expect(page.locator("#task-view")).toBeHidden();
  });

  test("新規登録するとタスク画面に切り替わり、メールアドレスが表示される", async ({ page }) => {
    const { email } = await register(page);

    await expect(page.locator("#user-email")).toHaveText(email);
  });

  test("登録済みのメールアドレスでは登録できない", async ({ page, browser, baseURL }) => {
    const { email } = await register(page);

    const other = await browser.newContext({ baseURL });
    const otherPage = await other.newPage();
    await otherPage.goto("/");
    await otherPage.click('[data-mode="register"]');
    await otherPage.fill("#auth-email", email);
    await otherPage.fill("#auth-password", PASSWORD);
    await otherPage.click("#auth-submit");

    await expect(otherPage.locator("#auth-error")).toHaveText("このメールアドレスは既に登録されています");
    await other.close();
  });

  test("8 文字未満のパスワードは登録できない", async ({ request }) => {
    const res = await request.post("/api/register", {
      headers: API_HEADERS,
      data: { email: uniqueEmail(), password: "short" },
    });

    expect(res.status()).toBe(400);
  });

  test("パスワードが違うとログインできない", async ({ page, browser, baseURL }) => {
    const { email } = await register(page);

    const other = await browser.newContext({ baseURL });
    const otherPage = await other.newPage();
    await otherPage.goto("/");
    await otherPage.fill("#auth-email", email);
    await otherPage.fill("#auth-password", "wrong-password");
    await otherPage.click("#auth-submit");

    await expect(otherPage.locator("#auth-error")).toHaveText("メールアドレスまたはパスワードが違います");
    await expect(otherPage.locator("#task-view")).toBeHidden();
    await other.close();
  });

  test("ログアウトするとログイン画面に戻り、リロードしてもログアウトしたまま", async ({ page }) => {
    await register(page);
    await page.click("#logout-btn");

    await expect(page.locator("#auth-view")).toBeVisible();
    await page.reload();
    await expect(page.locator("#auth-view")).toBeVisible();
    await expect(page.locator("#task-view")).toBeHidden();
  });

  test("未ログインでは API からタスクを取得できない", async ({ request }) => {
    const res = await request.get("/api/tasks");

    expect(res.status()).toBe(401);
  });

  test("X-Requested-With ヘッダーの無い変更リクエストは拒否される (CSRF 対策)", async ({ page }) => {
    await register(page);

    const res = await page.request.post("/api/tasks", { data: { text: "不正なタスク" } });

    expect(res.status()).toBe(403);
  });
});

test.describe("初期状態", () => {
  test("タスクが無いとき空メッセージと 0 件表示になる", async ({ page }) => {
    await register(page);

    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.locator("#task-count")).toHaveText("0 件のタスク（未完了 0 件）");
    await expect(page.locator(".task-item")).toHaveCount(0);
  });
});

test.describe("タスクの追加", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
  });

  test("追加したタスクが先頭に積まれ、件数表示が更新される", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);

    await expect(page.locator(".task-item")).toHaveCount(3);
    await expect(page.locator(".task-text").first()).toHaveText("ジムに行く");
    await expect(page.locator("#task-count")).toHaveText("3 件のタスク（未完了 3 件）");
    await expect(page.locator("#empty-state")).toBeHidden();
  });

  test("空白のみの入力は追加されない", async ({ page }) => {
    await page.fill("#task-input", "   ");
    await page.click("#task-form .btn-primary");

    await expect(page.locator(".task-item")).toHaveCount(0);
  });

  test("追加後に入力欄がクリアされる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う"]);

    await expect(page.locator("#task-input")).toHaveValue("");
  });
});

test.describe("完了状態の切り替え", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
  });

  test("チェックすると完了スタイルが付き、未完了数が減る", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await completeTask(page, 0);

    await expect(page.locator("#task-count")).toHaveText("2 件のタスク（未完了 1 件）");
  });

  test("テキストのクリックでも切り替えられる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う"]);
    await page.locator(".task-text").first().click();

    await expect(page.locator(".task-item").first()).toHaveClass(/completed/);
  });
});

test.describe("フィルタ", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);
    await completeTask(page, 1);
  });

  test("[未完了] は未完了のタスクのみ表示する", async ({ page }) => {
    await page.click('[data-filter="active"]');

    await expect(page.locator(".task-item")).toHaveCount(2);
    await expect(page.locator(".task-item.completed")).toHaveCount(0);
  });

  test("[完了済み] は完了したタスクのみ表示する", async ({ page }) => {
    await page.click('[data-filter="completed"]');

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator(".task-text").first()).toHaveText("レポートを書く");
  });

  test("[すべて] で全件表示に戻る", async ({ page }) => {
    await page.click('[data-filter="completed"]');
    await page.click('[data-filter="all"]');

    await expect(page.locator(".task-item")).toHaveCount(3);
  });

  test("選択したフィルタに active クラスが付く", async ({ page }) => {
    await page.click('[data-filter="active"]');

    await expect(page.locator('[data-filter="active"]')).toHaveClass(/active/);
    await expect(page.locator('[data-filter="all"]')).not.toHaveClass(/active/);
  });
});

test.describe("削除", () => {
  test.beforeEach(async ({ page }) => {
    await register(page);
  });

  test("✕ ボタンで個別に削除できる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await page.locator(".task-item").first().locator(".task-delete").click();

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator(".task-text").first()).toHaveText("牛乳を買う");
  });

  test("完了済みを一括削除できる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);
    await completeTask(page, 0);
    await completeTask(page, 2);

    await page.click("#clear-completed");

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator("#task-count")).toHaveText("1 件のタスク（未完了 1 件）");
  });
});

test.describe("データベースへの保存", () => {
  test("リロードしてもタスクと完了状態が保持される", async ({ page }) => {
    await register(page);
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await completeTask(page, 0);

    await page.reload();

    await expect(page.locator(".task-item")).toHaveCount(2);
    await expect(page.locator(".task-item.completed")).toHaveCount(1);
    await expect(page.locator("#task-count")).toHaveText("2 件のタスク（未完了 1 件）");
  });

  test("別の端末（別ブラウザ）でログインしても同じタスクが表示される", async ({ page, browser, baseURL }) => {
    const { email } = await register(page);
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await completeTask(page, 1);

    const device = await browser.newContext({ baseURL });
    const devicePage = await device.newPage();
    await login(devicePage, email);

    await expect(devicePage.locator(".task-text")).toHaveText(["レポートを書く", "牛乳を買う"]);
    await expect(devicePage.locator(".task-item.completed")).toHaveCount(1);
    await device.close();
  });

  test("他のユーザーのタスクは表示・操作できない", async ({ page, browser, baseURL }) => {
    await register(page);
    await addTasks(page, ["自分だけのタスク"]);
    const taskId = await page.locator(".task-item").first().getAttribute("data-id");

    const other = await browser.newContext({ baseURL });
    const otherPage = await other.newPage();
    await register(otherPage);
    await expect(otherPage.locator("#empty-state")).toBeVisible();

    const res = await otherPage.request.delete(`/api/tasks/${taskId}`, { headers: API_HEADERS });
    expect(res.status()).toBe(404);
    await other.close();

    await page.reload();
    await expect(page.locator(".task-text")).toHaveText(["自分だけのタスク"]);
  });

  test("同じブラウザの別タブでの変更がリロードなしで反映される", async ({ page, context }) => {
    await register(page);
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.locator("#task-view")).toBeVisible();

    await addTasks(other, ["別タブのタスク"]);

    await expect(page.locator(".task-text")).toHaveText(["別タブのタスク"]);
    await expect(page.locator("#task-count")).toHaveText("1 件のタスク（未完了 1 件）");
  });

  test("以前 localStorage に保存していたタスクがログイン後にアカウントへ引き継がれる", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem(
        "taskManagerApp.tasks",
        JSON.stringify([
          { id: "a", text: "以前のタスク", completed: true, createdAt: 2 },
          null,
          { id: "b", text: "もっと前のタスク", completed: false, createdAt: 1 },
        ])
      )
    );

    await register(page);

    await expect(page.locator(".task-text")).toHaveText(["以前のタスク", "もっと前のタスク"]);
    await expect(page.locator(".task-item.completed")).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("taskManagerApp.tasks"))).toBeNull();

    await page.reload();
    await expect(page.locator(".task-item")).toHaveCount(2);
  });
});

test.describe("セキュリティ", () => {
  test("HTML を含む入力はテキストとして表示される (XSS 対策)", async ({ page }) => {
    await register(page);
    const payload = "<img src=x onerror=alert(1)>";
    await addTasks(page, [payload]);

    await expect(page.locator(".task-text").first()).toHaveText(payload);
    await expect(page.locator(".task-list img")).toHaveCount(0);
  });

  test("public ディレクトリ外のファイルは配信されない", async ({ request }) => {
    for (const path of ["/../server/app.js", "/%2e%2e/package.json", "/..%2fserver%2fdb.js"]) {
      const res = await request.get(path);
      expect([403, 404]).toContain(res.status());
    }
  });
});

test.describe("レイアウト", () => {
  test("モバイル幅で横スクロールが発生しない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await register(page, `very-long-email-address-for-layout-${Date.now()}@example.com`);
    await addTasks(page, ["とても長いタスク名のテストでレイアウトが崩れないことを確認する"]);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(overflows).toBe(false);
  });
});

test.describe("コンソール", () => {
  test("一連の操作で JS エラーが発生しない", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await register(page);
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await completeTask(page, 0);
    await page.click('[data-filter="active"]');
    await page.click('[data-filter="completed"]');
    await page.click('[data-filter="all"]');
    await page.click("#clear-completed");
    await expect(page.locator(".task-item")).toHaveCount(1);
    await page.locator(".task-item").first().locator(".task-delete").click();
    await expect(page.locator(".task-item")).toHaveCount(0);
    await page.click("#logout-btn");
    await expect(page.locator("#auth-view")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
