/**
 * AnlasViewer - NovelAI Anlas 分割表示ブックマークレット
 *
 * NovelAIのヘッダーにある「Anlas: 〇〇」という合算表示を、
 * REST APIから取得した内訳に基づき「定期: (定) + 有償: (有)」に書き換えます。
 *
 * 主な機能・特徴:
 * 1. 実行形式: ブックマークレット（1クリックで現在のタブに常駐）
 * 2. 認証情報の取得: localStorage（'session' キーなど）からNovelAIの認証トークン（auth_token）を取得
 * 3. API通信: NovelAI REST API（https://image.novelai.net/user/subscription）から「定期購入分」「有償分」を取得
 * 4. DOMの書き換え: 画面上部の「Anlas: 〇〇」要素を「定期: (定) + 有償: (有)」に書き換え（アイコン保護対応 & クリックで即時更新）
 * 5. SPA・Anlas消費追従:
 *    - MutationObserverによるReactの再描画・DOM変更監視
 *    - window.fetch インターセプトによる画像生成・AIリクエスト完了時の自動残高再取得
 *    - タブ復帰時（visibilitychange）の自動同期
 * 6. 無限ループ防止: 書き換え中フラグ + data-anlas-view="true" 属性 + 値一致チェックによる三重ガード
 * 7. 多重実行防止: window.anlasViewerActive による二重起動抑止（再実行時は手動リフレッシュ）
 */
(function () {
  'use strict';

  // 多重実行防止チェック（window.anlasViewerActive で管理）
  if (window.anlasViewerActive) {
    console.info('[AnlasViewer] 既に常駐しています。最新の残高を再取得して更新します...');
    if (typeof window.anlasViewerRefresh === 'function') {
      window.anlasViewerRefresh();
    }
    return;
  }

  // グローバル常駐フラグ
  window.anlasViewerActive = true;

  // 内部ステート管理
  const state = {
    fixed: null,
    purchased: null,
    lastFetchedAt: 0,
    isMutating: false,
    debounceTimer: null,
    observer: null,
    fetching: false,
    failCount: 0,
    originalFetch: null,
    visibilityListener: null
  };

  /**
   * localStorageからNovelAIの認証トークン（auth_token）を取得
   * @returns {string|null}
   */
  function getAuthToken() {
    try {
      const sessionRaw = localStorage.getItem('session');
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (session && session.auth_token) {
          return session.auth_token;
        }
      }
    } catch (err) {
      console.warn('[AnlasViewer] sessionのJSONパースに失敗しました:', err);
    }

    // フォールバック（他のキー名で格納されている場合）
    const directToken = localStorage.getItem('auth_token');
    if (directToken) return directToken;

    return null;
  }

  /**
   * REST APIからAnlasの定期購入分・有償分を取得
   */
  const ENDPOINTS = [
    'https://image.novelai.net/user/subscription',
    'https://image.novelai.net/user/data',
    'https://api.novelai.net/user/subscription'
  ];
  let preferredEndpoint = null; // 一度成功したエンドポイントを記憶

  /**
   * レスポンスJSONから定期分・有償分を抽出（見つからなければ null）
   */
  function extractAnlas(data) {
    if (!data || typeof data !== 'object') return null;
    const steps = data.trainingStepsLeft || data.subscription?.trainingStepsLeft;
    if (steps && typeof steps.fixedTrainingStepsLeft === 'number' && typeof steps.purchasedTrainingSteps === 'number') {
      return { fixed: steps.fixedTrainingStepsLeft, purchased: steps.purchasedTrainingSteps };
    }
    return null;
  }

  /**
   * REST APIからAnlasの定期購入分・有償分を取得
   * @param {string} token
   * @returns {Promise<{fixed: number, purchased: number}>}
   */
  async function fetchAnlasInfo(token) {
    const targets = preferredEndpoint
      ? [preferredEndpoint, ...ENDPOINTS.filter(u => u !== preferredEndpoint)]
      : ENDPOINTS;
    const failures = [];

    for (const url of targets) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          failures.push(`${url} -> HTTP ${response.status} ${body.slice(0, 200)}`);
          continue;
        }

        const data = await response.json();
        const result = extractAnlas(data);
        if (result) {
          preferredEndpoint = url;
          return result;
        }
        failures.push(`${url} -> 200 OK だが内訳フィールドなし (keys: ${Object.keys(data).join(', ')})`);
      } catch (err) {
        failures.push(`${url} -> ${err.message}`);
      }
    }

    throw new Error('全エンドポイントで取得失敗:\n  ' + failures.join('\n  '));
  }

  /**
   * DOMから「Anlas: 〇〇」と合算表示されている要素を特定
   * @returns {HTMLElement|null}
   */
  function findAnlasElement() {
    // 1. まず画面上に生の「Anlas:」表示（Reactによる再描画・新要素挿入）が出現していないか走査
    const allElements = document.querySelectorAll('header *, nav *, [role="banner"] *, div, span, p, a, button');
    const freshCandidates = [];

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;

      const text = el.textContent || '';
      if (/Anlas\s*:/i.test(text)) {
        // 子要素に「Anlas:」を含むものが無い＝最も深い要素
        const hasChildMatch = Array.from(el.children).some(child => /Anlas\s*:/i.test(child.textContent || ''));
        if (!hasChildMatch) {
          freshCandidates.push(el);
        }
      }
    }

    if (freshCandidates.length > 0) {
      // 画面上部（ビューポート Y < 200）にあるものを最優先
      const topCandidate = freshCandidates.find(el => {
        const rect = el.getBoundingClientRect();
        return el.closest('header, nav, [role="banner"]') || (rect.top >= 0 && rect.top < 200);
      });
      return topCandidate || freshCandidates[0];
    }

    // 2. 生の「Anlas:」がなければ、既に書き換え済みのタグ付き要素を返す（現在DOMツリー上に存在するもの）
    const tagged = document.querySelector('[data-anlas-view="true"]');
    if (tagged && document.body.contains(tagged)) {
      return tagged;
    }

    return null;
  }

  /**
   * DOMのAnlas表示を「定期: (定) + 有償: (有)」に書き換える
   * @returns {boolean} 書き換えに成功したかどうか
   */
  function renderAnlasView() {
    if (state.fixed === null || state.purchased === null) return false;

    const targetEl = findAnlasElement();
    if (!targetEl) return false;

    const formattedFixed = state.fixed.toLocaleString();
    const formattedPurchased = state.purchased.toLocaleString();
    const formattedTotal = (state.fixed + state.purchased).toLocaleString();
    const expectedText = `定期: ${formattedFixed} + 有償: ${formattedPurchased}`;

    // 無限ループ防止チェック: 既に書き換え済みかつテキストが一致している場合はスキップ
    const currentAttr = targetEl.getAttribute('data-anlas-view');
    if (currentAttr === 'true' && targetEl.textContent.trim().includes(expectedText)) {
      return true;
    }

    // 書き換え処理（自己イベント検知ガードフラグをセット）
    state.isMutating = true;
    try {
      targetEl.setAttribute('data-anlas-view', 'true');
      targetEl.title = `Anlas合計: ${formattedTotal} (定期: ${formattedFixed} / 有償: ${formattedPurchased})\nクリックで最新残高を再取得`;
      targetEl.style.cursor = 'pointer';

      // クリックで即時リフレッシュできるようにハンドラを登録
      if (!targetEl._anlasClickHandler) {
        targetEl._anlasClickHandler = (e) => {
          e.stopPropagation();
          console.info('[AnlasViewer] クリックを検知。残高を再取得します...');
          updateAnlasData(false);
        };
        targetEl.addEventListener('click', targetEl._anlasClickHandler);
      }

      // アイコン（SVG等）が共存している場合はアイコンを保護
      const hasIcon = targetEl.querySelector('svg, img');
      if (hasIcon) {
        let textReplaced = false;
        for (const child of targetEl.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && (/Anlas/i.test(child.nodeValue) || /定期/i.test(child.nodeValue))) {
            child.nodeValue = ' ' + expectedText;
            textReplaced = true;
            break;
          }
        }
        if (!textReplaced) {
          let span = targetEl.querySelector('.anlas-viewer-text');
          if (!span) {
            span = document.createElement('span');
            span.className = 'anlas-viewer-text';
            targetEl.appendChild(span);
          }
          span.textContent = ' ' + expectedText;
        }
      } else {
        targetEl.textContent = expectedText;
      }
    } finally {
      Promise.resolve().then(() => {
        state.isMutating = false;
      });
    }

    return true;
  }

  /**
   * APIから残高を取得してDOMへ反映
   * @param {boolean} silent trueの場合は残高に変動がない限りログ出力を抑制
   */
  async function updateAnlasData(silent = false) {
    if (state.fetching) return false;

    const token = getAuthToken();
    if (!token) {
      console.error('[AnlasViewer] エラー: 認証トークン（auth_token）を取得できませんでした。NovelAIにログインしているか確認してください。');
      return false;
    }

    state.fetching = true;
    state.lastFetchedAt = Date.now();
    try {
      const { fixed, purchased } = await fetchAnlasInfo(token);

      const isChanged = (state.fixed !== null && (state.fixed !== fixed || state.purchased !== purchased));
      state.fixed = fixed;
      state.purchased = purchased;
      state.failCount = 0;

      renderAnlasView();

      // 残高が変わった場合、または手動実行時は必ずログを出力
      if (!silent || isChanged) {
        console.info(`[AnlasViewer] 残高更新: 定期 = ${fixed.toLocaleString()}, 有償 = ${purchased.toLocaleString()} (合計 = ${(fixed + purchased).toLocaleString()})`);
      }
      return true;
    } catch (err) {
      state.failCount++;
      console.error('[AnlasViewer] エラー: APIからのAnlas情報取得に失敗しました:', err.message);
      return false;
    } finally {
      state.fetching = false;
    }
  }

  // 外部からの再取得トリガーとして公開
  window.anlasViewerRefresh = () => updateAnlasData(false);

  /**
   * MutationObserver用コールバック（SPAの再描画追従）
   */
  function handleMutations() {
    if (state.isMutating) return;

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      const el = findAnlasElement();
      if (!el) return;

      // 画面上に生の「Anlas:」が出現しているか、または「定期:」が含まれていない（Reactが再描画した）か判定
      const text = el.textContent || '';
      const isReverted = /Anlas\s*:/i.test(text) || !text.includes('定期:');

      if (isReverted) {
        // Reactの再描画を検知した場合、直近2秒以内にフェッチしていなければAPIから最新残高を再取得
        const now = Date.now();
        const interval = Math.min(2000 * Math.pow(2, state.failCount), 60000);
        if (now - state.lastFetchedAt > interval) {
          updateAnlasData(true);
        } else {
          // 直近であればキャッシュ値で即座に書き戻す
          renderAnlasView();
        }
      } else {
        renderAnlasView();
      }
    }, 50);
  }

  /**
   * fetchのインターセプト（画像生成やAI操作の完了を自動検知して残高を再取得）
   */
  function setupFetchInterceptor() {
    if (typeof window.fetch !== 'function') return;

    const originalFetch = window.fetch;
    state.originalFetch = originalFetch;

    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        // 画像生成・AI処理関連のリクエスト完了を検知
        if (url && (url.includes('/generate') || url.includes('/ai/') || url.includes('/image'))) {
          // 当スクリプト自身のAnlas取得リクエストは除外
          if (!url.includes('/user/subscription') && !url.includes('/user/data')) {
            // 画像生成完了後、少し待ってから残高を最新化
            setTimeout(() => {
              updateAnlasData(true);
            }, 600);
          }
        }
      } catch (_) {}

      return response;
    };
  }

  /**
   * タブ切り替え（visibilitychange）時の自動更新
   */
  function setupVisibilityListener() {
    state.visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - state.lastFetchedAt > 3000) {
          updateAnlasData(true);
        }
      }
    };
    document.addEventListener('visibilitychange', state.visibilityListener);
  }

  /**
   * 初期化処理
   */
  async function init() {
    console.info('[AnlasViewer] 起動中...');

    // 初回データ取得（失敗したら常駐せずに中断）
    const ok = await updateAnlasData(false);
    if (!ok) {
      console.error('[AnlasViewer] 初回取得に失敗したため処理を中断しました。上記のエラー内容を確認してください。');
      window.anlasViewerActive = false;
      return;
    }

    // 1. MutationObserverでDOMの変更（SPAの画面遷移・再描画）を監視
    state.observer = new MutationObserver(handleMutations);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 2. 画像生成APIの完了を検知するfetchインターセプトを設定
    setupFetchInterceptor();

    // 3. タブ復帰時の自動同期を設定
    setupVisibilityListener();

    console.info('[AnlasViewer] 常駐完了: ヘッダーのAnlas監視を開始しました。（表示をクリックで手動更新も可能）');
  }

  // 停止・リソース解除用関数（デバッグ・保守用）
  window.anlasViewerCleanup = () => {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    if (state.originalFetch) {
      window.fetch = state.originalFetch;
      state.originalFetch = null;
    }
    if (state.visibilityListener) {
      document.removeEventListener('visibilitychange', state.visibilityListener);
      state.visibilityListener = null;
    }
    const tagged = document.querySelector('[data-anlas-view="true"]');
    if (tagged) {
      if (tagged._anlasClickHandler) {
        tagged.removeEventListener('click', tagged._anlasClickHandler);
        delete tagged._anlasClickHandler;
      }
      tagged.removeAttribute('data-anlas-view');
      tagged.title = '';
      tagged.style.cursor = '';
    }
    window.anlasViewerActive = false;
    delete window.anlasViewerRefresh;
    delete window.anlasViewerCleanup;
    console.info('[AnlasViewer] 監視を停止し、リソースを解除しました。');
  };

  init();
})();
