# タスク管理アプリ (Task Manager App)

このアプリには**2つの版**があります。中身（画面・操作）は同じで、タスクの保存先だけが違います。

| | サーバー版 | 静的版 |
|---|---|---|
| 公開先 | Fly.io（<https://simonwillker-task-manager.fly.dev/>） | GitHub Pages（<https://simonwillker.github.io/task-manager-app/>） |
| 保存先 | サーバーの SQLite | その端末のブラウザ（`localStorage`） |
| ログイン | あり | なし |
| 端末をまたいで同じタスク | **できる** | できない（端末ごとに別） |
| 削除の条件 | 管理者・完了済み・合言葉（**サーバーが判定**） | 完了済み・合言葉（**画面側だけの判定**） |
| デプロイ | [deploy.yml](.github/workflows/deploy.yml)（`FLY_API_TOKEN` が必要） | [pages.yml](.github/workflows/pages.yml)（設定不要） |

静的版は、サーバーを用意しなくてもすぐ使えるかわりに、**削除の制限を確実には守れません**。
ブラウザの開発者ツールを使えば合言葉を入れずに消せますし、合言葉そのものも
[public/localBackend.js](public/localBackend.js) に書いてあるので秘密にはできません。
「うっかり消さないための歯止め」として割り切っています。確実に守りたいときはサーバー版を使ってください。

バニラ JavaScript と Node.js で作った、シンプルなタスク管理（ToDo）Web アプリです。
タスクはサーバーのデータベース（SQLite）に保存されるため、ログインすればどの端末・どのブラウザからでも同じタスクを使えます。
実行時の依存パッケージはなく、Node.js だけで動きます。

## 機能

- メールアドレスとパスワードによる新規登録 / ログイン / ログアウト
- メールアドレスの確認（確認が済むまでタスクは使えません）
- パスワードを忘れたときの再設定（メールのリンクから新しいパスワードを設定）
- ログイン試行回数の制限（パスワードの総当たり対策）
- タスクの追加（**期日を指定できます。任意**）
- 期日の表示（きょう・あすは言葉で、過ぎたものは赤く）
- 完了・未完了の切り替え
- フィルタ表示（すべて / 未完了 / 完了済み）
- **タスクの削除（管理者のみ・完了済みのみ・合言葉が必要）** — 下の「タスクの削除」を参照
- 完了済みタスクの一括削除（同じ3条件が必要）
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

## 静的版（GitHub Pages）

`main` への push で [pages.yml](.github/workflows/pages.yml) が動き、`site/` を組み立てて GitHub Pages へ公開します。
Secrets の設定は要りません。リポジトリの Settings → Pages で Source を **GitHub Actions** にしておいてください。

組み立ては [scripts/build-static.js](scripts/build-static.js) が `public/` を `site/` に写し、
`mode.js` だけを差し替えるだけです。画面のコードは2つの版で共通で、
[public/localBackend.js](public/localBackend.js) がサーバーの API と同じ形の応答を
`localStorage` から作って返します。

手元で確認するには:

```bash
npm run serve:static
# http://127.0.0.1:8766/ を開く
```

保存先は `localStorage` の `taskManagerApp.tasks` です。
以前 GitHub Pages で配信していた版と同じキー・同じ形なので、すでに端末に入っているタスクはそのまま引き継がれます。

## 本番環境に公開する（Fly.io）

サーバー版は DB が必要なため、静的ファイルしか配信できない GitHub Pages では動きません。[Fly.io](https://fly.io) で公開します。

`main` ブランチへの push をトリガーに、GitHub Actions（[.github/workflows/deploy.yml](.github/workflows/deploy.yml)）が次の順に実行します。

1. E2E テスト
2. Docker イメージをビルドし、本番設定で起動できるか確認
3. **両方が成功した場合のみ** Fly.io へデプロイ（[fly.toml](fly.toml)）

Pull Request では 1 と 2 だけが実行され、デプロイは行われません。

### 初回セットアップ（1 回だけ）

[flyctl](https://fly.io/docs/flyctl/install/) をインストールし、以下を実行します。Fly.io は従量課金です（小さなマシン 1 台と 1 GB のボリュームで、目安は月数ドル程度）。

```bash
# 1. アカウント作成（支払い方法の登録が必要）とログイン
fly auth signup   # 既にアカウントがあれば fly auth login

# 2. アプリと、DB を置くボリュームを作成（東京リージョン）
fly apps create simonwillker-task-manager
fly volumes create task_data --app simonwillker-task-manager --region nrt --size 1

# 3. メール送信の設定（Resend で送信元ドメインを認証し、API キーを発行しておく）
fly secrets set --app simonwillker-task-manager --stage \
  RESEND_API_KEY=re_xxxxxxxx \
  MAIL_FROM="Task Manager <no-reply@your-domain.example>"

# 4. GitHub Actions 用のデプロイトークンを発行し、リポジトリの Secrets に登録
fly tokens create deploy --app simonwillker-task-manager --expiry 8760h | gh secret set FLY_API_TOKEN
```

登録後、Actions 画面から「CI / Deploy to Fly.io」を **Run workflow** するか、`main` に push するとデプロイされます。
`FLY_API_TOKEN` が未登録の間は、デプロイの手順だけが警告付きでスキップされます。
**このときワークフロー自体は成功（緑）になります。**
実際にデプロイされたかは、実行結果の「Fly.io へデプロイ」ジョブを開き、
「デプロイ」の手順が skipped になっていないかで確かめてください。

アプリ名（`simonwillker-task-manager`）は Fly.io 全体で一意です。使えない場合は別の名前にし、`fly.toml` の `app` と `APP_BASE_URL`、ワークフローの `url` を合わせて変更してください。
独自ドメインを使う場合は `fly certs add <ドメイン>` を実行し、`APP_BASE_URL` をそのドメインに変更します。

### 運用

- **ログ**: `fly logs --app simonwillker-task-manager`（メール送信の失敗もここに出ます）
- **状態確認**: `fly status --app simonwillker-task-manager`、ヘルスチェックは `GET /api/health`
- **バックアップ**: Fly.io がボリュームのスナップショットを毎日自動で取得します（`fly volumes snapshots list <ボリューム ID>`）。手元にコピーする場合は `fly ssh console --app simonwillker-task-manager -C "node -e \"new (require('node:sqlite').DatabaseSync)('/data/tasks.db').exec(\\\"VACUUM INTO '/data/backup.db'\\\")\""` の後に `fly ssh sftp get /data/backup.db --app simonwillker-task-manager`
- **更新**: `main` にマージすると自動でデプロイされます。DB のスキーマ変更は起動時に自動で適用されます。
- **スケール**: 回数制限の記録はプロセスのメモリ上にあり、SQLite もボリューム 1 つに置くため、マシンは 1 台で動かす前提です（`--ha=false`）。アクセスが無いときはマシンが停止し、次のアクセスで数秒かけて起動します。

### 自前のサーバーで動かす場合（Docker Compose）

Fly.io を使わない場合は、`compose.yaml` でアプリと [Caddy](https://caddyserver.com/)（HTTPS 証明書を自動で取得・更新するリバースプロキシ）をまとめて起動できます。

```bash
cp .env.example .env
# .env の DOMAIN / MAIL_FROM / RESEND_API_KEY を書き換える
docker compose up -d --build
```

公開するドメインの DNS をサーバーに向け、80 / 443 番ポートを開けておいてください。DB は Docker ボリューム `app-data` に保存されます。

### 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `NODE_ENV` | — | `production` にすると、下の「本番で必須」の設定が無い場合に起動を中止します |
| `PORT` | `3000` | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。サーバーやコンテナで公開するときは `0.0.0.0`（Docker イメージでは設定済み） |
| `DB_PATH` | `data/tasks.db` | SQLite データベースファイルのパス（Docker イメージでは `/data/tasks.db`） |
| `APP_BASE_URL` | `http://127.0.0.1:<PORT>` | メール内リンクに使う公開 URL。**本番で必須（https）** |
| `SECURE_COOKIES` | `false` | HTTPS で配信するとき `true`（Cookie に `Secure`、HSTS ヘッダーを付与）。**本番で必須** |
| `CLIENT_IP_HEADER` | — | プロキシがクライアントの IP を入れるヘッダー名（Fly.io では `fly-client-ip`）。`TRUST_PROXY` より優先 |
| `TRUST_PROXY` | `false` | リバースプロキシの後ろで動かすとき `true`（`X-Forwarded-For` の末尾からクライアントの IP を取得） |
| `MAIL_TRANSPORT` | `console` | `console`（ログに出力）/ `file`（JSON ファイルに保存、テスト用）/ `resend`。**本番では `resend` が必須** |
| `MAIL_FROM` | `Task Manager <no-reply@example.com>` | 送信元アドレス（Resend で認証したドメイン） |
| `RESEND_API_KEY` | — | Resend の API キー（`MAIL_TRANSPORT=resend` のとき必須） |
| `MAIL_OUTBOX_DIR` | `data/mail-outbox` | `MAIL_TRANSPORT=file` のときの保存先 |
| `AUTH_RATE_LIMIT_PER_IP` | `60` | 認証系 API への IP アドレスごとのリクエスト上限（15 分あたり） |
| `ADMIN_EMAILS` | — | タスクを削除できる管理者のメールアドレス（カンマ区切り）。`@example.com` のように `@` で始めるとそのドメイン全員が対象。未設定なら最初に登録したユーザーだけが管理者 |
| `DELETE_PASSWORD` | `123456` | タスク削除時に入力させる合言葉。アカウントのパスワードとは別物 |

`CLIENT_IP_HEADER` / `TRUST_PROXY` は、アプリに直接アクセスできず必ずプロキシを経由する構成でだけ指定してください（直接アクセスできると IP アドレスを偽装されます）。

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
| `Dockerfile` | 本番用のコンテナイメージ |
| `fly.toml` / `.github/workflows/deploy.yml` | Fly.io の設定と、CI / 自動デプロイ |
| `compose.yaml` / `Caddyfile` / `.env.example` | 自前のサーバーで動かす場合の設定 |

## API

変更系リクエスト（GET 以外）には `X-Requested-With: fetch` ヘッダーが必要です（CSRF 対策）。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `POST` | `/api/register` | 新規登録 `{ email, password }`（確認メールを送信） |
| `POST` | `/api/login` | ログイン `{ email, password }` |
| `POST` | `/api/logout` | ログアウト |
| `GET` | `/api/me` | ログイン中のユーザー `{ email, emailVerified, isAdmin }`（未ログインなら `user: null`） |
| `POST` | `/api/verify-email` | メールアドレスの確認 `{ token }` |
| `POST` | `/api/verify-email/resend` | 確認メールの再送（ログイン中・未確認のとき） |
| `POST` | `/api/password-reset/request` | 再設定メールの送信 `{ email }`（登録有無にかかわらず同じ応答） |
| `POST` | `/api/password-reset/confirm` | 新しいパスワードの設定 `{ token, password }` |
| `GET` | `/api/tasks` | タスク一覧（新しい順） |
| `POST` | `/api/tasks` | タスク追加 `{ text, dueDate? }`（`dueDate` は `YYYY-MM-DD`、省略で期日なし） |
| `PATCH` | `/api/tasks/:id` | 完了状態・期日の変更 `{ completed?, dueDate? }`（`dueDate: null` で期日を外す） |
| `DELETE` | `/api/tasks/:id` | タスク削除 `{ password }`（管理者・完了済みのみ） |
| `POST` | `/api/tasks/clear-completed` | 完了済みタスクの一括削除 `{ password }`（管理者のみ） |
| `POST` | `/api/tasks/import` | `localStorage` からの引き継ぎ `{ tasks: [...] }` |
| `GET` | `/api/health` | ヘルスチェック |

タスク API はメールアドレスの確認が済んでいないと `403`（`code: "email_unverified"`）を返します。

## 期日

タスクには**任意で期日**をつけられます。追加フォームの「期日（任意）」で選ぶだけです。

- 形式は `YYYY-MM-DD` のみ。時刻もタイムゾーンも扱いません（「その日まで」しか意味しないため、時刻を持つと端末の時差で1日ずれます）
- 存在しない日付（`2026-02-31` など）はサーバーが `400` で弾きます
- 一覧では、きょう・あすは「きょうまで」「あすまで」と言葉で出ます
- **期日を過ぎた未完了のタスクだけ赤く**なります（完了済みを赤くしても意味がないため）
- 後から `PATCH /api/tasks/:id` で付け外しできます

## タスクの削除

削除は取り消せないので、3つの条件をすべて満たさないと実行できません。判定はサーバー側で行うため、API を直接呼んでも同じです。

| 条件 | 満たさないときの応答 |
| --- | --- |
| 管理者であること | `403` `code: "not_admin"`（「タスクを削除できるのは管理者だけです」） |
| そのタスクが完了済みであること | `409` `code: "task_not_completed"`（「完了していないタスクは削除できません」） |
| 合言葉（`DELETE_PASSWORD`）が合っていること | `403` `code: "bad_delete_password"`（「削除用パスワードが違います」） |

**誰が管理者になるか**

- `ADMIN_EMAILS` を設定していれば、その一覧だけが管理者です（起動後の変更も、次のログイン・リクエストで反映されます）。
- 設定していなければ、**最初に登録したユーザー**が管理者になります。そうしないと誰もタスクを削除できないアプリになるためです。

**画面の動き**

- 管理者以外には削除ボタンも「完了済みを削除」ボタンも表示されません。
- 未完了のタスクでは削除ボタンが押せない状態になり、理由が表示されます。
- 削除ボタンを押すと合言葉を聞くダイアログが出ます。合言葉が違えばダイアログ内にエラーが出て、タスクは残ります。

**合言葉について**

`DELETE_PASSWORD` は「誤操作を止めるための共有の合言葉」であって、アカウントのパスワードではありません。既定値は `123456` です。管理者全員で同じものを使うので、**本番では推測されにくい文字列に変えてください**。総当たりを避けるため、間違いが 5 回続くと 15 分間は削除を受け付けません（IP アドレス + ユーザーごと）。

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

Playwright による E2E テスト（44 ケース）を用意しています。

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
