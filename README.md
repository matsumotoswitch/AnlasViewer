# AnlasViewer

NovelAIのWeb画面において、ヘッダーに合算表示されているAnlas（「Anlas: 〇〇」）を、**「定期購入分」**と**「有償分」**に分割して表示するブックマークレットです。

GitHub Pages等のWeb公開機能を利用し、外部スクリプト（`anlas-viewer.js`）を動的に読み込む**ローダー形式**を採用しています。本体コードをGitHub上で更新すれば、ブックマークレットを再登録することなく自動的に最新機能が反映されます。

```text
【変換前】 Anlas: 12,500
【変換後】 定期: 10,000 + 有償: 2,500
```

---

## ブックマークレット（ローダーコード）

以下の1行をブラウザのブックマークの「URL」欄に登録してください。

```javascript
javascript:(function(){var s=document.createElement('script');s.src='https://matsumotoswitch.github.io/AnlasViewer/anlas-viewer.js?'+Date.now();document.head.appendChild(s);})();
```

> **ポイント**: `+Date.now()` によりキャッシュバスターが付与されているため、GitHubでスクリプトを更新した際もブラウザの古いキャッシュに邪魔されず、常に最新版が読み込まれます。

---

## 使い方

1. [NovelAI](https://novelai.net/) をブラウザで開いてログインします。
2. 登録した **AnlasViewer** ブックマークレットをクリックします。
3. ヘッダーの合算表示が **「定期: 〇〇 + 有償: 〇〇」** に切り替わります。
4. 画面遷移や画像生成・テキスト生成を行っても、自動的に内訳表示が維持・追従されます。
5. もう一度クリックすると、APIから最新データを再取得して表示を更新（リフレッシュ）します。

---

## ファイル構成

```text
AnlasViewer/
├── anlas-viewer.js         # 本体スクリプト（このファイルを直接編集・pushするだけ）
├── index.html              # GitHub Pages用トップページ（ドラッグ＆ドロップ登録対応）
└── README.md
```

---

## 技術仕様

1. **認証トークン取得**
   `localStorage.getItem('session')` をJSONパースし、`auth_token` を安全に取得します。
2. **API通信**
   `GET https://image.novelai.net/user/subscription`（予備: `/user/data`）を Bearerトークン付きで呼び出し、`trainingStepsLeft` の `fixedTrainingStepsLeft`（定期・毎月リセット）と `purchasedTrainingSteps`（有償）を取得します。※NovelAIの仕様上、残高系エンドポイントは `image.novelai.net` に集約されています。
3. **DOM置換 & アイコン保護**
   画面上部から「Anlas:」を含む最深要素を特定。SVGコインアイコンがある場合はアイコンを残したままテキストのみを書き換えます。
4. **SPA・Anlas消費への自動追従**
   - **MutationObserver**: ページ遷移やReactの再描画によって元の「Anlas: 〇〇」に戻ったことを検知し、自動で最新残高を再取得・再書き換えします。
   - **Fetchインターセプト**: 画像生成やAIリクエストの完了を自動検知し、画像生成直後に最新の残高をバックグラウンドで即座に再取得します。
   - **クリックで即時更新**: ヘッダーの「定期: 〇〇 + 有償: 〇〇」の表示部分をクリックすると、いつでも手動で最新残高にリフレッシュできます。
   - **タブ復帰時の自動同期**: 別タブから戻ってきた際にも最新情報を自動チェックします。
5. **無限ループ・多重実行防止**
   書き換え中フラグ（`isMutating`）、カスタム属性（`data-anlas-view="true"`）、テキスト内容一致チェックの三重ガード。また `window.anlasViewerActive` により多重実行を防止し、2回目以降のクリックはリフレッシュとして機能します。
