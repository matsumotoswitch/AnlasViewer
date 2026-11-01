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
    visibilityListener: null,
    cachedIcon: null
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
    // 既に当スクリプトのコンテナがある場合、現在も画面最上部（ヘッダー領域）にあるか確認
    const tagged = document.querySelector('[data-anlas-view="true"]');
    if (tagged && document.body.contains(tagged)) {
      const rect = tagged.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < 80) {
        return tagged;
      }
    }

    // 画面最上部（ヘッダー領域: top < 80px）にある要素のみを走査（購入画面等は完全除外）
    const allElements = document.querySelectorAll('div, span, p, a, button');
    const freshCandidates = [];

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;

      // モーダルや購入ダイアログの内部は絶対に除外
      if (el.closest('[role="dialog"], .modal, [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]')) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      // 画面最上部のヘッダーバー内（top < 80px）のみを対象とする
      if (rect.top < 0 || rect.top > 80) continue;

      const text = el.textContent || '';
      // "Anlas:" または "Anlas :" を含む要素（購入画面の「定期購入のAnlas:」などの長文は除外）
      if (/Anlas\s*:/i.test(text) && text.length < 35) {
        const hasChildMatch = Array.from(el.children).some(child => /Anlas\s*:/i.test(child.textContent || ''));
        if (!hasChildMatch) {
          freshCandidates.push(el);
        }
      }
    }

    if (freshCandidates.length > 0) {
      return freshCandidates[0];
    }

    if (tagged && document.body.contains(tagged)) {
      return tagged;
    }

    return null;
  }

  /**
   * ヘッダー内の黄色い合算値（例: "15470 💎"）のみをピンポイントで非表示にする
   * ※ 購入画面（Purchase Anlas）などヘッダー以外の要素は絶対に触らない
   * @param {HTMLElement} baseEl
   */
  function hideLegacyElements(baseEl) {
    if (!baseEl) return;

    // baseEl が画面最上部（ヘッダー領域: top < 80px）にあることを確認
    const baseRect = baseEl.getBoundingClientRect();
    if (baseRect.top < 0 || baseRect.top > 80) return;

    // モーダルやダイアログ内部であれば絶対に実行しない
    if (baseEl.closest('[role="dialog"], .modal, [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]')) {
      return;
    }

    // 共通の非表示判定処理
    function checkAndHide(el) {
      if (!el || el === baseEl || el.contains(baseEl) || el.classList.contains('anlas-viewer-container')) return;
      if (el.closest('[role="dialog"], .modal, [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]')) return;

      const rect = el.getBoundingClientRect();
      // 画面上部（ヘッダーバー内）以外の要素は触らない
      if (rect.top < 0 || rect.top > 80) return;

      const text = el.textContent.trim();

      // "+" ボタン（購入ボタン）やメニューアイコン（三本線）は保護
      if (text === '+' || text === '≡' || text === '☰' || el.getAttribute('aria-label')?.includes('Add')) {
        return;
      }
      // "Purchase" や "購入"、"USD" などを含む要素は保護
      if (/Purchase|購入|USD|ドル|定期|有償|合計/i.test(text)) {
        return;
      }

      // 数値のみ（例: "15470"）、またはアイコン要素（SVG/IMG）、または数値+アイコン要素
      const isPureDigits = /^\s*[\d,]+\s*$/.test(text);
      const isIconOnly = el.tagName === 'SVG' || el.tagName === 'IMG' || (text.length === 0 && el.querySelector('svg, img') !== null);
      const isDigitsWithIcon = /[\d,]{2,}/.test(text) && (text.replace(/[\d,\s]/g, '').length === 0 || el.querySelector('svg, img') !== null);

      if (isPureDigits || isIconOnly || isDigitsWithIcon) {
        const icon = el.querySelector('svg, img') || (el.tagName === 'SVG' || el.tagName === 'IMG' ? el : null);
        if (icon && !state.cachedIcon) {
          state.cachedIcon = icon.cloneNode(true);
        }
        el.style.display = 'none';
        el.setAttribute('data-anlas-hidden', 'true');
      }
    }

    // baseEl の直接の親、およびその親（角丸ボックス）の子要素をチェック
    let current = baseEl.parentElement;
    for (let depth = 0; depth < 2 && current; depth++) {
      if (['BODY', 'HTML', 'MAIN'].includes(current.tagName)) break;
      Array.from(current.children).forEach(checkAndHide);
      current = current.parentElement;
    }
  }

    /**
     * DOMのAnlas表示を「定期 / 有償 / 合計」の2段センタリングレイアウトに書き換える
     *
     *   定期      有償       合計
     *  6,880  +  9,842  =  16,722  [アイコン]
     *
     * 各カラムを縦方向Flex（align-items: center）にすることで、
     * 値が「0」等の短い場合でもラベルの横幅内で綺麗に中央揃えになります。
     *
     * @returns {boolean} 書き換えに成功したかどうか
     */
    function renderAnlasView() {
      if (state.fixed === null || state.purchased === null) return false;

      const targetEl = findAnlasElement();
      if (!targetEl) return false;

      const formattedFixed = state.fixed.toLocaleString();
      const formattedPurchased = state.purchased.toLocaleString();
      const total = state.fixed + state.purchased;
      const formattedTotal = total.toLocaleString();

      let container = targetEl.querySelector('.anlas-viewer-container');

      // 黄色い合算値（例: "15470 💎"）の残存要素があれば確実に非表示にする
      hideLegacyElements(targetEl);

      // 既に当スクリプトのコンテナが存在し、数値も一致していればスキップ（無限ループ防止）
      if (container && container.dataset.fixed === formattedFixed && container.dataset.purchased === formattedPurchased) {
        return true;
      }

      state.isMutating = true;
      try {
        targetEl.setAttribute('data-anlas-view', 'true');
        targetEl.title = `Anlas合計: ${formattedTotal} (定期: ${formattedFixed} / 有償: ${formattedPurchased})\nクリックで最新残高を再取得`;
        targetEl.style.cursor = 'pointer';

        // クリック時に残高を最新化（※NovelAI本来の購入モーダル表示イベントを妨げないよう伝播は止めない）
        if (!targetEl._anlasClickHandler) {
          targetEl._anlasClickHandler = () => {
            console.info('[AnlasViewer] クリックを検知。残高を最新化します...');
            updateAnlasData(true);
          };
          targetEl.addEventListener('click', targetEl._anlasClickHandler);
        }

        if (container) {
            // 既存のコンテナの数値を差分更新（チラつき防止）
            const valFixed = container.querySelector('.anlas-val-fixed');
            const valPurchased = container.querySelector('.anlas-val-purchased');
            const valTotal = container.querySelector('.anlas-val-total');
            if (valFixed) valFixed.textContent = formattedFixed;
            if (valPurchased) valPurchased.textContent = formattedPurchased;
            if (valTotal) valTotal.textContent = formattedTotal;
            container.dataset.fixed = formattedFixed;
            container.dataset.purchased = formattedPurchased;
          } else {
            // アイコン（SVG等）があれば退避して保持
            const iconNode = targetEl.querySelector('svg, img');
            if (iconNode) {
              state.cachedIcon = iconNode.cloneNode(true);
            }
            const iconClone = iconNode
              ? iconNode.cloneNode(true)
              : (state.cachedIcon ? state.cachedIcon.cloneNode(true) : null);

            // targetEl の既存テキスト（元の合算値テキストなど）をクリア
            targetEl.innerHTML = '';

            container = document.createElement('div');
            container.className = 'anlas-viewer-container';
            container.dataset.fixed = formattedFixed;
            container.dataset.purchased = formattedPurchased;
            container.style.cssText = [
              'display: inline-flex',
              'align-items: center',
              'gap: 8px',
              'user-select: none',
              'line-height: 1.15',
              'vertical-align: middle',
              'padding: 1px 0'
            ].join(';');

            // 2段センタリング構造:
            // 各カラムを flex-direction:column; align-items:center にすることで、
            // 上段ラベルと下段数値が常に中央揃えになり、数値が「0」の場合もラベル幅の中でセンタリングされる
            container.innerHTML = `
          <div class="anlas-col" style="display:inline-flex; flex-direction:column; align-items:center; justify-content:center; min-width:0;">
            <span style="font-size:0.68em; line-height:1.1; font-weight:500; opacity:0.75; letter-spacing:0.04em;">定期</span>
            <span class="anlas-val-fixed" style="font-size:0.95em; line-height:1.2; font-weight:700;">${formattedFixed}</span>
          </div>
          <div style="display:inline-flex; align-items:flex-end; font-size:0.85em; font-weight:600; opacity:0.6; margin-top:auto; padding-bottom:2px;">+</div>
          <div class="anlas-col" style="display:inline-flex; flex-direction:column; align-items:center; justify-content:center; min-width:0;">
            <span style="font-size:0.68em; line-height:1.1; font-weight:500; opacity:0.75; letter-spacing:0.04em;">有償</span>
            <span class="anlas-val-purchased" style="font-size:0.95em; line-height:1.2; font-weight:700;">${formattedPurchased}</span>
          </div>
          <div style="display:inline-flex; align-items:flex-end; font-size:0.85em; font-weight:600; opacity:0.6; margin-top:auto; padding-bottom:2px;">=</div>
          <div class="anlas-col" style="display:inline-flex; flex-direction:column; align-items:center; justify-content:center; min-width:0;">
            <span style="font-size:0.68em; line-height:1.1; font-weight:500; opacity:0.75; letter-spacing:0.04em;">合計</span>
            <span class="anlas-val-total" style="font-size:0.95em; line-height:1.2; font-weight:700;">${formattedTotal}</span>
          </div>
        `;

            if (iconClone) {
              const iconWrapper = document.createElement('span');
              iconWrapper.style.cssText = 'display:inline-flex; align-items:center; margin-left:2px;';
              iconWrapper.appendChild(iconClone);
              container.appendChild(iconWrapper);
            }

            targetEl.appendChild(container);
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

          // 画面上に生の「Anlas:」が出現しているか、またはコンテナが外れた（Reactが再描画した）か判定
          const text = el.textContent || '';
          const hasContainer = !!el.querySelector('.anlas-viewer-container');
          const isReverted = /Anlas\s*:/i.test(text) || !hasContainer || !text.includes('定期');

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
          } catch (_) { }

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

        // 以前の実行で誤って非表示になった要素（購入モーダル等）があれば復元
        document.querySelectorAll('[data-anlas-hidden="true"]').forEach(el => {
          if (el.closest('[role="dialog"], .modal, [class*="modal"], [class*="popup"]') || /Purchase|購入|USD/i.test(el.textContent)) {
            el.style.display = '';
            el.removeAttribute('data-anlas-hidden');
          }
        });

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
        // 非表示にした元の合算値要素を復元
        document.querySelectorAll('[data-anlas-hidden="true"]').forEach(el => {
          el.style.display = '';
          el.removeAttribute('data-anlas-hidden');
        });
        window.anlasViewerActive = false;
        delete window.anlasViewerRefresh;
        delete window.anlasViewerCleanup;
        console.info('[AnlasViewer] 監視を停止し、リソースを解除しました。');
      };

      init();
    }) ();
