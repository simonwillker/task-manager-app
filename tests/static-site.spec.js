// @ts-check
/**
 * GitHub Pages 用の静的版（site/）のテスト。
 * サーバーもログインも無く、localStorage だけで動くことを確かめる。
 */
const { test, expect } = require("@playwright/test");

const STORAGE_KEY = "taskManagerApp.tasks";
const DELETE_PASSWORD = "123456";

/** 端末に残っているデータの影響を受けないよう、毎回まっさらにしてから開く */
async function open(page, seed) {
  await page.goto("/index.html");
  await page.evaluate(
    ([key, tasks]) => {
      localStorage.clear();
      if (tasks) localStorage.setItem(key, JSON.stringify(tasks));
    },
    [STORAGE_KEY, seed || null]
  );
  await page.reload();
  await expect(page.locator("#task-view")).toBeVisible();
}

async function addTask(page, text, due) {
  await page.fill("#task-input", text);
  if (due) await page.fill("#task-due", due);
  await page.click("#task-form .btn-primary");
  await expect(page.locator(".task-text", { hasText: text })).toBeVisible();
}

/** 表示されているタスクの「×」を押し、合言葉を入れて確定する */
async function deleteTask(page, text, password) {
  await page.locator(".task-item", { hasText: text }).locator(".task-delete").click();
  await page.fill("#delete-password", password);
  await page.click("#delete-confirm");
}

test.describe("GitHub Pages 用の静的版", () => {
  test("ログインなしでタスク画面が出る", async ({ page }) => {
    await open(page);
    await expect(page.locator("#auth-view")).toBeHidden();
    // アカウントが無いので、ログアウトなどの導線は出さない
    await expect(page.locator(".user-bar")).toBeHidden();
    await expect(page.locator("#local-note")).toBeVisible();
  });

  test("追加したタスクが localStorage に残り、開き直しても消えない", async ({ page }) => {
    await open(page);
    await addTask(page, "牛乳を買う");

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: "牛乳を買う", completed: false, dueDate: null });

    await page.reload();
    await expect(page.locator(".task-text", { hasText: "牛乳を買う" })).toBeVisible();
  });

  test("以前の版が保存したタスクをそのまま引き継ぐ", async ({ page }) => {
    // 期日が無かったころの形。消さずに読めること
    await open(page, [{ id: "old-1", text: "2026／9／25学校宿題", completed: false, createdAt: 1758000000000 }]);
    await expect(page.locator(".task-text", { hasText: "2026／9／25学校宿題" })).toBeVisible();

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored).toHaveLength(1);
  });

  test("期日を付けて追加でき、バッジが出る", async ({ page }) => {
    await open(page);
    const today = await page.evaluate(() => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
    await addTask(page, "日記を書く", today);
    await expect(page.locator(".task-item", { hasText: "日記を書く" }).locator(".task-due")).toHaveText("きょうまで");
  });

  test("存在しない日付は追加できない", async ({ page }) => {
    await open(page);
    // type=date は画面から不正な日付を入れられないので、保存側の判定を直接確かめる
    const error = await page.evaluate(async () => {
      try {
        await window.TaskAppLocalBackend.request("POST", "/api/tasks", { text: "x", dueDate: "2026-02-30" });
        return null;
      } catch (err) {
        return { status: err.status, message: err.message };
      }
    });
    expect(error).toMatchObject({ status: 400, message: "存在しない日付です" });
  });

  test("未完了のタスクは削除ボタンを押せない", async ({ page }) => {
    await open(page);
    await addTask(page, "算数ステップ3まで");
    const deleteBtn = page.locator(".task-item", { hasText: "算数ステップ3まで" }).locator(".task-delete");
    await expect(deleteBtn).toBeDisabled();
  });

  test("未完了のタスクは、画面を通さず消そうとしても断られる", async ({ page }) => {
    await open(page);
    await addTask(page, "算数ステップ3まで");

    const error = await page.evaluate(async (password) => {
      const key = "taskManagerApp.tasks";
      const [task] = JSON.parse(localStorage.getItem(key) || "[]");
      try {
        await window.TaskAppLocalBackend.request("DELETE", `/api/tasks/${task.id}`, { password });
        return null;
      } catch (err) {
        return { status: err.status, code: err.code };
      }
    }, DELETE_PASSWORD);

    expect(error).toMatchObject({ status: 409, code: "task_not_completed" });
    await expect(page.locator(".task-text", { hasText: "算数ステップ3まで" })).toBeVisible();
  });

  test("合言葉が違うと削除できない", async ({ page }) => {
    await open(page);
    await addTask(page, "英語教材");
    await page.locator(".task-item", { hasText: "英語教材" }).locator(".task-checkbox").check();
    await deleteTask(page, "英語教材", "999999");

    await expect(page.locator("#delete-error")).toContainText("パスワードが違います");
    await expect(page.locator(".task-text", { hasText: "英語教材" })).toBeVisible();
  });

  test("完了済みで合言葉が合っていれば削除できる", async ({ page }) => {
    await open(page);
    await addTask(page, "日記昨日見直し");
    await page.locator(".task-item", { hasText: "日記昨日見直し" }).locator(".task-checkbox").check();
    await deleteTask(page, "日記昨日見直し", DELETE_PASSWORD);

    await expect(page.locator(".task-text", { hasText: "日記昨日見直し" })).toBeHidden();
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored).toHaveLength(0);
  });

  test("完了済みをまとめて削除するにも合言葉が要る", async ({ page }) => {
    await open(page);
    await addTask(page, "終わったもの");
    await addTask(page, "まだのもの");
    await page.locator(".task-item", { hasText: "終わったもの" }).locator(".task-checkbox").check();

    await page.click("#clear-completed");
    await page.fill("#delete-password", "000000");
    await page.click("#delete-confirm");
    await expect(page.locator("#delete-error")).toContainText("パスワードが違います");

    await page.fill("#delete-password", DELETE_PASSWORD);
    await page.click("#delete-confirm");
    await expect(page.locator(".task-text", { hasText: "終わったもの" })).toBeHidden();
    // 未完了は残る
    await expect(page.locator(".task-text", { hasText: "まだのもの" })).toBeVisible();
  });

  test("合言葉を5回間違えるとしばらく削除できない", async ({ page }) => {
    await open(page);
    await addTask(page, "鍵をかける");
    await page.locator(".task-item", { hasText: "鍵をかける" }).locator(".task-checkbox").check();

    for (let i = 0; i < 5; i += 1) {
      await deleteTask(page, "鍵をかける", "000000");
      await expect(page.locator("#delete-error")).toBeVisible();
      await page.click("#delete-cancel");
    }

    // 6回目は正しい合言葉でも受け付けない
    await deleteTask(page, "鍵をかける", DELETE_PASSWORD);
    await expect(page.locator("#delete-error")).toContainText("削除できません");
    await expect(page.locator(".task-text", { hasText: "鍵をかける" })).toBeVisible();
  });

  test("削除の説明に「管理者だけ」と書かない（この版に管理者はいない）", async ({ page }) => {
    await open(page);
    await expect(page.locator("#delete-hint")).toContainText("合言葉を入力すると削除できます");
    await expect(page.locator("#delete-hint")).not.toContainText("管理者");
  });

  test("サーバーへの通信が一切発生しない", async ({ page }) => {
    const apiCalls = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/")) apiCalls.push(req.url());
    });
    await open(page);
    await addTask(page, "通信しないこと");
    await page.locator(".task-item", { hasText: "通信しないこと" }).locator(".task-checkbox").check();
    expect(apiCalls).toEqual([]);
  });
});

test.describe("静的版の編集・まとめて削除", () => {
  test("内容と期日を書き換えて localStorage に残る", async ({ page }) => {
    await open(page);
    await addTask(page, "牛乳を買う");

    await page.locator(".task-item").first().locator(".task-edit").click();
    await expect(page.locator("#edit-text")).toHaveValue("牛乳を買う");
    await page.fill("#edit-text", "低脂肪乳を買う");
    await page.fill("#edit-due", "2030-01-15");
    await page.click("#edit-save");

    await expect(page.locator(".task-text").first()).toHaveText("低脂肪乳を買う");

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored[0]).toMatchObject({ text: "低脂肪乳を買う", dueDate: "2030-01-15" });

    // 開き直しても残る（画面だけの書き換えではない）
    await page.reload();
    await expect(page.locator(".task-text").first()).toHaveText("低脂肪乳を買う");
  });

  test("編集では合言葉を聞かれない", async ({ page }) => {
    await open(page);
    await addTask(page, "牛乳を買う");

    await page.locator(".task-item").first().locator(".task-edit").click();
    await page.fill("#edit-text", "書き換えた");
    await page.click("#edit-save");

    await expect(page.locator("#delete-dialog")).toBeHidden();
    await expect(page.locator(".task-text").first()).toHaveText("書き換えた");
  });

  test("選んだ完了済みだけをまとめて削除できる", async ({ page }) => {
    await open(page);
    await addTask(page, "牛乳を買う");
    await addTask(page, "レポートを書く");
    for (const text of ["牛乳を買う", "レポートを書く"]) {
      await page.locator(".task-item", { hasText: text }).locator(".task-checkbox").check();
    }

    await page.click("#select-mode");
    await page.locator(".task-item", { hasText: "牛乳を買う" }).locator(".task-select").check();
    await expect(page.locator("#selection-count")).toHaveText("1 件を選択中");

    await page.click("#delete-selected");
    await page.fill("#delete-password", DELETE_PASSWORD);
    await page.click("#delete-confirm");

    await expect(page.locator(".task-item")).toHaveCount(1);
    await expect(page.locator(".task-text").first()).toHaveText("レポートを書く");

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored).toHaveLength(1);
  });

  test("まとめて削除にも合言葉が要る", async ({ page }) => {
    await open(page);
    await addTask(page, "牛乳を買う");
    await page.locator(".task-item").first().locator(".task-checkbox").check();

    await page.click("#select-mode");
    await page.locator(".task-item").first().locator(".task-select").check();
    await page.click("#delete-selected");
    await page.fill("#delete-password", "wrong-password");
    await page.click("#delete-confirm");

    await expect(page.locator("#delete-error")).toHaveText("削除用パスワードが違います");
    await expect(page.locator(".task-item")).toHaveCount(1);
  });

  test("未完了が混ざっていると、画面を通さなくても1件も消えない", async ({ page }) => {
    await open(page, [
      { id: "a", text: "終わった", completed: true, createdAt: 2 },
      { id: "b", text: "まだ終わっていない", completed: false, createdAt: 1 },
    ]);

    const result = await page.evaluate(
      ([password]) =>
        window.TaskAppLocalBackend.request("POST", "/api/tasks/bulk-delete", {
          ids: ["a", "b"],
          password,
        }).then(
          () => ({ ok: true }),
          (err) => ({ ok: false, status: err.status, code: err.code })
        ),
      [DELETE_PASSWORD]
    );
    expect(result).toMatchObject({ ok: false, status: 409, code: "task_not_completed" });

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), STORAGE_KEY);
    expect(stored).toHaveLength(2);
  });
});

test.describe("静的版のレイアウト", () => {
  // 以前は入力欄と「期日＋追加」が横並びで、狭い画面では入力欄が数文字ぶんまで潰れていた
  for (const width of [390, 480, 820]) {
    test(`幅 ${width}px でタスク入力欄が1行を使い切る`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);

      const input = await page.locator("#task-input").boundingBox();
      const form = await page.locator(".task-form").boundingBox();
      const row = await page.locator(".task-form-row").boundingBox();

      // 入力欄はフォームの幅いっぱい
      expect(input.width).toBeGreaterThan(form.width - 2);
      // 期日と追加は次の行に来る
      expect(row.y).toBeGreaterThanOrEqual(input.y + input.height - 1);
      // 日付欄も読める幅が残っている
      expect((await page.locator("#task-due").boundingBox()).width).toBeGreaterThan(120);
    });
  }

  test("狭い画面でも横スクロールが発生しない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await addTask(page, "とても長いタスク名のテストでレイアウトが崩れないことを確認する", "2030-01-15");

    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflows).toBe(false);
  });
});

test.describe("静的版の書き出し・読み込み", () => {
  test("書き出した本文に今のタスクが入っている", async ({ page }) => {
    await open(page);
    await addTask(page, "買い物");
    await page.click("#export-tasks");
    const raw = await page.inputValue("#export-text");
    const data = JSON.parse(raw);
    expect(data.format).toBe("task-manager-app");
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ text: "買い物", completed: false, dueDate: null });
  });

  test("読み込んだタスクが追加され、今あるタスクは消えない", async ({ page }) => {
    await open(page);
    await addTask(page, "もとからあるもの");

    await page.click("#import-tasks");
    await page.fill(
      "#import-text",
      JSON.stringify({
        format: "task-manager-app",
        version: 1,
        tasks: [
          { text: "よそから来たもの", completed: false, createdAt: 1758000000000, dueDate: null },
          { text: "完了済みのもの", completed: true, createdAt: 1758000001000, dueDate: null },
        ],
      })
    );
    await page.click("#import-confirm");

    await expect(page.locator(".task-text", { hasText: "よそから来たもの" })).toBeVisible();
    await expect(page.locator(".task-text", { hasText: "完了済みのもの" })).toBeVisible();
    await expect(page.locator(".task-text", { hasText: "もとからあるもの" })).toBeVisible();
    await expect(page.locator(".task-item")).toHaveCount(3);
  });

  test("壊れた本文は読み込まず、理由を出す", async ({ page }) => {
    await open(page);
    await addTask(page, "残るもの");

    await page.click("#import-tasks");
    await page.fill("#import-text", "これはJSONではありません");
    await page.click("#import-confirm");

    await expect(page.locator("#import-error")).toContainText("形式が正しくありません");
    await expect(page.locator(".task-item")).toHaveCount(1);
  });

  test("書き出した本文をそのまま読み込める", async ({ page }) => {
    await open(page);
    await addTask(page, "往復するもの");
    await page.click("#export-tasks");
    const raw = await page.inputValue("#export-text");
    await page.click("#export-close");

    await page.click("#import-tasks");
    await page.fill("#import-text", raw);
    await page.click("#import-confirm");

    // 同じ内容が2件になる（読み込みは追加であって置き換えではない）
    await expect(page.locator(".task-text", { hasText: "往復するもの" })).toHaveCount(2);
  });

  test("タスクの配列だけでも読み込める（古い形からの移行）", async ({ page }) => {
    await open(page);
    await page.click("#import-tasks");
    await page.fill(
      "#import-text",
      JSON.stringify([{ id: "old-1", text: "古い形のタスク", completed: false, createdAt: 1758000000000 }])
    );
    await page.click("#import-confirm");
    await expect(page.locator(".task-text", { hasText: "古い形のタスク" })).toBeVisible();
  });
});
