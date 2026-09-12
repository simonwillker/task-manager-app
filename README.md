# タスク管理アプリ (Task Manager App)

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
