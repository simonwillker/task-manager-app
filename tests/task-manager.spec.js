// @ts-check
const { test, expect } = require("@playwright/test");

/** 各テストは空の localStorage から開始する */
test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

/** タスクを順番に追加するヘルパー */
async function addTasks(page, texts) {
  for (const text of texts) {
    await page.fill("#task-input", text);
    await page.click(".btn-primary");
  }
}

test.describe("初期状態", () => {
  test("タスクが無いとき空メッセージと 0 件表示になる", async ({ page }) => {
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.locator("#task-count")).toHaveText("0 件のタスク（未完了 0 件）");
    await expect(page.locator(".task-item")).toHaveCount(0);
  });
});

test.describe("タスクの追加", () => {
  test("追加したタスクが先頭に積まれ、件数表示が更新される", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);

    await expect(page.locator(".task-item")).toHaveCount(3);
    await expect(page.locator(".task-text").first()).toHaveText("ジムに行く");
    await expect(page.locator("#task-count")).toHaveText("3 件のタスク（未完了 3 件）");
    await expect(page.locator("#empty-state")).toBeHidden();
  });

  test("空白のみの入力は追加されない", async ({ page }) => {
    await page.fill("#task-input", "   ");
    await page.click(".btn-primary");

    await expect(page.locator(".task-item")).toHaveCount(0);
  });

  test("追加後に入力欄がクリアされる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う"]);

    await expect(page.locator("#task-input")).toHaveValue("");
  });
});

test.describe("完了状態の切り替え", () => {
  test("チェックすると完了スタイルが付き、未完了数が減る", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await page.locator(".task-item").first().locator(".task-checkbox").check();

    await expect(page.locator(".task-item").first()).toHaveClass(/completed/);
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
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);
    await page.locator(".task-item").nth(1).locator(".task-checkbox").check();
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
  test("✕ ボタンで個別に削除できる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await page.locator(".task-item").first().locator(".task-delete").click();

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator(".task-text").first()).toHaveText("牛乳を買う");
  });

  test("完了済みを一括削除できる", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く", "ジムに行く"]);
    await page.locator(".task-item").nth(0).locator(".task-checkbox").check();
    await page.locator(".task-item").nth(2).locator(".task-checkbox").check();

    await page.click("#clear-completed");

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator("#task-count")).toHaveText("1 件のタスク（未完了 1 件）");
  });
});

test.describe("永続化", () => {
  test("リロードしてもタスクと完了状態が保持される", async ({ page }) => {
    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await page.locator(".task-item").first().locator(".task-checkbox").check();

    await page.reload();

    await expect(page.locator(".task-item")).toHaveCount(2);
    await expect(page.locator(".task-item.completed")).toHaveCount(1);
    await expect(page.locator("#task-count")).toHaveText("2 件のタスク（未完了 1 件）");
  });

  test("localStorage の内容が壊れていても落ちずに空状態で起動する", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("taskManagerApp.tasks", "{ではないJSON"));
    await page.reload();

    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.locator(".task-item")).toHaveCount(0);
  });
});

test.describe("セキュリティ", () => {
  test("HTML を含む入力はテキストとして表示される (XSS 対策)", async ({ page }) => {
    const payload = "<img src=x onerror=alert(1)>";
    await addTasks(page, [payload]);

    await expect(page.locator(".task-text").first()).toHaveText(payload);
    await expect(page.locator(".task-list img")).toHaveCount(0);
  });
});

test.describe("レイアウト", () => {
  test("モバイル幅で横スクロールが発生しない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
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

    await addTasks(page, ["牛乳を買う", "レポートを書く"]);
    await page.locator(".task-item").first().locator(".task-checkbox").check();
    await page.click('[data-filter="active"]');
    await page.click('[data-filter="completed"]');
    await page.click('[data-filter="all"]');
    await page.click("#clear-completed");
    await page.locator(".task-item").first().locator(".task-delete").click();

    expect(errors).toEqual([]);
  });
});
