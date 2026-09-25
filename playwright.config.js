// @ts-check
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8765;
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** GitHub Pages 用の静的サイト（site/）を配信するポート */
const STATIC_PORT = 8766;
const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}`;
/** テスト用サーバーが送信したメールの保存先（テストから読み取ってリンクを開く） */
const MAIL_OUTBOX_DIR = path.join(__dirname, "test-results", "mail-outbox");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "on-first-retry",
  },
  projects: [
    // サーバー版（server/ を起動して API 越しに動かす）
    {
      name: "server",
      testMatch: /task-manager\.spec\.js/,
      use: { ...devices["Desktop Chrome"], baseURL: BASE_URL },
    },
    // GitHub Pages 用の静的版（site/ を配信して localStorage だけで動かす）
    {
      name: "static",
      testMatch: /static-site\.spec\.js/,
      use: { ...devices["Desktop Chrome"], baseURL: STATIC_URL },
    },
  ],
  // テスト実行前にアプリサーバーを自動で起動・終了する（DB はメモリ上に作るので実データに影響しない）
  webServer: [
    {
      command: "node server/index.js",
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(PORT),
        HOST: "127.0.0.1",
        DB_PATH: ":memory:",
        APP_BASE_URL: BASE_URL,
        MAIL_TRANSPORT: "file",
        MAIL_OUTBOX_DIR,
        // すべてのテストが同じ IP から登録・ログインするため、IP 単位の制限は実質無効にする
        AUTH_RATE_LIMIT_PER_IP: "100000",
        // @admins.test のアドレスで登録したユーザーを管理者として扱う。
        // テストごとにアドレスが変わるので、ドメイン指定で管理者・一般を作り分ける
        ADMIN_EMAILS: "@admins.test",
        DELETE_PASSWORD: "123456",
      },
    },
    {
      // 配信する前に site/ を組み立て直す。public/ の変更が必ず反映される
      command: "node scripts/build-static.js && node scripts/serve-static.js",
      url: `${STATIC_URL}/index.html`,
      reuseExistingServer: false,
      env: { PORT: String(STATIC_PORT), HOST: "127.0.0.1" },
    },
  ],
});
