# タスク管理アプリ (Task Manager App)

**デモ: https://simonwillker.github.io/task-manager-app/**

バニラ JavaScript だけで動く、シンプルなタスク管理（ToDo）アプリです。
ビルド不要・依存パッケージなしで、`index.html` をブラウザで開くだけで動作します。

## 機能

- タスクの追加 / 削除
- 完了・未完了の切り替え
- フィルタ表示（すべて / 未完了 / 完了済み）
- 完了済みタスクの一括削除
- タスク件数の表示（総数・未完了数）
- `localStorage` による自動保存（リロードしても内容が残ります）

## 使い方

```bash
git clone <このリポジトリのURL>
cd 02_TaskManagerApp
```

`index.html` をブラウザで開いてください。ローカルサーバーで確認する場合:

```bash
python -m http.server 8000
# http://localhost:8000 を開く
```

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面のマークアップ |
| `style.css` | スタイル定義 |
| `script.js` | タスクの状態管理・描画・永続化 |

## 技術仕様

- 依存ライブラリなし（Vanilla HTML / CSS / JavaScript）
- 保存先: `localStorage`（キー: `taskManagerApp.tasks`）
- `localStorage` が使えない環境でもアプリ自体は動作します（保存のみ無効）

## テスト

Playwright による E2E テスト（17 ケース）を用意しています。

```bash
npm install
npx playwright install chromium   # 初回のみ
npm test
```

静的サーバーはテスト実行時に自動で起動・終了するため、事前起動は不要です。

| コマンド | 内容 |
| --- | --- |
| `npm test` | 全テストを実行 |
| `npm run test:ui` | Playwright UI モードで実行 |
| `npm run test:report` | 直近の HTML レポートを表示 |
| `npm start` | 静的サーバーのみ起動（http://127.0.0.1:8765） |

テスト対象: 初期状態 / タスクの追加 / 完了状態の切り替え / フィルタ / 削除 / 永続化 / XSS 対策 / レスポンシブ / JS エラー検知

## デプロイ

`main` ブランチへの push をトリガーに、GitHub Actions で GitHub Pages へ自動デプロイされます。

1. E2E テスト（17 ケース）を実行
2. **テストが成功した場合のみ** `index.html` / `style.css` / `script.js` を公開
3. https://simonwillker.github.io/task-manager-app/ に反映

Pull Request ではテストのみが実行され、デプロイは行われません。

ワークフロー定義: [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
