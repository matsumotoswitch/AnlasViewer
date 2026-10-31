/**
 * AnlasViewer - NovelAI Anlas 分割表示ブックマークレット
 *
 * NovelAIのヘッダーにある「Anlas: 〇〇」という合算表示を、
 * REST APIから取得した内訳に基づき「定期: (定) + 有償: (有)」に書き換えます。
 *
 * 主な機能・特徴:
 * 1. 実行形式: ブックマークレット（1クリックで現在のタブに常駐）
 * 2. 認証情報の取得: localStorage（'session' キーなど）からNovelAIの認証トークン（auth_token）を取得
 * 3. API通信: REST API（ https://api.novelai.net/user/information ）をFetchで叩き、Bearerトークンを付与して「定期購入分」「有償分」を取得
 * 4. DOMの書き換え: 画面上部の「Anlas: 〇〇」要素を「定期: (定) + 有償: (有)」に書き換え（アイコン保持対応）
 * 5. SPA対応: MutationObserverで画面遷移やAnlas消費に伴うReactの再描画を検知し自動追従
 * 6. 無限ループ防止: 書き換え中フラグ + data-anlas-view="true" 属性 + 値一致チェックによる三重ガード
 * 7. 多重実行防止: window.anlasViewerActive による二重起動抑止（再実行時はデータを再取得して更新）
 * 8. エラーハンドリング: トークン取得不可やAPIエラー時は処理中断しconsole.errorに出力
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

  // グローバル管理フラグ（多重実行防止）
  window.anlasViewerActive = true;

  // 内部ステート管理
  const state = {
    fixed: null,
    purchased: null,
    lastFetchedAt: 0,
    isMutating: false,
    debounceTimer: null,
    observer: null
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
   * @param {string} token
   * @returns {Promise<{fixed: number, purchased: number}>}
   */
  async function fetchAnlasInfo(token) {
    const url = 'https://api.novelai.net/user/information';
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} (${response.statusText})`);
    }

    const data = await response.json();

    // trainingStepsLeft の構造から定期購入分と有償分を抽出
    // fixedTrainingStepsLeft: 定期購入分（サブスク付与枠）
    // purchasedTrainingSteps: 有償分（追加購入枠）
    const steps = data.subscription?.trainingStepsLeft || data.trainingStepsLeft || {};
    const fixed = typeof steps.fixedTrainingStepsLeft === 'number'
      ? steps.fixedTrainingStepsLeft
      : (data.subscriptionAnlas ?? 0);
    const purchased = typeof steps.purchasedTrainingSteps === 'number'
      ? steps.purchasedTrainingSteps
      : (data.purchasedAnlas ?? 0);

    return { fixed, purchased };
  }

  /**
   * DOMから「Anlas: 〇〇」と合算表示されている要素を特定
   * @returns {HTMLElement|null}
   */
  function findAnlasElement() {
    // 既にタグ付けされている要素があれば優先
    const tagged = document.querySelector('[data-anlas-view="true"]');
    if (tagged) return tagged;

    // ヘッダーやナビゲーション周辺の要素を対象に走査
    const allElements = document.querySelectorAll('header *, nav *, [role="banner"] *, div, span, p, a, button');
    const candidatesWithNumber = [];
    const candidatesWithLabel = [];

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;

      const text = el.textContent || '';

      // パターン1: "Anlas: 10,000" のように数値まで含んでいる要素
      if (/Anlas\s*:\s*[\d,]+/i.test(text)) {
        const hasChildWithNumber = Array.from(el.children).some(child => /Anlas\s*:/i.test(child.textContent || ''));
        if (!hasChildWithNumber) {
          candidatesWithNumber.push(el);
        }
      }

      // パターン2: "Anlas:" ラベルのみの要素（フォールバック）
      if (/Anlas\s*:/i.test(text)) {
        const hasChildWithLabel = Array.from(el.children).some(child => /Anlas\s*:/i.test(child.textContent || ''));
        if (!hasChildWithLabel) {
          candidatesWithLabel.push(el);
        }
      }
    }

    const pool = candidatesWithNumber.length > 0 ? candidatesWithNumber : candidatesWithLabel;
    if (pool.length === 0) return null;

    // ヘッダー内または画面上部（ビューポート Y < 200）にある要素を最優先
    const topCandidate = pool.find(el => {
      const rect = el.getBoundingClientRect();
      return el.closest('header, nav, [role="banner"]') || (rect.top >= 0 && rect.top < 200);
    });

    return topCandidate || pool[0];
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
      targetEl.title = `Anlas合計: ${formattedTotal} (定期: ${formattedFixed} / 有償: ${formattedPurchased})`;

      // アイコン（SVG等）が共存している場合はアイコンを保護
      const hasIcon = targetEl.querySelector('svg, img');
      if (hasIcon) {
        // テキストノードのみを特定して置換
        let textReplaced = false;
        for (const child of targetEl.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && (/Anlas/i.test(child.nodeValue) || /定期/i.test(child.nodeValue))) {
            child.nodeValue = ' ' + expectedText;
            textReplaced = true;
            break;
          }
        }
        if (!textReplaced) {
          // テキスト用spanの追加・更新
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
      // 次のマイクロタスクでフラグ解除
      Promise.resolve().then(() => {
        state.isMutating = false;
      });
    }

    return true;
  }

  /**
   * APIから残高を取得してDOMへ反映
   * @param {boolean} silent ログ出力を抑制するかどうか
   */
  async function updateAnlasData(silent = false) {
    const token = getAuthToken();
    if (!token) {
      console.error('[AnlasViewer] エラー: 認証トークン（auth_token）を取得できませんでした。NovelAIにログインしているか確認してください。');
      window.anlasViewerActive = false;
      return;
    }

    try {
      const { fixed, purchased } = await fetchAnlasInfo(token);
      state.fixed = fixed;
      state.purchased = purchased;
      state.lastFetchedAt = Date.now();

      renderAnlasView();

      if (!silent) {
        console.info(`[AnlasViewer] 残高取得成功: 定期 = ${fixed.toLocaleString()}, 有償 = ${purchased.toLocaleString()} (合計 = ${(fixed + purchased).toLocaleString()})`);
      }
    } catch (err) {
      console.error('[AnlasViewer] エラー: APIからのAnlas情報取得に失敗しました:', err);
      if (state.fixed === null) {
        window.anlasViewerActive = false;
      }
    }
  }

  // 外部からの再取得トリガーとして公開
  window.anlasViewerRefresh = () => updateAnlasData(false);

  /**
   * MutationObserver用コールバック（デバウンス処理付き）
   */
  function handleMutations() {
    if (state.isMutating) return;

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      const el = findAnlasElement();
      if (!el) return;

      // Reactの再描画等で元の「Anlas:」表示に戻ったか判定
      const isOriginal = /Anlas\s*:/i.test(el.textContent) && el.getAttribute('data-anlas-view') !== 'true';

      if (isOriginal) {
        // 画像生成等でAnlasが消費された可能性を考慮し、前回取得から5秒以上経過していればAPIを再取得
        const now = Date.now();
        if (now - state.lastFetchedAt > 5000) {
          updateAnlasData(true);
        } else {
          // 直近の取得であればキャッシュ値で即座に再書き換え
          renderAnlasView();
        }
      } else {
        renderAnlasView();
      }
    }, 60);
  }

  /**
   * 初期化処理
   */
  async function init() {
    console.info('[AnlasViewer] 起動中...');

    // 初回データ取得
    await updateAnlasData(false);

    // MutationObserverでDOMの変更（SPAの画面遷移・再描画）を監視
    state.observer = new MutationObserver(handleMutations);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    console.info('[AnlasViewer] 常駐完了: ヘッダーのAnlas監視を開始しました。');
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
    const tagged = document.querySelector('[data-anlas-view="true"]');
    if (tagged) {
      tagged.removeAttribute('data-anlas-view');
      tagged.title = '';
    }
    window.anlasViewerActive = false;
    delete window.anlasViewerRefresh;
    delete window.anlasViewerCleanup;
    console.info('[AnlasViewer] 監視を停止し、リソースを解除しました。');
  };

  init();
})();
