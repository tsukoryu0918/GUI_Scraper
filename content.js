// ===== content.js (GUI Scraper) =====
(() => {
  // 生存フラグ
  window.__GS_READY__ = true;
  console.log('[GS] content loaded:', location.href);

  // ========== Utilities ==========
  const gs_toDigits = (s) => (s || '').replace(/\D+/g, '');
  const gs_todayJST = () => {
    const now = new Date();
    const jst = new Date(now.getTime() + (9 - now.getTimezoneOffset() / 60) * 3600000);
    const y = jst.getUTCFullYear();
    const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(jst.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  };
  const gs_yenToManString = (s) => {
    if (!s) return '';
    let t = s.replace(/[,，\s]/g, '');
    let yen = 0;
    const m1 = t.match(/([\d.]+)万円/);
    if (m1) yen += Math.round(parseFloat(m1[1]) * 10000);
    const m2 = t.match(/([\d.]+)億/);
    if (m2) yen += Math.round(parseFloat(m2[1]) * 100000000);
    const m3 = t.match(/([\d.]+)万(?!円)/);
    if (m3) yen += Math.round(parseFloat(m3[1]) * 10000);
    const m4 = t.match(/([\d.]+)円/);
    if (m4) yen += Math.round(parseFloat(m4[1]));
    if (!m1 && !m2 && !m3 && !m4) {
      const d = (t.match(/\d+/g) || []).join('');
      if (d) yen += parseInt(d, 10);
    }
    return yen ? String(Math.round(yen / 10000)) : '';
  };
  const gs_dateYmd = (s) => {
    const x = (s || '').trim();
    let y, m, d;
    const jp = x.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (jp) { y = +jp[1]; m = +jp[2]; d = +jp[3]; }
    else {
      const m1 = x.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
      if (m1) { y = +m1[1]; m = +m1[2]; d = +m1[3]; }
    }
    if (!y || !m || !d) return '';
    return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
  };

  // 追加の整形オプション
  const gs_normalizeSpace = (s) => (s || '').replace(/[\s\u3000]+/g, ' ').trim();
  const gs_noSpaces       = (s) => (s || '').replace(/[\s\u3000]+/g, '');
  const gs_noNewlines     = (s) => (s || '').replace(/\r?\n|\r/g, ''); // 改行のみ削除

  // ★ XPath前処理
  function normalizeXPathForEval(xp) {
    const s = String(xp || '').trim();
    if (!s) return '';
    if (s.startsWith('(') || s.startsWith('/') || s.startsWith('.//') || s.startsWith('//')) return s;
    return './/' + s;
  }

  function gs_applyProc(val, proc) {
    switch (proc) {
      case 'digits': return gs_toDigits(val);
      case 'yenToMan': return gs_yenToManString(val);
      case 'dateYmd': return gs_dateYmd(val);
      case 'normalizeSpace': return gs_normalizeSpace(val);
      case 'noSpaces': return gs_noSpaces(val);
      case 'noNewlines': return gs_noNewlines(val);
      default: return (val ?? '').toString().trim();
    }
  }

  // ========== XPath Builders ==========
  function getUniqueXPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id && !/^\d+$/.test(el.id)) {
      return `//*[@id='${el.id.replace(/'/g, "\\'")}']`;
    }
    const segs = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id && !/^\d+$/.test(node.id)) {
        segs.unshift(`*[@id='${node.id.replace(/'/g, "\\'")}']`);
        return '//' + segs.join('/');
      }
      let idx = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) idx++;
      segs.unshift(`${tag}[${idx}]`);
      if (node === document.documentElement) break;
    }
    return '//' + segs.join('/');
  }

  function buildHeaderLinkedXPath(tdEl) {
    if (!(tdEl instanceof Element)) return null;
    const tr = tdEl.closest('tr'); if (!tr) return null;
    const th = tr.querySelector('th'); if (!th) return null;
    const label = (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim();
    if (!label) return null;
    const table = tdEl.closest('table');
    let tableExpr = '';
    if (table?.id && !/^\d+$/.test(table.id)) {
      tableExpr = `//*[@id='${table.id.replace(/'/g, "\\'")}']`;
    } else if (table && table.classList.length) {
      const cls = Array.from(table.classList).slice(0, 2)
        .map(c => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`).join(' and ');
      tableExpr = cls ? `//table[${cls}]` : '//table';
    } else {
      tableExpr = '//table';
    }
    const thExpr = `normalize-space(.)='${label.replace(/'/g, "\\'")}'`;
    return `${tableExpr}//tr[.//th[${thExpr}]]/td[1]`;
  }

  // ========== Overlay for picking ==========
  let overlayBox = null;
  function ensureOverlay() {
    if (!overlayBox) {
      overlayBox = document.createElement('div');
      overlayBox.style.cssText =
        'position:absolute;outline:2px solid #34c759;outline-offset:1px;z-index:2147483646;pointer-events:none;';
      document.documentElement.appendChild(overlayBox);
    }
  }
  function placeOverlay(el) {
    if (!el || !(el instanceof Element)) return;
    const r = el.getBoundingClientRect(); ensureOverlay();
    overlayBox.style.display = 'block';
    overlayBox.style.left = (window.scrollX + r.x) + 'px';
    overlayBox.style.top  = (window.scrollY + r.y) + 'px';
    overlayBox.style.width  = r.width + 'px';
    overlayBox.style.height = r.height + 'px';
  }
  function hideOverlay() { if (overlayBox) overlayBox.style.display = 'none'; }

  // ========== 共通抽出関数 ==========
  function getValueByAttr(el, attr) {
    if (attr === 'text') return (el.innerText || el.textContent || '').trim();
    if (attr === 'html') return el.innerHTML || '';
    if (attr === 'href') return (el.closest('a')?.href) || el.getAttribute('href') || '';
    if (attr === 'src')  return el.getAttribute('src') || '';
    return (el.innerText || el.textContent || '').trim();
  }

  function runSchemaExtract(schema, singleRow) {
    return new Promise((resolve) => {
      if (!schema || !Array.isArray(schema.fields) || !schema.fields.length) {
        resolve({ ok:false, error:'不正なスキーマ' });
        return;
      }

      const fieldDebug = [];
      const data = {};
      let maxRows = 0;

      for (const f of schema.fields) {
        const name = f.name;
        const xp   = (f.xpath || '').trim();
        const attr = (f.attr  || 'text').trim();
        const proc = (f.proc  || 'text').trim();

        const vals = [];
        let hitCount = 0;
        if (xp) {
          const query = normalizeXPathForEval(xp);
          let snap;
          try {
            snap = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            hitCount = snap.snapshotLength;
          } catch (e) {
            console.error('[GS] XPath評価エラー(schema):', e, 'query=', query);
            snap = { snapshotLength: 0, snapshotItem: () => null };
            hitCount = 0;
          }
          const limit = singleRow ? Math.min(1, hitCount) : hitCount;
          for (let i=0; i<limit; i++) {
            const el = snap.snapshotItem(i);
            if (!el) continue;
            const raw = getValueByAttr(el, attr);
            vals.push(gs_applyProc(raw, proc));
          }
        }

        data[name] = vals;
        if (!singleRow && vals.length > maxRows) maxRows = vals.length;

        fieldDebug.push({
          name, xpath: xp, attr, proc,
          hitCount,
          sample: vals[0] ?? ''
        });
      }

      let items = [];
      if (singleRow) {
        const row = {};
        for (const f of schema.fields) row[f.name] = (data[f.name]?.[0] ?? '');
        if (!('取得日時' in row)) row['取得日時'] = gs_todayJST();
        items = [row];
      } else {
        const rows = Math.max(maxRows, 1);
        for (let r = 0; r < rows; r++) {
          const row = {};
          for (const f of schema.fields) row[f.name] = (data[f.name]?.[r] ?? '');
          if (!('取得日時' in row)) row['取得日時'] = gs_todayJST();
          items.push(row);
        }
      }

      resolve({
        ok: true,
        items,
        debug: {
          pageUrl: String(location.href || ''),
          fields: fieldDebug
        }
      });
    });
  }

  // ========== 次ページURLヒューリスティックス ==========
  function gs_abs(u){ try{ return new URL(u, location.href).href; }catch(_){ return ''; } }
  function gs_isPaginateContainer(el){
    if (!el) return false;
    const MAX_UP = 3;
    let n = el;
    for (let i=0;i<MAX_UP && n;i++){
      const cls = (n.className || '').toString().toLowerCase();
      if (cls.includes('pagination') || cls.includes('pager') || cls.includes('paginate') || cls.includes('pagenation') || cls.includes('page-numbers') || cls.includes('nav-links')) return true;
      if (n.tagName && n.tagName.toLowerCase() === 'nav') return true;
      n = n.parentElement;
    }
    return false;
  }
  function gs_findNextUrlHeuristic(){
    const ln = document.querySelector('link[rel="next"]');
    if (ln?.href) return { url: gs_abs(ln.href), via: 'link[rel=next]' };

    const TOK_TEXT = ['次へ','次','次の','次ページ','次のページ','もっと見る','さらに見る','さらに読み込む','続きを読む','Next','next','Older','More','›','»','>','≫'];
    const TOK_CLASS = ['next','pager-next','pagination-next','next-page','nav-next','older','more'];

    let anchors = [...document.querySelectorAll('a[href]')];
    const inPaginate = anchors.filter(a => gs_isPaginateContainer(a));
    const candidates = inPaginate.length ? inPaginate : anchors;

    const pickByLabel = candidates.find(a => {
      if (a.rel && /\bnext\b/i.test(a.rel)) return true;
      const aria = (a.getAttribute('aria-label') || '').toLowerCase();
      if (aria && /(次|next|older|more)/i.test(aria)) return true;
      const txt = (a.textContent || '').replace(/\s+/g,'').toLowerCase();
      if (TOK_TEXT.some(t => txt.includes(t.toLowerCase()))) return true;
      const cls = (a.className || '').toString().toLowerCase();
      if (TOK_CLASS.some(t => cls.includes(t))) return true;
      return false;
    });
    if (pickByLabel?.href) return { url: gs_abs(pickByLabel.href), via: 'label/class' };

    const cur = document.querySelector('.active a[href], .current a[href], [aria-current="page"], li.active, li.current');
    if (cur) {
      let n = cur;
      if (n && n.tagName && n.tagName.toLowerCase() !== 'a') {
        const aIn = n.querySelector('a[href]');
        if (aIn) n = aIn;
      }
      let sib = (n.tagName && n.tagName.toLowerCase() === 'a') ? n.parentElement : n;
      while (sib && (sib = sib.nextElementSibling)) {
        const a = sib.querySelector ? sib.querySelector('a[href]') : null;
        if (a?.href) return { url: gs_abs(a.href), via: 'sibling' };
        if (sib.tagName && sib.tagName.toLowerCase() === 'a' && sib.getAttribute('href')) {
          return { url: gs_abs(sib.getAttribute('href')), via: 'sibling' };
        }
      }
    }

    const clickable = [...document.querySelectorAll('[onclick]')];
    for (const el of clickable) {
      const js = (el.getAttribute('onclick') || '');
      const m = js.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i)
             || js.match(/window\.location\s*=\s*['"]([^'"]+)['"]/i)
             || js.match(/document\.location\s*=\s*['"]([^'"]+)['"]/i);
      if (m && m[1]) return { url: gs_abs(m[1]), via: 'onclick' };
    }

    const dataEls = [...document.querySelectorAll('[data-next],[data-url],[data-href]')];
    for (const el of dataEls) {
      const u = el.getAttribute('data-next') || el.getAttribute('data-url') || el.getAttribute('data-href');
      if (u) return { url: gs_abs(u), via: 'data-*' };
    }
    return { url: '', via: 'none' };
  }

  // ========== Message router ==========
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.type) {
        case 'GS_OPEN_MINI_BUILDER': {
         // ここは全フレームで呼ばれる可能性があるので、トップフレームだけ反応
         if (window.self !== window.top) {
           sendResponse && sendResponse({ ok: true, ignored: 'subframe' });
           return true;
         }
         // IIFE内で公開した buildPanel() を実行
         if (typeof window.__GS_buildPanel === 'function') {
           window.__GS_buildPanel();
           sendResponse && sendResponse({ ok: true, opened: true });
         } else {
           sendResponse && sendResponse({ ok: false, error: 'builder-not-loaded' });
         }
         return true;
       }
        case 'GS_PING': {
          sendResponse({ ok: true, ready: true });
          return true;
        }

        // クリック1回で「県リンク用の汎化XPath」を返す
        case 'GS_PICK_XPATH_FOR_SEEDS': {
          let picking = true, moveH, clickH, overlay;

          function ensureOverlay(){
            if (!overlay) {
              overlay = document.createElement('div');
              overlay.style.cssText = 'position:absolute;outline:2px solid #34c759;outline-offset:1px;z-index:2147483646;pointer-events:none;';
              document.documentElement.appendChild(overlay);
            }
          }
          function placeOverlay(el){
            const r = el.getBoundingClientRect(); ensureOverlay();
            overlay.style.display='block';
            overlay.style.left = (window.scrollX + r.x) + 'px';
            overlay.style.top  = (window.scrollY + r.y) + 'px';
            overlay.style.width = r.width + 'px';
            overlay.style.height = r.height + 'px';
          }
          function hideOverlay(){ if (overlay) overlay.style.display='none'; }

          const deindex = (xp) => xp.replace(/\[(\d+)\]/g, '');
          const escId = (s) => s.replace(/'/g, "\\'");

          function buildGeneralizedSeedXPath(target){
            const a = target.closest('a'); if (!a) return '';
            let container = a.closest('#search-area-map');
            if (!container) {
              container = a.closest('[id]') || a.closest('nav,section,aside,main,div,ul') || document.body;
            }
            let containerXp = '';
            if (container && container.id && !/^\d+$/.test(container.id)) {
              containerXp = `//*[@id='${escId(container.id)}']`;
            } else if (container && container.classList.length) {
              const top2 = Array.from(container.classList).slice(0,2)
                .map(c => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`).join(' and ');
              containerXp = top2 ? `//*[${top2}]` : '//*';
            } else {
              containerXp = '//*';
            }
            const aCls = Array.from(a.classList || []).filter(c => c && !/^\d+$/.test(c)).slice(0,2);
            let aPred = '';
            if (aCls.length) {
              aPred = aCls.map(c => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`).join(' and ');
            } else {
              aPred = `@href and not(starts-with(@href,'#'))`;
            }
            return `${containerXp}//a[${aPred}]`;
          }

          const mm = (e) => { if (picking) placeOverlay(e.target); };
          const ck = (e) => {
            if (!picking) return;
            e.preventDefault(); e.stopPropagation();
            picking = false;

            let xp = buildGeneralizedSeedXPath(e.target);
            if (!xp) {
              hideOverlay();
              document.removeEventListener('mousemove', mm, true);
              document.removeEventListener('click', ck, true);
              sendResponse({ ok:false, error:'failed to build xpath' });
              return;
            }
            xp = deindex(xp);
            let count = 0;
            try {
              const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              count = snap.snapshotLength;
            } catch(_){}

            hideOverlay();
            document.removeEventListener('mousemove', mm, true);
            document.removeEventListener('click', ck, true);
            sendResponse({ ok:true, xpath: xp, hits: count });
          };

          document.addEventListener('mousemove', mm, true);
          document.addEventListener('click', ck, true);
          return true; // async
        }

        // 次URL推定
        case 'GS_FIND_NEXT_URL': {
          const r = gs_findNextUrlHeuristic();
          if (r.url) sendResponse({ ok:true, url: r.url, via: r.via });
          else sendResponse({ ok:false, reason:'notfound' });
          return true;
        }

        // 手入力XPathで直接抽出
        case 'GS_EXTRACT_USING_XPATH': {
          const opts = (msg.opts && msg.opts.extract) || { text: true, trim: true };
          const xp = (msg.xpath || '').trim();
          if (!xp) { sendResponse({ ok: false, error: 'xpath未指定' }); return true; }

          const query = normalizeXPathForEval(xp);
          let snap;
          try {
            snap = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          } catch (e) {
            console.error('[GS] XPath評価エラー:', e, 'query=', query);
            sendResponse({ ok: false, error: 'XPath評価エラー: ' + e.message });
            return true;
          }
          const rows = [];
          for (let i = 0; i < snap.snapshotLength; i++) {
            const el = snap.snapshotItem(i);
            const row = {};
            if (opts.text) row.text = opts.trim ? (el.innerText || el.textContent || '').trim() : (el.innerText || el.textContent || '');
            if (opts.html) row.html = el.innerHTML || '';
            if (opts.href) row.href = (el.closest('a')?.href) || el.getAttribute('href') || '';
            if (opts.src)  row.src  = el.getAttribute('src') || '';
            row.tag = (el.tagName || '').toLowerCase();
            rows.push(row);
          }
          sendResponse({ ok: true, items: rows, count: rows.length });
          return true;
        }

        // クリック → XPath生成 → 値(1件)プレビュー
        case 'GS_PICK_PREVIEW_ADD_ONCE': {
          const attr = (msg.attr || 'text');
          const proc = (msg.proc || 'text');

          let picking = true;
          const mm = (e) => { if (picking) placeOverlay(e.target); };
          const ck = (e) => {
            if (!picking) return;
            e.preventDefault(); e.stopPropagation();

            const el = e.target;
            let xp = null;
            if (el.tagName && el.tagName.toLowerCase() === 'td') {
              xp = buildHeaderLinkedXPath(el);
            }
            if (!xp) xp = getUniqueXPath(el);

            const raw = getValueByAttr(el, attr);
            const val = gs_applyProc(raw, proc);

            sendResponse({ ok: true, values: [val], countTotal: 1, xpathUsed: xp });

            picking = false; hideOverlay();
            document.removeEventListener('mousemove', mm, true);
            document.removeEventListener('click', ck, true);
          };

          document.addEventListener('mousemove', mm, true);
          document.addEventListener('click', ck, true);
          return true; // async
        }

        // 事前プレビュー
        case 'GS_PREVIEW_XPATH': {
          const xp = (msg.xpath || '').trim();
          const attr = (msg.attr || 'text').trim();
          const proc = (msg.proc || 'text').trim();
          if (!xp) { sendResponse({ ok: false, error: 'XPath未指定' }); return true; }

          const query = normalizeXPathForEval(xp);
          const snap = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const out = [];
          for (let i = 0; i < snap.snapshotLength && i < 10; i++) {
            const el = snap.snapshotItem(i);
            const raw = getValueByAttr(el, attr);
            out.push(gs_applyProc(raw, proc));
          }
          sendResponse({ ok: true, values: out, countTotal: snap.snapshotLength });
          return true;
        }

        // スキーマ一括抽出
        case 'GS_EXTRACT_SCHEMA_XPATHS': {
          const schema = msg.schema;
          const singleRow = !!msg.singleRow;
          const reqId = msg.reqId || null;
          runSchemaExtract(schema, singleRow).then((res)=> {
            if (!res || !res.ok) {
              sendResponse({ ok:false, error: res?.error || 'extract failed', reqId, pageUrl: String(location.href || '') });
              return;
            }
            sendResponse({
              ok: true,
              items: res.items,
              debug: res.debug,
              reqId,
              pageUrl: String(location.href || '')
            });
          });
          return true; // async
        }

        // 現在タブのURL
        case 'GS_GET_PAGE_URL': {
          sendResponse({ ok: true, url: String(location.href || '') });
          return true;
        }

        // 遅延ロード待ち
        case 'GS_WAIT_SCHEMA_READY': {
          const schema = msg.schema || { fields: [] };
          const minHits = Math.max(1, msg.minHits || 1);
          const timeoutMs = msg.timeoutMs || 15000;
          const intervalMs = msg.intervalMs || 300;
          const tsOpt = msg.textStable || null;

          const start = Date.now();
          let lastVal = '';
          let lastChangeAt = Date.now();

          function okTextStable() {
            if (!tsOpt || !tsOpt.xpath) return true;
            const xp = (tsOpt.xpath || '').trim();
            const attr = (tsOpt.attr || 'text').trim();
            const minLen = tsOpt.minLength || 1;
            const contains = tsOpt.contains;
            const stableMs = tsOpt.stableMs || 600;

            let snap;
            try {
              const query = normalizeXPathForEval(xp);
              snap = document.evaluate(query, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            } catch (_e) { return false; }

            const el = snap.singleNodeValue;
            if (!el) return false;
            const raw = getValueByAttr(el, attr);
            const val = (raw ?? '').toString();

            if (val.length < minLen) return false;
            if (contains && !val.includes(contains)) return false;

            const now = Date.now();
            if (val !== lastVal) {
              lastVal = val;
              lastChangeAt = now;
              return false;
            }
            return (now - lastChangeAt) >= stableMs;
          }

          function okMinHits() {
            let hits = 0;
            for (const f of (schema.fields || [])) {
              const xp = (f.xpath || '').trim();
              if (!xp) continue;
              try {
                const query = normalizeXPathForEval(xp);
                const snap = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                if (snap.snapshotLength > 0) hits++;
              } catch (_e) {}
              if (hits >= minHits) return true;
            }
            return false;
          }

          const timer = setInterval(() => {
            const readyHits = okMinHits();
            const readyText = okTextStable();
            if (readyHits && readyText) {
              clearInterval(timer);
              sendResponse({ ok: true, ready: true, tookMs: Date.now() - start });
            } else if (Date.now() - start >= timeoutMs) {
              clearInterval(timer);
              sendResponse({ ok: false, ready: false, tookMs: Date.now() - start, reason: 'timeout' });
            }
          }, intervalMs);

          return true;
        }

        default:
          return false;
      }
    } catch (err) {
      console.error('[GS] onMessage exception:', err);
      try { sendResponse({ ok: false, error: String(err) }); } catch (_) {}
      return true;
    }
  });

  // ==== Mini Builder Panel (inline) ====
  (() => {
    // ミニビルダーはトップフレームのみ（iframe内では作らない）
    if (window.self !== window.top) return;
    let panel, picking = false, mm, ck, overlay;

    const ATTRS = ['text','html','href','src'];
    const PROCS = [
      {v:'text', label:'そのまま'},
      {v:'digits', label:'数字のみ'},
      {v:'yenToMan', label:'円→万円'},
      {v:'dateYmd', label:'日付(YYYY/MM/DD)'},
      {v:'normalizeSpace', label:'空白正規化'},
      {v:'noSpaces', label:'空白除去'},
      {v:'noNewlines', label:'改行除去'}
    ];


    // --- background へ送る小ユーティリティ（エラー握りつぶし防止） ---
       // --- background へ送る薄いラッパ（再帰禁止・外部変数に触らない） ---
    function sendToBg(msg, cb){
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          cb && cb({ ok:false, error: chrome.runtime.lastError.message });
        } else {
          cb && cb(resp || { ok:false });
        }
      });
    }


    function ensureOverlayLocal(){
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute;outline:2px solid #34c759;outline-offset:1px;z-index:2147483646;pointer-events:none;';
        document.documentElement.appendChild(overlay);
      }
    }
    function placeOverlayLocal(el){
      const r = el.getBoundingClientRect(); ensureOverlayLocal();
      overlay.style.display='block';
      overlay.style.left = (window.scrollX + r.x) + 'px';
      overlay.style.top  = (window.scrollY + r.y) + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
    }
    function hideOverlayLocal(){ if (overlay) overlay.style.display='none'; }

    function setNextTipVisible(v){
      const tip = panel?.querySelector('#gs_mb_nexttip');
      if (tip) tip.style.display = v ? 'block' : 'none';
    }

    // position() の付与/置換（末尾）
    function setXPathPosition(xp, n) {
      if (!xp) return xp;
      const s = String(xp);
      if (/\[position\(\)\s*=\s*\d+\]\s*$/.test(s)) {
        return s.replace(/\[position\(\)\s*=\s*\d+\]\s*$/, `[position()=${n}]`);
      }
      return s + `[position()=${n}]`;
    }
    // contains(@href,'token') を a[...] の述語へ追加
    function addHrefContains(xp, token) {
      const tok = String(token || '').trim();
      if (!xp || !tok) return xp;
      if (new RegExp(`contains\\(\\s*@href\\s*,\\s*['"]${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]\\s*\\)`).test(xp)) {
        return xp;
      }
      const m = xp.match(/(.*\/\/a\[[^\]]*)(\].*)$/);
      if (m) {
        return `${m[1]} and contains(@href,'${tok.replace(/'/g, "\\'")}')${m[2]}`;
      }
      return xp.replace(/\s+$/, '') + `[contains(@href,'${tok.replace(/'/g, "\\'")}')]`;
    }
    function getXPathPosition(xp) {
      const m = String(xp || '').match(/\[position\(\)\s*=\s*(\d+)\]/);
      return m ? parseInt(m[1], 10) || 1 : 1;
    }

    function buildPanel(){
      const exist = document.getElementById('GS__mini_builder');
      if (exist) { panel = exist; return panel; }
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = 'GS__mini_builder';
      panel.style.cssText = `
       position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
       width: min(92vw, 420px); max-height: 80vh;
       display: flex; flex-direction: column;
       background: #fff; color:#111; border:1px solid #ddd; border-radius:10px;
       box-shadow: 0 8px 24px rgba(0,0,0,.18);
       font: 12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Noto Sans JP,sans-serif;
     `;
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #eee; flex: 0 0 auto;">
          <strong>GUI Scraper – Builder</strong>
          <div style="display:flex;gap:6px;align-items:center;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
              <input id="gs_mb_single" type="checkbox" /> SingleRow
            </label>
            <button id="gs_mb_close" title="閉じる" style="border:none;background:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;">×</button>
          </div>
        </div>

        <div id="gs_mb_body" style="padding:10px; overflow:auto; flex: 1 1 auto;">

          <hr style="margin:10px 0; border:none; border-top:1px solid #eee;" />
          <div style="font-weight:bold;margin:6px 0 2px;">Step 1：URL収集（一覧→詳細URLのCSV化）</div>

          <textarea id="gs_crawl_seeds" rows="2" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;"
            placeholder="1行1URLで貼り付け"></textarea>

          <div style="display:flex;gap:6px;margin-top:6px;">
            <input id="gs_crawl_seedxp" type="text"
                  style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;"
                  placeholder="（任意）シード用XPath（都道府県など）" />
            <button id="gs_pick_seedxp"
                    style="padding:8px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">
              シードをクリック
            </button>
          </div>
          <div class="small" style="margin-top:4px;color:#666;">
            ※ seedXPath / シードCSV / テキストエリア の<strong>いずれか</strong>があればOK（併用も可）
          </div>

          <div style="display:flex;gap:6px;margin-top:6px;">
            <input id="gs_crawl_linkxp" type="text" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;"
                  placeholder="//div[@class='card']//a[@href]" />
            <button id="gs_pick_linkxp" style="padding:8px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">リンクをクリック</button>
          </div>

          <div style="display:flex;gap:10px;align-items:center;margin-top:6px;">
            <label class="small" style="display:flex;gap:6px;align-items:center;">
              position(N):
              <input id="gs_link_position_n" type="number" min="1" value="1"
                    style="width:64px;padding:4px;border:1px solid #ddd;border-radius:6px;">
            </label>
            <button id="gs_pos_dec" style="padding:6px 10px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;">–</button>
            <button id="gs_pos_inc" style="padding:6px 10px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;">＋</button>
            <span class="small" style="color:#666;">（カード内のN番目のリンクを拾う）</span>
          </div>

          <div style="display:flex; gap:6px; align-items:center; margin-top:6px;">
            <label style="flex:1;">hrefに含める語（任意 1語）
              <input id="gs_require_href_contains" type="text" placeholder="/detail/ など"
                    style="width:100%; padding:6px; border:1px solid #ddd; border-radius:6px;">
            </label>
          </div>
          <div class="small" style="margin-top:4px;color:#666;">
            ※ positionは「カード内で何番目のリンクか」を指定します。href語は <code>contains(@href,'語')</code> をAND追加します。
          </div>

          <div style="display:flex;gap:6px;margin-top:6px;">
            <input id="gs_crawl_nextxp" type="text" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;"
                  placeholder="//a[@rel='next' or contains(normalize-space(.),'次')][@href]" />
            <button id="gs_pick_nextxp" style="padding:8px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">次へをクリック</button>
            <button id="gs_crawl_dryrun" style="padding:8px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">ドライラン（このページ）</button>
          </div>

          <div class="small" style="margin-top:4px;">
            ※ クリック対象は <code>&lt;a&gt;</code> を選んでください（収集は <code>href</code> を使用）
          </div>

          <div class="small" style="display:flex;gap:12px;align-items:center;margin-top:6px;">
            <label><input id="gs_crawl_samehost" type="checkbox" checked> 同一ホストのみ</label>
            <label>最大ページ: <input id="gs_crawl_maxpages" type="number" value="40" style="width:72px;"></label>
            <label>最大URL: <input id="gs_crawl_maxurls"  type="number" value="5000" style="width:96px;"></label>
          </div>

          <div style="margin-top:6px;">
            <label class="small">
              ページ送りキー（カンマ区切り）例: p,page,pg
              <input id="gs_crawl_pagekeys" type="text" value="p" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;">
            </label>
          </div>

          <div style="margin-top:8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <input id="gs_seed_csv" type="file" accept=".csv,text/csv" style="flex:1;" />
            <button id="gs_seed_load" style="padding:6px 10px;">種CSVを読み込み</button>
            <span id="gs_seed_info" class="small" style="color:#666;"></span>
          </div>

          <div style="display:flex;gap:6px;margin-top:8px;">
            <button id="gs_run_crawl" style="flex:1;padding:8px;border:none;background:#34c759;color:#fff;border-radius:8px;cursor:pointer;">URL収集開始</button>
          </div>

          <div id="gs_crawl_status" class="small" style="margin-top:6px;color:#333;"></div>

          <div style="margin-bottom:8px;">
            <label>カラム名</label>
            <div style="font-weight:bold;margin:10px 0 2px;">Step 2：詳細ページの項目抽出（スキーマ）</div>
            <input id="gs_mb_name" type="text" placeholder="例：住所" style="width:100%;padding:6px;margin-top:2px;border:1px solid #ddd;border-radius:6px;">
          </div>
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button id="gs_mb_pick"  style="flex:1;padding:8px;border:none;background:#34c759;color:#fff;border-radius:8px;cursor:pointer;">クリックで取得 → 追加</button>
            <button id="gs_mb_extract" style="padding:8px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">スキーマで抽出</button>
          </div>

          <div style="margin:10px 0; padding:8px; border:1px solid #eee; border-radius:8px;">
            <div style="font-weight:bold;margin-bottom:6px;">手入力（XPath直書き）で追加</div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
              <input id="gs_mi_name" type="text" placeholder="カラム名（例：会社名）" style="flex:0 0 34%; padding:6px; border:1px solid #ddd; border-radius:6px;">
              <input id="gs_mi_xpath" type="text" placeholder="//h1 | //table//tr[th[...]]/td[1]" style="flex:1; padding:6px; border:1px solid #ddd; border-radius:6px;">
            </div>
            <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
              <label>attr:
                <select id="gs_mi_attr" style="padding:6px; border:1px solid #ddd; border-radius:6px;">
                  <option value="text" selected>text</option>
                  <option value="html">html</option>
                  <option value="href">href</option>
                  <option value="src">src</option>
                </select>
              </label>
              <label>proc:
                <select id="gs_mi_proc" style="padding:6px; border:1px solid #ddd; border-radius:6px;">
                  <option value="text" selected>そのまま</option>
                  <option value="normalizeSpace">空白正規化</option>
                  <option value="digits">数字のみ</option>
                  <option value="yenToMan">円→万円</option>
                  <option value="dateYmd">日付(YYYY/MM/DD)</option>
                  <option value="noSpaces">空白除去</option>
                  <option value="noNewlines">改行除去</option>
                </select>
              </label>
              <button id="gs_mi_preview" style="padding:8px; border:1px solid #ddd; background:#fff; border-radius:8px; cursor:pointer;">プレビュー</button>
              <button id="gs_mi_add" style="padding:8px; border:none; background:#34c759; color:#fff; border-radius:8px; cursor:pointer;">追加</button>
            </div>
            <div id="gs_mi_out" class="small" style="color:#333;"></div>
          </div>

          <div style="margin:8px 0;">
            <div style="font-weight:bold;margin-bottom:4px;">登録済みスキーマ</div>
            <div id="gs_mb_schema" style="max-height:120px;overflow:auto;border:1px solid #eee;border-radius:6px;"></div>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button id="gs_mb_clear"  style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">クリア</button>
              <button id="gs_mb_json"   style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">JSON</button>
              <button id="gs_mb_csv"    style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">CSV</button>
            </div>
          </div>

          <div style="font-weight:bold;margin:10px 0 2px;">Step 2.5：このページでプレビュー</div>
          <div id="gs_mb_preview" style="padding:8px;background:#fafafa;border:1px dashed #ddd;border-radius:8px;min-height:38px;">
            <div class="small" style="color:#666;">（ここにクリックプレビュー / 抽出結果が表示されます）</div>
          </div>

          <div id="gs_mb_status" class="small" style="margin-top:6px;color:#333;"></div>

          <div id="gs_mb_nexttip" class="small"
               style="display:none;margin-top:8px;padding:8px;border:1px solid #e6f0ff;background:#f6faff;border-radius:6px;color:#1e60d1;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span>✅ カラムが指定されました。追加するカラムがない場合はもう一度拡張機能を開いて、プレビュー／一括取得など次の工程へ。</span>
              <button id="gs_mb_nexttip_close"
                      style="border:none;background:#e6f0ff;color:#1e60d1;border-radius:6px;padding:2px 6px;cursor:pointer;">
                OK
              </button>
            </div>
          </div>
        </div>
      `;

      // const _cssFix = `
      //   #GS__mini_builder, #GS__mini_builder * {
      //     box-sizing: border-box;
      //     font: 12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Noto Sans JP,sans-serif !important;
      //     color: #111 !important;
      //   }
      //   #GS__mini_builder input,
      //   #GS__mini_builder textarea,
      //   #GS__mini_builder select {
      //     color: #111 !important;
      //     background: #fff !important;
      //     border: 1px solid #ddd !important;
      //   }
      //   #GS__mini_builder input::placeholder,
      //   #GS__mini_builder textarea::placeholder { color: #999 !important; }
      //   #GS__mini_builder button {
      //     color: #111 !important;
      //     background: #fff !important;
      //   }
      //   #GS__mini_builder .small { color: #666 !important; }
      //   `;
      //   const styleFix = document.createElement('style');
      //   styleFix.id = 'gs_mb_isolate';
      //   styleFix.textContent = _cssFix;
      //   panel.prepend(styleFix);

      function setCrawlStatus(t){
        const el = panel?.querySelector('#gs_crawl_status');
        if (el) el.textContent = t || '';
      }

      // 簡易ピッカー（a をクリック）
      function pickHrefXPathOnce(onPicked){
        let picking = true;
        const mm = (e)=>{ if(picking) placeOverlay(e.target); };
        const ck = (e)=>{
          if (!picking) return;
          e.preventDefault(); e.stopPropagation();
          picking = false;
          hideOverlay();
          document.removeEventListener('mousemove', mm, true);
          document.removeEventListener('click', ck, true);

          const a = e.target.closest('a');
          if (!a) { setCrawlStatus('a要素をクリックしてください'); return; }

          const href = a.href || a.getAttribute('href') || '';
          const xpCandidate = getUniqueXPath(a) || '';

          onPicked && onPicked({ anchor: a, href, xpCandidate });

          try {
            const q = normalizeXPathForEval(xpCandidate);
            const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            setCrawlStatus(`ヒット数: ${snap.snapshotLength} / 例: ${href}`);
          } catch(e){
            setCrawlStatus(`XPath評価エラー: ${e.message}`);
          }
        };
        document.addEventListener('mousemove', mm, true);
        document.addEventListener('click', ck, true);

        const esc = (ev)=>{
          if (ev.key === 'Escape') {
            picking = false;
            hideOverlay();
            document.removeEventListener('mousemove', mm, true);
            document.removeEventListener('click', ck, true);
            window.removeEventListener('keydown', esc, true);
            setCrawlStatus('キャンセルしました');
          }
        };
        window.addEventListener('keydown', esc, true);
      }

      // クリックした <a> から汎化XPathを作る（カード内N番目）
      function smartifyLinkXPathFromAnchor(a) {
        if (!a) {
          return "//*//a[@href and " +
            "not(starts-with(@href,'#')) and " +
            "not(starts-with(@href,'tel:')) and " +
            "not(starts-with(@href,'javascript:')) and " +
            "not(starts-with(@href,'mailto:'))][1]";
        }

        function stableIdPrefix(id) {
          if (!id) return '';
          let p = String(id);
          p = p.replace(/(?:_\d+)+$/, '');
          p = p.replace(/\d+$/, '');
          return p;
        }
        function normClassToken(c) {
          if (!c) return '';
          let t = String(c);
          t = t.split('___')[0].split('__')[0].split('--')[0];
          return t;
        }
        function classPredicateFrom(el, max = 2) {
          if (!el || !el.classList) return '';
          const toks = [];
          for (const raw of Array.from(el.classList)) {
            const base = normClassToken(raw);
            if (base && !/^\d+$/.test(base) && !toks.includes(base)) {
              toks.push(base);
            }
            if (toks.length >= max) break;
          }
          return toks.length
            ? toks.map(t => `contains(concat(' ', normalize-space(@class), ' '), ' ${t} ')`).join(' and ')
            : '';
        }

        function pickContainerInfo(anchor) {
          const ancestors = [];
          let n = anchor.parentElement;
          while (n && n !== document.body) { ancestors.push(n); n = n.parentElement; }

          let bestXp = '';
          let bestEl = null;
          let bestScore = 0;

          for (const el of ancestors) {
            const tag = (el.tagName || '*').toLowerCase();

            if (el.id) {
              const pref = stableIdPrefix(el.id);
              if (pref) {
                const count = document.querySelectorAll(`[id^="${pref}"]`).length | 0;
                if (count >= 2 && count > bestScore) {
                  const sw = /_$/.test(pref) ? pref : pref + '_';
                  bestXp    = `//${tag}[@id and starts-with(@id,'${sw.replace(/'/g, "\\'")}')]`;
                  bestEl    = el;
                  bestScore = count;
                  continue;
                }
              }
            }

            const pred = classPredicateFrom(el, 2);
            if (pred) {
              let count = 0;
              try {
                count = document.evaluate(`count(//${tag}[${pred}])`, document, null, XPathResult.NUMBER_TYPE, null).numberValue | 0;
              } catch(_) {}
              if (count >= 2 && count > bestScore) {
                bestXp    = `//${tag}[${pred}]`;
                bestEl    = el;
                bestScore = count;
              }
            }
          }

          if (!bestXp) {
            const cont = anchor.closest('article, li, section, div, main') || document.body;
            const tag  = (cont.tagName || '*').toLowerCase();
            const cPred = classPredicateFrom(cont, 2);
            bestXp = cPred ? `//${tag}[${cPred}]` : `//${tag}`;
            bestEl = cont;
          }
          return { containerXp: bestXp, containerEl: bestEl };
        }

        const { containerXp, containerEl } = pickContainerInfo(a);

        let aClassPred = (function(ac){
          const toks = [];
          for (const raw of Array.from(ac || [])) {
            const base = normClassToken(raw);
            if (base && !/^\d+$/.test(base) && !toks.includes(base)) toks.push(base);
            if (toks.length >= 2) break;
          }
          return toks.length ? toks.map(t => `contains(concat(' ', normalize-space(@class), ' '), ' ${t} ')`).join(' and ') : '';
        })(a.classList);

        const titleish = ['title','name','detail','shop','store','result__title','style_titleLink'];
        if (!aClassPred) {
          const toks = Array.from(a.classList || [])
            .map(x => x && x.toString()).filter(Boolean)
            .filter(t => titleish.some(k => t.toLowerCase().includes(k)))
            .slice(0, 2);
          if (toks.length) {
            aClassPred = toks.map(t => `contains(concat(' ', normalize-space(@class), ' '), ' ${t} ')`).join(' and ');
          }
        }

        let hrefHeadPred = '';
        const href = a.href || a.getAttribute('href') || '';
        if (href) {
          try {
            const u = new URL(href, location.href);
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
              const head = '/' + parts.slice(0, Math.min(parts.length, 3)).join('/') + '/';
              hrefHeadPred = `contains(@href, '${head.replace(/'/g, "\\'")}')`;
            } else if (parts.length === 1) {
              const head = '/' + parts[0] + '/';
              hrefHeadPred = `contains(@href, '${head.replace(/'/g, "\\'")}')`;
            }
          } catch(_) {}
        }

        const basePred = "@href and " +
          "not(starts-with(@href,'#')) and " +
          "not(starts-with(@href,'tel:')) and " +
          "not(starts-with(@href,'javascript:')) and " +
          "not(starts-with(@href,'mailto:'))";

        const aPred = aClassPred
          ? `(${basePred}) and (${aClassPred})`
          : (hrefHeadPred ? `(${basePred}) and (${hrefHeadPred})` : basePred);

        let pos = 1;
        try {
          const selector = "a[href]:not([href^='#']):not([href^='tel:']):not([href^='javascript:']):not([href^='mailto:'])";
          const all = Array.from((containerEl || document).querySelectorAll(selector));
          const filtered = all.filter(el => {
            let ok = true;
            if (aClassPred) {
              const toks = (aClassPred.match(/' ([^']+) '/g)?.map(s => s.slice(2, -2)) || []);
              ok = toks.every(t => el.classList && Array.from(el.classList).some(c => (c || '').toString().includes(t)));
            }
            if (ok && hrefHeadPred) {
              const m = hrefHeadPred.match(/'([^']+)'/);
              if (m) ok = (el.getAttribute('href') || el.href || '').includes(m[1]);
            }
            return ok;
          });
          const idx = filtered.indexOf(a);
          if (idx >= 0) pos = idx + 1;
        } catch(_) {}

        return `(${containerXp})/descendant::a[${aPred}][position()=${pos}]`;
      }

      // ── UI: リンク/次へ クリックで取得
      panel.querySelector('#gs_pick_linkxp')?.addEventListener('click', ()=>{
        pickHrefXPathOnce(({ anchor })=>{
          const input = panel.querySelector('#gs_crawl_linkxp');
          if (!anchor || !input) { setCrawlStatus('取得に失敗しました'); return; }
          const xp = smartifyLinkXPathFromAnchor(anchor);
          input.value = xp;

          // position をUIに反映
          try {
            const m = xp.match(/position\(\)\s*=\s*(\d+)(?![\s\S]*position\(\))/);
            const posEl = panel.querySelector('#gs_link_position_n');
            if (m && posEl) { posEl.value = String(m[1]); }
          } catch(_) {}

          chrome.storage.local.set({ gs_crawl_linkXPath: xp });

          try {
            const q = normalizeXPathForEval(xp);
            const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            setCrawlStatus(`リンクXPathを設定しました（ヒット ${snap.snapshotLength} 件）`);
          } catch(e) {
            setCrawlStatus('リンクXPathを設定しました（プレビュー失敗: ' + e.message + '）');
          }
        });
      });

      panel.querySelector('#gs_pick_nextxp')?.addEventListener('click', ()=>{
        pickHrefXPathOnce(()=>{
          const input = panel.querySelector('#gs_crawl_nextxp');
          if (input) input.value = "//a[@href and (@rel='next' or contains(normalize-space(.),'次') or contains(@aria-label,'次') or contains(translate(normalize-space(.),'NEXT','next'),'next'))]";
          setCrawlStatus('次へXPathを設定しました');
        });
      });

      // --- position(N) と XPath を同期（＋/− 対応）
      (function wirePositionControls(){
        const posEl = panel.querySelector('#gs_link_position_n');
        const decBtn = panel.querySelector('#gs_pos_dec');
        const incBtn = panel.querySelector('#gs_pos_inc');
        const linkInput = panel.querySelector('#gs_crawl_linkxp');

        if (!linkInput || !posEl) return;

        function applyPositionAndPreview(n){
          const nn = Math.max(1, parseInt(n || '1', 10));
          posEl.value = String(nn);
          const xp0 = (linkInput.value || '').trim();
          if (!xp0) return;
          const xp1 = setXPathPosition(xp0, nn);
          linkInput.value = xp1;

          try {
            const q = normalizeXPathForEval(xp1);
            const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            setCrawlStatus(`リンクXPathを更新（position=${nn} / ヒット ${snap.snapshotLength} 件）`);
          } catch (e) {
            setCrawlStatus(`リンクXPath更新 / プレビュー失敗: ${e.message}`);
          }
        }

        posEl.addEventListener('change', () => {
          const n = parseInt(posEl.value || '1', 10) || 1;
          applyPositionAndPreview(n);
        });

        decBtn?.addEventListener('click', () => {
          const cur = parseInt(posEl.value || '1', 10) || 1;
          const next = Math.max(1, cur - 1);
          applyPositionAndPreview(next);
        });

        incBtn?.addEventListener('click', () => {
          const cur = parseInt(posEl.value || '1', 10) || 1;
          applyPositionAndPreview(cur + 1);
        });
      })();

      // 種CSVの読み込み
      let __gsCrawlSeeds = [];
      function parseCsvLinesToUrls(text){
        const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const out = [];
        for (const ln of lines) {
          let cell = ln;
          if (ln.includes(',')) cell = ln.split(',')[0].replace(/^"|"$/g,'').trim();
          if (/^https?:\/\//i.test(cell)) out.push(cell);
        }
        return out;
      }
      panel.querySelector('#gs_seed_load')?.addEventListener('click', () => {
        const input = panel.querySelector('#gs_seed_csv');
        const info  = panel.querySelector('#gs_seed_info');
        if (!input?.files?.length) { if (info) info.textContent = 'CSVファイルを選択してください'; return; }
        const file = input.files[0];
        const reader = new FileReader();
        reader.onload = () => {
          __gsCrawlSeeds = parseCsvLinesToUrls(reader.result);
          chrome.storage.local.set({ gs_crawl_seeds: __gsCrawlSeeds, gs_crawl_seeds_meta: { name: file.name, at: Date.now() }}, () => {
            if (info) info.textContent = `読み込み: ${__gsCrawlSeeds.length}件（${file.name}）`;
          });
        };
        reader.onerror = () => { if (info) info.textContent = 'CSV読み込みに失敗しました'; };
        reader.readAsText(file, 'utf-8');
      });

    
      // ▼ シードXPath クリック取得（content内で完結：メッセ不要）
      panel.querySelector('#gs_pick_seedxp')?.addEventListener('click', () => {
        // 1) 一回だけ <a> をピック
        let picking = true;
        const mm = (e)=>{ if(picking) placeOverlayLocal(e.target); };
        const done = () => {
          picking = false;
          hideOverlayLocal();
          document.removeEventListener('mousemove', mm, true);
          document.removeEventListener('click', ck, true);
          window.removeEventListener('keydown', esc, true);
        };
        const esc = (ev)=>{ if (ev.key === 'Escape') { done(); setCrawlStatus('キャンセルしました'); } };

        function buildGeneralizedSeedXPathFromAnchor(a){
          // a を含む“まとまり”から a を一般化（ID/クラスをなるべく安定に）
          const esc = (s)=> String(s).replace(/'/g,"\\'");
          function normClassToken(c){ return String(c||'').split('___')[0].split('__')[0].split('--')[0]; }
          function classPred(el, max=2){
            if (!el || !el.classList) return '';
            const toks = [];
            for (const raw of Array.from(el.classList)) {
              const t = normClassToken(raw);
              if (t && !/^\d+$/.test(t) && !toks.includes(t)) toks.push(t);
              if (toks.length >= max) break;
            }
            return toks.length ? toks.map(t => `contains(concat(' ', normalize-space(@class), ' '), ' ${t} ')`).join(' and ') : '';
          }

          // 近い容器（nav/section/aside/main/div/ul/li/article 等）を上に辿って「繰り返し」になってるところを拾う
          let n = a.parentElement, picked = '';
          while (n && n !== document.body) {
            const tag = (n.tagName || '*').toLowerCase();
            // idの安定プレフィックス
            if (n.id && !/^\d+$/.test(n.id)) {
              const pref = n.id.replace(/(?:_\d+)+$/,'').replace(/\d+$/,'');
              if (pref) { picked = `//${tag}[@id and starts-with(@id,'${esc(pref)}')]`; break; }
            }
            // クラスの繰り返し
            const pred = classPred(n, 2);
            if (pred) { picked = `//${tag}[${pred}]`; break; }
            n = n.parentElement;
          }
          if (!picked) {
            const cont = a.closest('article, li, section, div, main, nav, ul') || document.body;
            const tag  = (cont.tagName || '*').toLowerCase();
            const pred = classPred(cont, 2);
            picked = pred ? `//${tag}[${pred}]` : `//${tag}`;
          }

          // a の述語（href 有効 + 可能なら同系統のパス頭）
          let hrefHeadPred = '';
          const href = a.href || a.getAttribute('href') || '';
          if (href) {
            try {
              const u = new URL(href, location.href);
              const parts = u.pathname.split('/').filter(Boolean);
              if (parts.length) {
                const head = '/' + parts[0] + '/';
                hrefHeadPred = `contains(@href,'${esc(head)}')`;
              }
            } catch(_) {}
          }
          const basePred = "@href and not(starts-with(@href,'#')) and not(starts-with(@href,'tel:')) and not(starts-with(@href,'javascript:')) and not(starts-with(@href,'mailto:'))";
          const aPred = hrefHeadPred ? `(${basePred}) and (${hrefHeadPred})` : basePred;

          return `${picked}//a[${aPred}]`;
        }

        const ck = (e) => {
          if (!picking) return;
          e.preventDefault(); e.stopPropagation();
          const a = e.target.closest('a');
          if (!a) { setCrawlStatus('a要素をクリックしてください'); return; }

          const xp = buildGeneralizedSeedXPathFromAnchor(a);
          const inp = panel.querySelector('#gs_crawl_seedxp');
          if (inp) inp.value = xp;

          // ヒット数を表示
          try {
            const q = normalizeXPathForEval(xp);
            const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            setCrawlStatus(`シードXPathを設定しました（ヒット ${snap.snapshotLength}）`);
          } catch (e) {
            setCrawlStatus('シードXPath設定（プレビュー失敗）: ' + e.message);
          }
          done();
        };

        document.addEventListener('mousemove', mm, true);
        document.addEventListener('click', ck, true);
        window.addEventListener('keydown', esc, true);
        setCrawlStatus('シード（都道府県など）の <a> をクリックしてください（Escでキャンセル）');
      });


      // ▼ ドライラン（このページ）— 1回だけバインド
      panel.querySelector('#gs_crawl_dryrun')?.addEventListener('click', () => {
        const linkXpInput = panel.querySelector('#gs_crawl_linkxp');
        const nextXpInput = panel.querySelector('#gs_crawl_nextxp');
        const linkXP = (linkXpInput?.value || '').trim();
        if (!linkXP) { setCrawlStatus('ドライラン: まず「リンクXPath」を指定してください'); return; }

        let total = 0, valid = 0, invalid = 0;
        const tagCount = Object.create(null);

        try {
          const q = normalizeXPathForEval(linkXP);
          const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          total = snap.snapshotLength;

          for (let i = 0; i < snap.snapshotLength; i++) {
            const el = snap.snapshotItem(i);
            if (!el) continue;
            const tag = (el.tagName || '').toLowerCase();
            tagCount[tag] = (tagCount[tag] || 0) + 1;

            const href = (el.closest('a')?.href) || el.getAttribute?.('href') || '';
            const h = (href || '').trim();
            const isInvalid =
              !h ||
              h.startsWith('#') ||
              h.startsWith('tel:') ||
              h.startsWith('javascript:') ||
              h.startsWith('mailto:');

            if (isInvalid) invalid++;
            else valid++;
          }
        } catch (e) {
          setCrawlStatus(`ドライラン: XPath評価エラー: ${e.message}`);
          return;
        }

        let nextInfo = { url: '', via: '' };

        const tryFromNextXPath = () => {
          const xp = (nextXpInput?.value || '').trim();
          if (!xp) return false;
          try {
            const q = normalizeXPathForEval(xp);
            const snap = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i=0; i<snap.snapshotLength; i++) {
              const el = snap.snapshotItem(i);
              const href = (el.closest('a')?.href) || el.getAttribute?.('href') || '';
              if (href) {
                nextInfo.url = new URL(href, location.href).href;
                nextInfo.via = 'nextXPath';
                return true;
              }
            }
          } catch (_) {}
          return false;
        };

        const tryHeuristic = () => {
          try {
            const r = gs_findNextUrlHeuristic();
            if (r && r.url) {
              nextInfo = r;
              return true;
            }
          } catch (_) {}
          return false;
        };

        if (!tryFromNextXPath()) tryHeuristic();

        const topTags = Object.entries(tagCount)
          .sort((a,b) => b[1]-a[1])
          .slice(0,3)
          .map(([k,v]) => `${k}×${v}`)
          .join(', ');

        const nextDisp = nextInfo.url ? `${nextInfo.url}（via: ${nextInfo.via}）` : 'なし';
        setCrawlStatus(`ドライラン: ヒット ${total}（有効 ${valid} / 無効 ${invalid}） | タグ: ${topTags || 'n/a'} | 次: ${nextDisp}`);
      });

      // ▼ 「保存→開始」を一本化
      // ▼ 「保存→開始」一本化（重複ハンドラを統合）
      panel.querySelector('#gs_run_crawl')?.addEventListener('click', ()=>{
        // 1) 種URL（テキストエリア）
        let seeds = (panel.querySelector('#gs_crawl_seeds')?.value || '')
          .split(/\r?\n/)
          .map(s=>s.trim())
          .filter(s=>/^https?:\/\//i.test(s));

        // 2) seedXPath / linkXPath / nextXPath
        const seedXP = (panel.querySelector('#gs_crawl_seedxp')?.value || '').trim();
        const linkXP = (panel.querySelector('#gs_crawl_linkxp')?.value || '').trim();
        const nextXP = (panel.querySelector('#gs_crawl_nextxp')?.value || '').trim();

        // 3) オプション
        const sameHost = !!panel.querySelector('#gs_crawl_samehost')?.checked;
        const maxPages = Math.max(1, parseInt(panel.querySelector('#gs_crawl_maxpages')?.value || '40',10));
        const maxUrls  = Math.max(1, parseInt(panel.querySelector('#gs_crawl_maxurls')?.value  || '5000',10));
        const pageKeysRaw = (panel.querySelector('#gs_crawl_pagekeys')?.value || 'p').trim();

        // pageParamKeys は配列で送る
        const pageKeys = pageKeysRaw
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

        // 種が無い＆seedXPathも無いなら、現在ページをフォールバック
        if (!seeds.length && !seedXP) {
          seeds = [ String(location.href || '') ];
        }

        if (!linkXP) {
          setCrawlStatus('リンクXPathが未設定です');
          return;
        }

        // 設定を保存
        const cfg = { seedXPath: seedXP, linkXPath: linkXP, nextXPath: nextXP,
                      sameHostOnly: sameHost, maxPages, maxUrls, pageParamKeys: pageKeys };
        chrome.storage.local.set({ gs_crawl_config: cfg, gs_crawl_seeds_text: seeds.join('\n') });

        // BG起動確認 → 本番送信
        setCrawlStatus('バックグラウンドの起動確認中…');
        sendToBg({ type: '__PING__' }, (pong) => {
          if (!pong?.ok) {
            setCrawlStatus('background.js が起動していません。chrome://extensions →「サービスワーカーを検査」を開いた状態で実行してください。');
            return;
          }
          // 本番起動
          sendToBg({
            type: 'GS_URLCRAWL_RUN',
            seeds,
            seedXPath: seedXP,          // あればBG側で代表ページ評価
            linkXPath: linkXP,
            nextXPath: nextXP,
            sameHostOnly: sameHost,
            maxPages,
            maxUrls,
            pageParamKeys: pageKeys,    // 配列で渡す！
            stripHash: true,
            stripQuery: false,          // ?id= を落とさない
            stripTrailingSlash: true
          }, (r) => {
            if (!r?.ok) {
              setCrawlStatus('URL収集開始エラー: ' + (r?.error || 'unknown'));
            } else {
              setCrawlStatus('設定を保存し、URL収集を開始しました…');
            }
          });
        });
      });



      // 初期値復元
      chrome.storage.local.get(['gs_crawl_config','gs_crawl_seeds_text'], (v) => {
        const cfg = v.gs_crawl_config || {};
        const seedsText = v.gs_crawl_seeds_text || '';
        const $ = (id)=> panel.querySelector(id);

        if (cfg.seedXPath && $('#gs_crawl_seedxp')) $('#gs_crawl_seedxp').value = cfg.seedXPath;
        if (cfg.linkXPath && $('#gs_crawl_linkxp')) $('#gs_crawl_linkxp').value = cfg.linkXPath;
        if (cfg.nextXPath && $('#gs_crawl_nextxp')) $('#gs_crawl_nextxp').value = cfg.nextXPath;
        if ($('#gs_crawl_samehost')) $('#gs_crawl_samehost').checked = !!cfg.sameHostOnly;
        if ($('#gs_crawl_maxpages'))  $('#gs_crawl_maxpages').value  = cfg.maxPages || 40;
        if ($('#gs_crawl_maxurls'))   $('#gs_crawl_maxurls').value   = cfg.maxUrls  || 5000;

        const pageKeys = (Array.isArray(cfg.pageParamKeys) ? cfg.pageParamKeys.join(',') : (cfg.pageParamKeys || 'p'));
        if ($('#gs_crawl_pagekeys')) $('#gs_crawl_pagekeys').value = pageKeys;

        if (seedsText && $('#gs_crawl_seeds')) $('#gs_crawl_seeds').value = seedsText;
      });

      // href 1語 → AND 追加
      const hrefInp = panel.querySelector('#gs_require_href_contains');
      function applyHrefContains() {
        const input = panel.querySelector('#gs_crawl_linkxp');
        if (!input || !input.value) { setCrawlStatus('href語: 先にリンクXPathを指定してください'); return; }
        const tok = (hrefInp.value || '').trim();
        if (!tok) { chrome.storage.local.set({ gs_crawl_requireHrefContains: '' }); setCrawlStatus('href語をクリアしました'); return; }
        const next = addHrefContains(input.value, tok);
        input.value = next;
        chrome.storage.local.set({ gs_crawl_linkXPath: next, gs_crawl_requireHrefContains: tok });
        setCrawlStatus(`hrefに '${tok}' を含む条件を追加しました（プレビュー推奨）`);
      }
      hrefInp?.addEventListener('change', applyHrefContains);
      hrefInp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyHrefContains(); });

      // ページ送りキーの保存・復元
      chrome.storage.local.get(['gs_crawl_pagekeys'], (o) => {
        const el = panel.querySelector('#gs_crawl_pagekeys');
        if (el && (o.gs_crawl_pagekeys || '').trim()) el.value = o.gs_crawl_pagekeys;
      });
      panel.querySelector('#gs_crawl_pagekeys')?.addEventListener('input', () => {
        const v = (panel.querySelector('#gs_crawl_pagekeys')?.value || 'p').trim();
        chrome.storage.local.set({ gs_crawl_pagekeys: v });
      });

      renderSchemaTable();

      // 既存設定の復元（リンクXP/position/href語）
      chrome.storage.local.get(
        ['gs_crawl_linkXPath', 'gs_crawl_preferNth', 'gs_crawl_requireHrefContains'],
        (v) => {
          const linkXP = v.gs_crawl_linkXPath || '';
          const pos = v.gs_crawl_preferNth || (linkXP ? getXPathPosition(linkXP) : 1);
          const req = v.gs_crawl_requireHrefContains || '';

          const linkInput = panel.querySelector('#gs_crawl_linkxp');
          const posEl = panel.querySelector('#gs_link_position_n');
          const hrefInp = panel.querySelector('#gs_require_href_contains');

          if (linkXP && linkInput) linkInput.value = linkXP;
          if (posEl) posEl.value = String(pos || 1);
          if (hrefInp) hrefInp.value = req || '';
        }
      );

      document.documentElement.appendChild(panel);

      panel.querySelector('#gs_mb_close').onclick = destroy;
      panel.querySelector('#gs_mb_pick').onclick  = startPick;
      panel.querySelector('#gs_mb_extract').onclick = extractBySchema;
      panel.querySelector('#gs_mb_clear').onclick  = clearSchema;
      panel.querySelector('#gs_mb_json').onclick   = downloadJSON;
      panel.querySelector('#gs_mb_csv').onclick    = downloadCSV;

      const miName  = panel.querySelector('#gs_mi_name');
      const miXPath = panel.querySelector('#gs_mi_xpath');
      const miAttr  = panel.querySelector('#gs_mi_attr');
      const miProc  = panel.querySelector('#gs_mi_proc');
      const miOut   = panel.querySelector('#gs_mi_out');

      const qxp = (xp) => normalizeXPathForEval(xp);

      panel.querySelector('#gs_mi_preview')?.addEventListener('click', () => {
        const xp = (miXPath?.value || '').trim();
        const attr = (miAttr?.value || 'text');
        const proc = (miProc?.value || 'text');
        if (!xp) { miOut.textContent = 'XPathを入力してください'; return; }
        let snap;
        try{
          snap = document.evaluate(qxp(xp), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        }catch(e){
          miOut.textContent = 'XPath評価エラー: ' + e.message;
          return;
        }
        const n = Math.min(snap.snapshotLength, 5);
        const vals = [];
        for (let i=0;i<n;i++){
          const el = snap.snapshotItem(i);
          const raw = getValueByAttr(el, attr);
          vals.push(gs_applyProc(raw, proc));
        }
        miOut.textContent = `ヒット数: ${snap.snapshotLength} / 先頭プレビュー: ${vals.join(' | ')}`;
      });

      panel.querySelector('#gs_mi_add')?.addEventListener('click', () => {
        const name = (miName?.value || '').trim();
        const xp   = (miXPath?.value || '').trim();
        const attr = (miAttr?.value || 'text');
        const proc = (miProc?.value || 'text');
        if (!name) { miOut.textContent = 'カラム名を入力してください'; return; }
        if (!xp)   { miOut.textContent = 'XPathを入力してください'; return; }

        chrome.storage.local.get(['guiScraperXPathSchema'], (obj) => {
          const schema = obj.guiScraperXPathSchema || { fields: [] };
          schema.fields.push({ name, xpath: xp, attr, proc });
          chrome.storage.local.set({ guiScraperXPathSchema: schema }, () => {
            miOut.textContent = `追加: ${name} / ${xp}`;
            if (miName)  miName.value  = '';
            if (miXPath) miXPath.value = '';
            renderSchemaTable();
          });
        });
      });

      panel.querySelector('#gs_mb_nexttip_close').onclick = () => setNextTipVisible(false);
      setNextTipVisible(false);

      function renderSchemaTable(){
        const box = panel?.querySelector('#gs_mb_schema'); if (!box) return;
        chrome.storage.local.get(['guiScraperXPathSchema'], (obj) => {
          const schema = obj.guiScraperXPathSchema || { fields: [] };
          if (!schema.fields.length) {
            box.innerHTML = '<div class="small" style="padding:6px;color:#666;">フィールド未登録</div>';
            setNextTipVisible(false);
            return;
          }
          const head = `<tr><th>順</th><th>カラム名</th><th>xpath</th><th>attr</th><th>proc</th><th></th></tr>`;
          const rows = schema.fields.map((f,i)=>`<tr>
            <td>${i+1}</td>
            <td>${f.name}</td>
            <td><code style="font-size:11px;">${(f.xpath||'').replace(/</g,'&lt;')}</code></td>
            <td>${f.attr}</td>
            <td>${f.proc}</td>
            <td><button data-del="${i}">削除</button></td>
          </tr>`).join('');
          box.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse;">
            <thead style="position:sticky;top:0;background:#fff;">${head}</thead><tbody>${rows}</tbody></table>`;
          box.querySelectorAll('button[data-del]').forEach(btn=>{
            btn.addEventListener('click',()=>{
              const idx = +btn.getAttribute('data-del');
              schema.fields.splice(idx,1);
              chrome.storage.local.set({ guiScraperXPathSchema: schema }, renderSchemaTable);
            });
          });
          setNextTipVisible(true);
        });
      }

      function destroy(){
        picking = false;
        document.removeEventListener('mousemove', mm, true);
        document.removeEventListener('click', ck, true);
        hideOverlayLocal();
        if (panel) { panel.remove(); panel = null; }
      }

      function setStatus(t){ const el = panel?.querySelector('#gs_mb_status'); if (el) el.textContent = t || ''; }
      function setPreviewHTML(html){
        const box = panel?.querySelector('#gs_mb_preview');
        if (box) box.innerHTML = html || `<div class="small" style="color:#666;">（ここにクリックプレビュー / 抽出結果が表示されます）</div>`;
      }

      function startPick(){
        if (!panel) buildPanel();
        setStatus('ページ上の要素をクリックしてください（Escでキャンセル）');

        const nameInput = panel.querySelector('#gs_mb_name');
        const name = nameInput?.value.trim() || '';
        if (!name) { setStatus('カラム名を入力してください'); nameInput?.focus(); return; }

        picking = true;

        mm = (e)=>{ if(picking) placeOverlayLocal(e.target); };
        ck = (e)=>{
          if (!picking) return;
          e.preventDefault(); e.stopPropagation();

          const el = e.target;

          let xp = null;
          if (el.tagName && el.tagName.toLowerCase() === 'td') {
            xp = buildHeaderLinkedXPath(el);
          }
          if (!xp) xp = getUniqueXPath(el);
          if (!xp) { setStatus('XPath生成に失敗しました'); cleanupPick(); return; }

          openOptionModal({
            name,
            initial: { attr:'text', proc:'text' },
            element: el,
            xpath: xp,
            onConfirm: ({attr, proc, previewValue}) => {
              chrome.storage.local.get(['guiScraperXPathSchema'], (obj) => {
                const schema = obj.guiScraperXPathSchema || { fields: [] };
                schema.fields.push({ name, xpath: xp, attr, proc });
                chrome.storage.local.set({ guiScraperXPathSchema: schema }, () => {
                  renderSchemaTable();
                  setPreviewHTML(
                    `<div><b>${name}</b> = ${(previewValue ?? '').toString().replace(/</g,'&lt;')}</div>
                    <div class="small" style="margin-top:4px;color:#666;">
                      XPath: <code>${xp.replace(/</g,'&lt;')}</code> / attr: ${attr} / proc: ${proc}
                    </div>`
                  );
                  setStatus(`追加しました: ${name}（合計 ${schema.fields.length} 件）`);
                  setNextTipVisible(true);
                  if (nameInput) { nameInput.value = ''; nameInput.focus(); }
                });
              });
            }
          });

          cleanupPick();
        };

        function cleanupPick(){
          picking = false;
          hideOverlayLocal();
          document.removeEventListener('mousemove', mm, true);
          document.removeEventListener('click', ck, true);
        }

        document.addEventListener('mousemove', mm, true);
        document.addEventListener('click', ck, true);

        const esc = (ev)=>{
          if (ev.key === 'Escape') {
            cleanupPick();
            setStatus('キャンセルしました');
            window.removeEventListener('keydown', esc, true);
          }
        };
        window.addEventListener('keydown', esc, true);
      }

      function openOptionModal({name, initial, element, xpath, onConfirm}){
        const wrap = document.createElement('div');
        wrap.style.cssText = `
          position: fixed; inset: 0; z-index: 2147483647;
          background: rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center;
        `;
        const modal = document.createElement('div');
        modal.style.cssText = `
          width: 420px; background:#fff; border-radius:10px; border:1px solid #ddd;
          box-shadow: 0 8px 24px rgba(0,0,0,.18); padding:14px;
          font: 13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Noto Sans JP,sans-serif;
        `;
        modal.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong>取得オプション – ${name}</strong>
            <button id="gs_opt_close" style="border:none;background:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;">×</button>
          </div>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <label>取得方法（attr）</label>
              <select id="gs_opt_attr" style="width:100%;padding:6px;margin-top:2px;border:1px solid #ddd;border-radius:6px;">
                ${ATTRS.map(a=>`<option value="${a}" ${a===initial.attr?'selected':''}>${a}</option>`).join('')}
              </select>
            </div>
            <div style="flex:1;">
              <label>整形（proc）</label>
              <select id="gs_opt_proc" style="width:100%;padding:6px;margin-top:2px;border:1px solid #ddd;border-radius:6px;">
                ${PROCS.map(p=>`<option value="${p.v}" ${p.v===initial.proc?'selected':''}>${p.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="margin-top:10px;">
            <div style="font-weight:bold;margin-bottom:4px;">プレビュー</div>
            <div id="gs_opt_preview" style="padding:8px;background:#fafafa;border:1px dashed #ddd;border-radius:8px;min-height:38px;">
              <div class="small" style="color:#666;">（ここにプレビューが表示されます）</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
            <button id="gs_opt_cancel" style="padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">キャンセル</button>
            <button id="gs_opt_ok" style="padding:8px 12px;border:none;background:#34c759;color:#fff;border-radius:8px;cursor:pointer;">追加</button>
          </div>
        `;
        wrap.appendChild(modal);
        document.documentElement.appendChild(wrap);

        const $ = (sel)=> modal.querySelector(sel);
        const attrSel = $('#gs_opt_attr');
        const procSel = $('#gs_opt_proc');
        const prevBox = $('#gs_opt_preview');

        function getValueByAttrLocal(el, attr){
          if (attr==='text') return (el.innerText || el.textContent || '').trim();
          if (attr==='html') return el.innerHTML || '';
          if (attr==='href') return (el.closest('a')?.href) || el.getAttribute('href') || '';
          if (attr==='src')  return el.getAttribute('src') || '';
          return (el.innerText || el.textContent || '').trim();
        }
        function applyProcLocal(val, proc){
          switch(proc){
            case 'digits': return (val||'').replace(/\D+/g,'');
            case 'yenToMan': return gs_yenToManString(val);
            case 'dateYmd': return gs_dateYmd(val);
            case 'normalizeSpace': return (val||'').replace(/[\s\u3000]+/g,' ').trim();
            case 'noSpaces': return (val||'').replace(/[\s\u3000]+/g,'');
            case 'noNewlines': return (val||'').replace(/\r?\n|\r/g,'');
            default: return (val ?? '').toString().trim();
          }
        }
        function refreshPreview(){
          const a = attrSel.value, p = procSel.value;
          const raw = getValueByAttrLocal(element, a);
          const out = applyProcLocal(raw, p);
          prevBox.innerHTML = `<div>${(out ?? '').toString().replace(/</g,'&lt;')}</div>
            <div class="small" style="margin-top:4px;color:#666;">XPath: <code>${xpath.replace(/</g,'&lt;')}</code> / attr: ${a} / proc: ${p}</div>`;
        }

        refreshPreview();
        attrSel.onchange = refreshPreview;
        procSel.onchange = refreshPreview;

        $('#gs_opt_close').onclick = () => wrap.remove();
        $('#gs_opt_cancel').onclick = () => wrap.remove();
        $('#gs_opt_ok').onclick = () => {
          const a = attrSel.value, p = procSel.value;
          const raw = getValueByAttrLocal(element, a);
          const out = applyProcLocal(raw, p);
          onConfirm && onConfirm({ attr:a, proc:p, previewValue: out });
          wrap.remove();
        };
      }

      function extractBySchema(){
        const singleRow = !!panel.querySelector('#gs_mb_single')?.checked;
        chrome.storage.local.get(['guiScraperXPathSchema'], (obj) => {
          const schema = obj.guiScraperXPathSchema || { fields: [] };
          if (!schema.fields.length) { setStatus('まずフィールドを追加してください'); return; }

          runSchemaExtract(schema, singleRow).then((resp) => {
            if (!resp || !resp.ok) { setStatus((resp && resp.error) || '抽出に失敗しました'); return; }
            const items = resp.items || [];
            if (!items.length) { setPreviewHTML('<div class="small" style="color:#666;">（結果なし）</div>'); return; }
            const cols = Object.keys(items[0]);
            const head = `<tr>${cols.map(c=>`<th style="text-align:left;border-bottom:1px solid #eee;padding:6px;">${c}</th>`).join('')}</tr>`;
            const rows = items.slice(0,50).map(r=>`<tr>${
              cols.map(c=>`<td style="border-bottom:1px solid #f2f2f2;padding:6px;">${(r[c] ?? '').toString().replace(/</g,'&lt;')}</td>`).join('')
            }</tr>`).join('');
            setPreviewHTML(`<div style="max-height:180px;overflow:auto;border:1px solid #eee;border-radius:6px;">
              <table style="width:100%;border-collapse:collapse;font-size:12px;">${head}${rows}</table>
            </div>`);
            setStatus(`抽出 ${items.length} 行`);
            panel._lastExtract = items;
          });
        });
      }

      function clearSchema(){
        chrome.storage.local.set({ guiScraperXPathSchema: { fields: [] } }, () => {
          const box = panel?.querySelector('#gs_mb_schema');
          if (box) box.innerHTML = '<div class="small" style="padding:6px;color:#666;">フィールド未登録</div>';
          setPreviewHTML('');
          setStatus('スキーマをクリアしました');
        });
      }

      function downloadJSON(){
        const items = panel?._lastExtract || [];
        if (!items.length) { setStatus('先に抽出してください'); return; }
        const payload = { selector:'XPathSchema', items };
        const blob = new Blob([JSON.stringify(payload,null,2)], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_result.json'; a.click();
        URL.revokeObjectURL(url);
      }
      function downloadCSV(){
        const items = panel?._lastExtract || [];
        if (!items.length) { setStatus('先に抽出してください'); return; }
        const cols = Object.keys(items[0] || {});
        const header = cols.join(',');
        const rows = items.map(r => cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g,'""')}"`).join(','));
        const csv = [header, ...rows].join('\n');
        const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_result.csv'; a.click();
        URL.revokeObjectURL(url);
      }

      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type === 'GS_OPEN_MINI_BUILDER') {
          if (window.self !== window.top) {
            sendResponse && sendResponse({ ok: true, ignored: 'subframe' });
            return true;
          }
          buildPanel();
          setPreviewHTML('');
          const el = panel?.querySelector('#gs_mb_status');
          if (el) el.textContent = 'カラム名を入力し「クリックで取得 → 追加」を押してください';
          sendResponse && sendResponse({ ok:true });
          return true;
        }
      });
    }

     // ミニビルダーを明示起動できるようにグローバル公開
    window.__GS_buildPanel = buildPanel

    // 自動では開かない（popup から GS_OPEN_MINI_BUILDER を受けたときだけ buildPanel() する）

  })();

})();
