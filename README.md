# タスク管理アプリ (Task Manager App)

バニラ JavaScript と Node.js で作った、シンプルなタスク管理（ToDo）Web アプリです。
タスクはサーバーのデータベース（SQLite）に保存されるため、ログインすればどの端末・どのブラウザからでも同じタスクを使えます。
実行時の依存パッケージはなく、Node.js だけで動きます。

## 機能

- メールアドレスとパスワードによる新規登録 / ログイン / ログアウト
- メールアドレスの確認（確認が済むまでタスクは使えません）
- パスワードを忘れたときの再設定（メールのリンクから新しいパスワードを設定）
- ログイン試行回数の制限（パスワードの総当たり対策）
- タスクの追加 / 削除
- 完了・未完了の切り替え
- フィルタ表示（すべて / 未完了 / 完了済み）
- 完了済みタスクの一括削除
- タスク件数の表示（総数・未完了数）
- データベースへの保存（ユーザーごとに分離され、複数端末で共有されます）
- 同じブラウザの別タブへの即時反映、別の端末で変更した内容は画面に戻ったときに反映
- 以前のバージョンで `localStorage` に保存していたタスクを、初回ログイン時にアカウントへ自動で引き継ぎ

## ローカルで動かす

Node.js **22.13 以上**（組み込みの `node:sqlite` を使用）が必要です。

```bash
git clone <このリポジトリのURL>
cd 02_TaskManagerApp
npm start
# http://127.0.0.1:3000 を開く
```

ローカルでは実際のメールは送信されず、確認メールや再設定メールの内容（リンク）がサーバーのログに出力されます。
新規登録したら、ログに表示された `http://127.0.0.1:3000/#verify=...` を開いてください。

## 本番環境に公開する

`compose.yaml` で、アプリと [Caddy](https://caddyserver.com/)（HTTPS 証明書を自動で取得・更新するリバースプロキシ）をまとめて起動できます。

1. Docker が使えるサーバーを用意し、公開するドメインの DNS（A / AAAA レコード）をそのサーバーに向け、80 / 443 番ポートを開けます。
2. [Resend](https://resend.com) でアカウントを作成し、送信元ドメインを認証して API キーを発行します。
3. 設定ファイルを作ってデプロイします。

```bash
cp .env.example .env
# .env の DOMAIN / MAIL_FROM / RESEND_API_KEY を書き換える
docker compose up -d --build
```

`https://<DOMAIN>` でアクセスできます。Docker 以外の環境（PaaS など）で動かす場合は、下の環境変数を設定して `node server/index.js` を起動してください。

### 運用

- **データの保存場所**: DB は Docker ボリューム `app-data`（コンテナ内の `/data/tasks.db`）に保存されます。コンテナを作り直しても消えません。
- **バックアップ**: `docker compose exec app node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/tasks.db').exec(\"VACUUM INTO '/data/backup.db'\")"` で整合性のとれたコピーを作成し、`docker compose cp app:/data/backup.db ./backup.db` で取り出せます。
- **更新**: `git pull` の後に `docker compose up -d --build`。DB のスキーマ変更は起動時に自動で適用されます。
- **ログ**: `docker compose logs -f app`（メール送信の失敗もここに出ます）
- **ヘルスチェック**: `GET /api/health`
- **スケール**: 回数制限の記録はプロセスのメモリ上にあり、SQLite もファイル 1 つのため、アプリは 1 コンテナで動かす前提です。

### 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `NODE_ENV` | — | `production` にすると、下の「本番で必須」の設定が無い場合に起動を中止します |
| `PORT` | `3000` | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。サーバーやコンテナで公開するときは `0.0.0.0` |
| `DB_PATH` | `data/tasks.db` | SQLite データベースファイルのパス（ディレクトリは自動作成） |
| `APP_BASE_URL` | `http://127.0.0.1:<PORT>` | メール内リンクに使う公開 URL。**本番で必須（https）** |
| `SECURE_COOKIES` | `false` | HTTPS で配信するとき `true`（Cookie に `Secure`、HSTS ヘッダーを付与）。**本番で必須** |
| `TRUST_PROXY` | `false` | リバースプロキシの後ろで動かすとき `true`（`X-Forwarded-For` からクライアントの IP を取得） |
| `MAIL_TRANSPORT` | `console` | `console`（ログに出力）/ `file`（JSON ファイルに保存、テスト用）/ `resend`。**本番では `resend` が必須** |
| `MAIL_FROM` | `Task Manager <no-reply@example.com>` | 送信元アドレス（Resend で認証したドメイン） |
| `RESEND_API_KEY` | — | Resend の API キー（`MAIL_TRANSPORT=resend` のとき必須） |
| `MAIL_OUTBOX_DIR` | `data/mail-outbox` | `MAIL_TRANSPORT=file` のときの保存先 |
| `AUTH_RATE_LIMIT_PER_IP` | `60` | 認証系 API への IP アドレスごとのリクエスト上限（15 分あたり） |

`TRUST_PROXY=true` は、アプリに直接アクセスできず必ずプロキシを経由する構成でだけ指定してください（直接アクセスできると IP アドレスを偽装されます）。

## 構成

| ファイル | 役割 |
| --- | --- |
| `public/index.html` | 画面のマークアップ（ログイン・確認待ち・再設定・タスクの各画面） |
| `public/style.css` | スタイル定義 |
| `public/script.js` | 画面の状態管理・描画・API 呼び出し |
| `server/index.js` | サーバーの起動 |
| `server/config.js` | 環境変数の読み込みと検証 |
| `server/app.js` | API・認証・静的ファイル配信 |
| `server/db.js` | SQLite の接続とマイグレーション |
| `server/mailer.js` | メール送信（console / file / resend） |
| `server/rate-limit.js` | 回数制限 |
| `Dockerfile` / `compose.yaml` / `Caddyfile` / `.env.example` | 本番公開用の設定 |

## API

変更系リクエスト（GET 以外）には `X-Requested-With: fetch` ヘッダーが必要です（CSRF 対策）。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `POST` | `/api/register` | 新規登録 `{ email, password }`（確認メールを送信） |
| `POST` | `/api/login` | ログイン `{ email, password }` |
| `POST` | `/api/logout` | ログアウト |
| `GET` | `/api/me` | ログイン中のユーザー `{ email, emailVerified }`（未ログインなら `user: null`） |
| `POST` | `/api/verify-email` | メールアドレスの確認 `{ token }` |
| `POST` | `/api/verify-email/resend` | 確認メールの再送（ログイン中・未確認のとき） |
| `POST` | `/api/password-reset/request` | 再設定メールの送信 `{ email }`（登録有無にかかわらず同じ応答） |
| `POST` | `/api/password-reset/confirm` | 新しいパスワードの設定 `{ token, password }` |
| `GET` | `/api/tasks` | タスク一覧（新しい順） |
| `POST` | `/api/tasks` | タスク追加 `{ text }` |
| `PATCH` | `/api/tasks/:id` | 完了状態の変更 `{ completed }` |
| `DELETE` | `/api/tasks/:id` | タスク削除 |
| `POST` | `/api/tasks/clear-completed` | 完了済みタスクの一括削除 |
| `POST` | `/api/tasks/import` | `localStorage` からの引き継ぎ `{ tasks: [...] }` |
| `GET` | `/api/health` | ヘルスチェック |

タスク API はメールアドレスの確認が済んでいないと `403`（`code: "email_unverified"`）を返します。

## セキュリティ

- **パスワード**: ソルト付き scrypt でハッシュ化して保存
- **セッション**: ランダムなトークンを `HttpOnly` / `SameSite=Lax`（本番は `Secure`）Cookie で保持。有効期限 30 日、DB にはハッシュのみ保存。パスワード再設定時は全端末のセッションを無効化
- **メールのリンク**: トークンは DB にハッシュのみ保存し、1 回限り有効（確認 24 時間 / 再設定 1 時間）。URL の `#` 以降に載せるためサーバーのアクセスログや Referer に残らない
- **回数制限**（上限に達すると `429` と `Retry-After` を返す）

  | 対象 | 上限 |
  | --- | --- |
  | ログイン失敗（IP アドレス + メールアドレスごと） | 15 分 5 回 |
  | 認証系 API（IP アドレスごと） | 15 分 60 回 |
  | 確認メール（ユーザーごと）/ 再設定メール（アドレスごと） | 1 時間 3 通 |

- **登録有無の推測対策**: 存在しないユーザーのログインでもパスワード照合と同じ処理時間をかけ、再設定メールの依頼には常に同じ応答を返す
- **その他**: CSRF 対策ヘッダー、Content-Security-Policy / HSTS / X-Content-Type-Options / Referrer-Policy、`public/` 外のファイルは配信しない

## テスト

Playwright による E2E テスト（43 ケース）を用意しています。

```bash
npm install
npx playwright install chromium   # 初回のみ
npm test
```

テスト実行時にアプリサーバーが自動で起動・終了します（ポート 8765、DB はメモリ上、メールは `test-results/mail-outbox/` に保存されるため、実データや実際のメール送信には影響しません）。

| コマンド | 内容 |
| --- | --- |
| `npm test` | 全テストを実行 |
| `npm run test:ui` | Playwright UI モードで実行 |
| `npm run test:report` | 直近の HTML レポートを表示 |
| `npm start` | アプリサーバーを起動（http://127.0.0.1:3000） |

テスト対象: 認証 / メールアドレスの確認 / パスワード再設定 / 回数制限 / 初期状態 / タスクの追加 / 完了状態の切り替え / フィルタ / 削除 / データベースへの保存（リロード・別端末・ユーザー間の分離・別タブ同期・localStorage からの引き継ぎ） / ヘルスチェック / XSS 対策 / パストラバーサル対策 / レスポンシブ / JS エラー検知
