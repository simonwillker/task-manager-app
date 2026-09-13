// @ts-check
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { RateLimiter } = require("../server/rate-limit");

const PASSWORD = "password123";
const API_HEADERS = { "X-Requested-With": "fetch" };
/** playwright.config.js の MAIL_OUTBOX_DIR と同じ場所 */
const MAIL_OUTBOX_DIR = path.join(__dirname, "..", "test-results", "mail-outbox");

/** テストごとに重複しないメールアドレスを作る */
function uniqueEmail() {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** テスト用サーバーが指定アドレス宛に送ったメールを、送信順に返す */
function readMails(to, subject) {
  let files;
  try {
    files = fs.readdirSync(MAIL_OUTBOX_DIR).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(MAIL_OUTBOX_DIR, file), "utf8"));
      } catch {
        return null; // 書き込み途中のファイルは次の確認で読む
      }
    })
    .filter((mail) => mail && mail.to === to && mail.subject.includes(subject));
}

/** 指定アドレス宛のメールが count 通届くまで待ち、最後のメールに書かれたリンクを返す */
async function waitForMailLink(to, subject, count = 1) {
  let link = "";
  await expect
    .poll(
      () => {
        const mails = readMails(to, subject);
        if (mails.length < count) return "";
        link = mails[mails.length - 1].text.match(/https?:\/\/\S+/)[0];
        return link;
      },
      { message: `${to} 宛の「${subject}」メールが ${count} 通届く` }
    )
    .toBeTruthy();
  return link;
}

/** 画面から新規登録し、メールアドレスの確認待ち画面が表示されるまで待つ */
async function registerUnverified(page, email = uniqueEmail(), password = PASSWORD) {
  await page.goto("/");
  await page.click('[data-mode="register"]');
  await page.fill("#auth-email", email);
  await page.fill("#auth-password", password);
  await page.click("#auth-submit");
  await expect(page.locator("#verify-view")).toBeVisible();
  return { email, password };
}

/** 画面から新規登録し、確認メールのリンクを開いてタスク画面が表示されるまで待つ */
async function register(page, email = uniqueEmail(), password = PASSWORD) {
  await registerUnverified(page, email, password);
  await page.goto(await waitForMailLink(email, "メールアドレスの確認"));
  await expect(page.locator("#task-view")).toBeVisible();
  return { email, password };
}

/** API で新規登録する（メールアドレスは未確認のまま） */
async function registerViaApi(request, email = uniqueEmail(), password = PASSWORD) {
  const res = await request.post("/api/register", { headers: API_HEADERS, data: { email, password } });
  expect(res.status()).toBe(201);
  return { email, password };
}

function loginViaApi(request, email, password) {
  return request.post("/api/login", { headers: API_HEADERS, data: { email, password } });
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
    await page.click("#task-view [data-logout]");

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

test.describe("メールアドレスの確認", () => {
  test("登録直後は確認待ち画面になり、タスク API は使えない", async ({ page }) => {
    const { email } = await registerUnverified(page);

    await expect(page.locator("#verify-email")).toHaveText(email);
    const res = await page.request.get("/api/tasks");
    expect(res.status()).toBe(403);
  });

  test("確認メールのリンクを別タブで開くと、元のタブもタスク画面に切り替わる", async ({ page, context }) => {
    const { email } = await registerUnverified(page);
    const link = await waitForMailLink(email, "メールアドレスの確認");

    const mailTab = await context.newPage();
    await mailTab.goto(link);

    await expect(mailTab.locator("#task-view")).toBeVisible();
    await expect(mailTab.locator("#notice")).toHaveText("メールアドレスを確認しました");
    expect(new URL(mailTab.url()).hash).toBe(""); // トークンを URL に残さない
    await expect(page.locator("#task-view")).toBeVisible();
  });

  test("ログインしていない端末で確認リンクを開くと、ログイン画面に確認完了が表示される", async ({
    page,
    browser,
    baseURL,
  }) => {
    const { email } = await registerUnverified(page);
    const link = await waitForMailLink(email, "メールアドレスの確認");

    const device = await browser.newContext({ baseURL });
    const devicePage = await device.newPage();
    await devicePage.goto(link);

    await expect(devicePage.locator("#auth-view")).toBeVisible();
    await expect(devicePage.locator("#notice")).toHaveText("メールアドレスを確認しました");
    await device.close();
  });

  test("無効な確認リンクではエラーが表示される", async ({ page }) => {
    await page.goto("/#verify=invalid-token");

    await expect(page.locator("#notice")).toContainText("リンクが無効");
    await expect(page.locator("#auth-view")).toBeVisible();
  });

  test("確認メールを再送でき、送りすぎると制限される", async ({ page }) => {
    const { email } = await registerUnverified(page);
    const resend = async () => {
      const response = page.waitForResponse("**/api/verify-email/resend");
      await page.click("#verify-resend");
      return (await response).status();
    };

    expect(await resend()).toBe(204);
    await expect(page.locator("#notice")).toHaveText("確認メールを再送しました");
    expect(await resend()).toBe(204);
    // 登録時の 1 通 + 再送 2 通で、1 時間の上限 3 通に達する
    expect(await resend()).toBe(429);
    await expect(page.locator("#verify-error")).toContainText("試行回数が多すぎます");

    // 最新のリンクで確認できる
    await page.goto(await waitForMailLink(email, "メールアドレスの確認", 3));
    await expect(page.locator("#task-view")).toBeVisible();
  });
});

test.describe("パスワード再設定", () => {
  test("メールのリンクから新しいパスワードを設定すると、ログインされ他の端末はログアウトされる", async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    const { email } = await register(page);
    await addTasks(page, ["消えてはいけないタスク"]);

    const device = await browser.newContext({ baseURL });
    const devicePage = await device.newPage();
    await devicePage.goto("/");
    await devicePage.click("#forgot-link");
    await devicePage.fill("#forgot-email", email);
    await devicePage.click("#forgot-submit");
    await expect(devicePage.locator("#auth-view")).toBeVisible();
    await expect(devicePage.locator("#notice")).toContainText("パスワード再設定用のメールを送信しました");

    await devicePage.goto(await waitForMailLink(email, "パスワードの再設定"));
    await expect(devicePage.locator("#reset-view")).toBeVisible();
    await devicePage.fill("#reset-password", "new-password-456");
    await devicePage.click("#reset-submit");

    await expect(devicePage.locator("#task-view")).toBeVisible();
    await expect(devicePage.locator("#notice")).toHaveText("パスワードを変更しました");
    await expect(devicePage.locator(".task-text")).toHaveText(["消えてはいけないタスク"]);
    await device.close();

    // 元の端末のログインは無効になる
    await page.reload();
    await expect(page.locator("#auth-view")).toBeVisible();

    expect((await loginViaApi(request, email, PASSWORD)).status()).toBe(401);
    expect((await loginViaApi(request, email, "new-password-456")).status()).toBe(200);
  });

  test("再設定リンクは 1 回しか使えず、使うとメールアドレスも確認済みになる", async ({ request }) => {
    const { email } = await registerViaApi(request);
    await request.post("/api/password-reset/request", { headers: API_HEADERS, data: { email } });
    const token = new URL(await waitForMailLink(email, "パスワードの再設定")).hash.replace("#reset=", "");

    const first = await request.post("/api/password-reset/confirm", {
      headers: API_HEADERS,
      data: { token, password: "new-password-456" },
    });
    expect(first.status()).toBe(200);
    expect((await first.json()).user.emailVerified).toBe(true);

    const second = await request.post("/api/password-reset/confirm", {
      headers: API_HEADERS,
      data: { token, password: "another-password-789" },
    });
    expect(second.status()).toBe(400);
  });

  test("未登録のメールアドレスでも同じ応答を返し、メールは送らない", async ({ request }) => {
    const email = uniqueEmail();
    const res = await request.post("/api/password-reset/request", { headers: API_HEADERS, data: { email } });

    expect(res.status()).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readMails(email, "パスワードの再設定")).toHaveLength(0);
  });
});

test.describe("回数制限", () => {
  test("ログインに 5 回失敗すると、正しいパスワードでもしばらくログインできない", async ({ request }) => {
    const { email } = await registerViaApi(request);

    for (let i = 0; i < 5; i++) {
      expect((await loginViaApi(request, email, "wrong-password")).status()).toBe(401);
    }
    const locked = await loginViaApi(request, email, PASSWORD);

    expect(locked.status()).toBe(429);
    expect(Number(locked.headers()["retry-after"])).toBeGreaterThan(0);
    expect((await locked.json()).error).toContain("試行回数が多すぎます");
  });

  test("ログインに成功すると失敗回数はリセットされる", async ({ request }) => {
    const { email } = await registerViaApi(request);

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) {
        expect((await loginViaApi(request, email, "wrong-password")).status()).toBe(401);
      }
      expect((await loginViaApi(request, email, PASSWORD)).status()).toBe(200);
    }
  });

  test("ロック中はログイン画面にメッセージが表示される", async ({ page, request }) => {
    const { email } = await registerViaApi(request);
    for (let i = 0; i < 5; i++) await loginViaApi(request, email, "wrong-password");

    await page.goto("/");
    await page.fill("#auth-email", email);
    await page.fill("#auth-password", PASSWORD);
    await page.click("#auth-submit");

    await expect(page.locator("#auth-error")).toContainText("試行回数が多すぎます");
  });

  test("パスワード再設定メールは同じアドレスに 1 時間 3 回まで", async ({ request }) => {
    const email = uniqueEmail();
    const requestReset = () =>
      request.post("/api/password-reset/request", { headers: API_HEADERS, data: { email } });

    for (let i = 0; i < 3; i++) expect((await requestReset()).status()).toBe(204);
    expect((await requestReset()).status()).toBe(429);
  });

  test("CLIENT_IP_HEADER（Fly.io の Fly-Client-IP）の IP アドレスごとに回数を数える", async () => {
    const http = require("http");
    const { openDatabase } = require("../server/db");
    const { createApp } = require("../server/app");

    const server = http.createServer(
      createApp({
        db: openDatabase(":memory:"),
        publicDir: path.join(__dirname, "..", "public"),
        mailer: { send: async () => {} },
        appBaseUrl: "http://127.0.0.1",
        clientIpHeader: "fly-client-ip",
        authRateLimitPerIp: 2,
      })
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("net").AddressInfo} */ (server.address());
    const loginFrom = async (ip) => {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/login`, {
        method: "POST",
        headers: { ...API_HEADERS, "Content-Type": "application/json", "Fly-Client-IP": ip },
        body: JSON.stringify({ email: uniqueEmail(), password: "wrong-password" }),
      });
      return res.status;
    };

    try {
      expect(await loginFrom("198.51.100.1")).toBe(401);
      expect(await loginFrom("198.51.100.1")).toBe(401);
      expect(await loginFrom("198.51.100.1")).toBe(429);
      // 同じ接続元（127.0.0.1）でも、ヘッダーの IP が違えば別に数える
      expect(await loginFrom("198.51.100.2")).toBe(401);
    } finally {
      server.close();
    }
  });

  test("RateLimiter は上限に達するとウィンドウが終わるまで拒否する", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });

    limiter.hit("ip", 0);
    expect(limiter.retryAfterMs("ip", 10)).toBe(0);
    limiter.hit("ip", 20);
    expect(limiter.retryAfterMs("ip", 500)).toBe(500);
    expect(limiter.retryAfterMs("other-ip", 500)).toBe(0);
    expect(limiter.retryAfterMs("ip", 1000)).toBe(0);

    limiter.prune(1000);
    expect(limiter.entries.size).toBe(0);
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

test.describe("運用", () => {
  test("ヘルスチェック API が応答する", async ({ request }) => {
    const res = await request.get("/api/health");

    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
    await page.click("#task-view [data-logout]");
    await expect(page.locator("#auth-view")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
