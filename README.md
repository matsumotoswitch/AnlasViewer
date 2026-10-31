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

## GitHub Pages の有効化手順

本リポジトリのスクリプトをWeb上に公開するため、GitHub Pagesを有効化します。

1. GitHubの **`matsumotoswitch/AnlasViewer`** リポジトリページを開きます。
2. 上部メニューの **[Settings]** をクリックします。
3. 左サイドバーの **[Pages]** をクリックします。
4. **Build and deployment** の設定：
   - **Source**: `Deploy from a branch` を選択
   - **Branch**: `main` ブランチ、フォルダは `/ (root)` を選択
   - **[Save]** をクリックします。
5. 数分後、`https://matsumotoswitch.github.io/AnlasViewer/` に公開されます。
   - このページを開くと、ブックマークバーにドラッグ＆ドロップしてワンタッチで追加できるボタンが用意されています。

---

## ファイル構成

```text
AnlasViewer/
├── anlas-viewer.js         # 本体スクリプト（このファイルを直接編集・pushするだけ）
├── index.html              # GitHub Pages用トップページ（ドラッグ＆ドロップ登録対応）
└── README.md
```

複雑なビルドツール（Node.js / npm）は不要です。`anlas-viewer.js` を直接編集してリポジトリにプッシュするだけで、GitHub Pages経由で即座に最新版が配信されます。

---

## 技術仕様

1. **認証トークン取得**
   `localStorage.getItem('session')` をJSONパースし、`auth_token` を安全に取得します。
2. **API通信**
   `GET https://api.novelai.net/user/subscription`（予備: `GET /user/data`）を Bearerトークン付きで呼び出し、`trainingStepsLeft` の `fixedTrainingStepsLeft`（定期・毎月リセット）と `purchasedTrainingSteps`（有償）を取得します。`GET /user/information` は仕様上 Anlas の内訳を含まないため使用しません。失敗時はステータスとレスポンス本文をコンソールに出力します。
3. **DOM置換 & アイコン保護**
   画面上部から「Anlas:」を含む最深要素を特定。SVGコインアイコンがある場合はアイコンを残したままテキストのみを書き換えます。
4. **SPA対応（MutationObserver）**
   ページ遷移やAnlas消費でReactがDOMを再描画した場合、自動検知して再書き換えを行います。前回取得から5秒以上経過していればバックグラウンドで最新残高を再取得します。
5. **無限ループ・多重実行防止**
   書き換え中フラグ（`isMutating`）、カスタム属性（`data-anlas-view="true"`）、テキスト内容一致チェックの三重ガード。また `window.anlasViewerActive` により多重実行を防止し、2回目以降のクリックはリフレッシュとして機能します。
