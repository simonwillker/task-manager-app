# タスク管理アプリ (Task Manager App)

バニラ JavaScript と Node.js で作った、シンプルなタスク管理（ToDo）Web アプリです。
タスクはサーバーのデータベース（SQLite）に保存されるため、ログインすればどの端末・どのブラウザからでも同じタスクを使えます。
実行時の依存パッケージはなく、Node.js だけで動きます。

## 機能

- メールアドレスとパスワードによる新規登録 / ログイン / ログアウト
- タスクの追加 / 削除
- 完了・未完了の切り替え
- フィルタ表示（すべて / 未完了 / 完了済み）
- 完了済みタスクの一括削除
- タスク件数の表示（総数・未完了数）
- データベースへの保存（ユーザーごとに分離され、複数端末で共有されます）
- 同じブラウザの別タブへの即時反映、別の端末で変更した内容は画面に戻ったときに反映
- 以前のバージョンで `localStorage` に保存していたタスクを、初回ログイン時にアカウントへ自動で引き継ぎ

## 使い方

Node.js **22.13 以上**（組み込みの `node:sqlite` を使用）が必要です。

```bash
git clone <このリポジトリのURL>
cd 02_TaskManagerApp
npm start
# http://127.0.0.1:3000 を開く
```

初回はログイン画面の「新規登録」からアカウントを作成してください。

### 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。サーバーやコンテナで外部公開するときは `0.0.0.0` |
| `DB_PATH` | `data/tasks.db` | SQLite データベースファイルのパス（ディレクトリは自動作成） |
| `SECURE_COOKIES` | `false` | HTTPS で配信するときは `true`（セッション Cookie に `Secure` を付与） |

### 公開する場合の注意

- インターネットに公開するときは、必ず HTTPS（リバースプロキシや PaaS の TLS 終端）の後ろに置き、`SECURE_COOKIES=true` を指定してください。
- `DB_PATH` は再起動・再デプロイで消えない場所（永続ボリュームなど）を指定してください。
- データのバックアップは `DB_PATH` のファイル（`-wal` / `-shm` を含む）を保存してください。

## 構成

| ファイル | 役割 |
| --- | --- |
| `public/index.html` | 画面のマークアップ（ログイン画面・タスク画面） |
| `public/style.css` | スタイル定義 |
| `public/script.js` | 画面の状態管理・描画・API 呼び出し |
| `server/index.js` | サーバーの起動（環境変数の読み込み） |
| `server/app.js` | API・認証・静的ファイル配信 |
| `server/db.js` | SQLite の接続とテーブル定義 |

## API

変更系リクエスト（GET 以外）には `X-Requested-With: fetch` ヘッダーが必要です（CSRF 対策）。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `POST` | `/api/register` | 新規登録 `{ email, password }` |
| `POST` | `/api/login` | ログイン `{ email, password }` |
| `POST` | `/api/logout` | ログアウト |
| `GET` | `/api/me` | ログイン中のユーザー（未ログインなら `user: null`） |
| `GET` | `/api/tasks` | タスク一覧（新しい順） |
| `POST` | `/api/tasks` | タスク追加 `{ text }` |
| `PATCH` | `/api/tasks/:id` | 完了状態の変更 `{ completed }` |
| `DELETE` | `/api/tasks/:id` | タスク削除 |
| `POST` | `/api/tasks/clear-completed` | 完了済みタスクの一括削除 |
| `POST` | `/api/tasks/import` | `localStorage` からの引き継ぎ `{ tasks: [...] }` |

## 技術仕様

- 実行時の依存ライブラリなし（フロントエンドは Vanilla HTML / CSS / JavaScript、サーバーは Node.js 標準モジュールのみ）
- データベース: SQLite（`node:sqlite`）。テーブルは `users` / `sessions` / `tasks`
- パスワード: ソルト付き scrypt でハッシュ化して保存
- セッション: ランダムなトークンを `HttpOnly` / `SameSite=Lax` Cookie で保持（有効期限 30 日、DB にはトークンのハッシュのみ保存）
- セキュリティヘッダー: Content-Security-Policy / X-Content-Type-Options / Referrer-Policy

## テスト

Playwright による E2E テスト（29 ケース）を用意しています。

```bash
npm install
npx playwright install chromium   # 初回のみ
npm test
```

テスト実行時にアプリサーバーが自動で起動・終了します（ポート 8765、DB はメモリ上に作るため実データには影響しません）。

| コマンド | 内容 |
| --- | --- |
| `npm test` | 全テストを実行 |
| `npm run test:ui` | Playwright UI モードで実行 |
| `npm run test:report` | 直近の HTML レポートを表示 |
| `npm start` | アプリサーバーを起動（http://127.0.0.1:3000） |

テスト対象: 認証（登録・ログイン・ログアウト・未ログイン時の API 拒否・CSRF 対策） / 初期状態 / タスクの追加 / 完了状態の切り替え / フィルタ / 削除 / データベースへの保存（リロード・別端末・ユーザー間の分離・別タブ同期・localStorage からの引き継ぎ） / XSS 対策 / パストラバーサル対策 / レスポンシブ / JS エラー検知
