// このファイルは動作モードを決める。
//   "server" … サーバー（server/）の API を使う。ログインあり、データは共有
//   "local"  … ブラウザの localStorage だけを使う。ログインなし、データは端末ごと
// GitHub Pages 用のビルド（scripts/build-static.js）が "local" に差し替える。
window.TASK_APP_MODE = "server";
