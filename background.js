// background.js (MV3, non-module)
// NOTE: Use "downloads" permission in manifest for auto-saving CSV.

// ===== Open Mini Builder on current http/https tab =====
chrome.action.onClicked.addListener(async () => {
  const pickHttpTab = () =>
    new Promise((resolve) => {
      chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
        let t = (tabs || []).find((x) => /^https?:/i.test(x.url || ''));
        if (t) return resolve(t.id);
        chrome.tabs.query(
          { windowType: 'normal', url: ['http://*/*', 'https://*/*'] },
          (cands) => {
            if (!cands || !cands.length) return resolve(null);
            cands.sort((a, b) => (b.active - a.active) || (a.index - b.index));
            resolve(cands[0].id);
          }
        );
      });
    });

  const tabId = await pickHttpTab();
  if (!tabId) return;

  const ping = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'GS_PING' }, (resp) => {
        resolve(!chrome.runtime.lastError && resp && resp.ok);
      });
    });

  const ok1 = await ping();
  if (!ok1) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (e) {
      console.warn('inject error:', e);
    }
  }
  const ok2 = await ping();
  if (!ok2) return;

  chrome.tabs.sendMessage(tabId, { type: 'GS_OPEN_MINI_BUILDER' });
});

// ===== Utils =====
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- JSTの日時 "YYYY-MM-DD HH:mm:ss" を常に返す（SWでも安定） ----
function nowJSTStr() {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function sendMessageAsync(tabId, message, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options || {}, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(resp);
    });
  });
}
function sendMessageSafe(tabId, payload, opts = {}) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, opts, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false });
    });
  });
}
function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GS_PING' }, (resp) => {
      resolve(!chrome.runtime.lastError && resp && resp.ok);
    });
  });
}
async function ensureContent(tabId) {
  const ok1 = await pingTab(tabId);
  if (ok1) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) {}
  return pingTab(tabId);
}

async function waitTabComplete(tabId, targetUrl, maxMs = 30000) {
  const start = Date.now();
  // wait for status: complete (next change)
  await new Promise((resolve) => {
    const h = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(h);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(h);
    // safety: resolve anyway if time passed and no event fired (e.g., already complete)
    setTimeout(() => {
      try { chrome.tabs.onUpdated.removeListener(h); } catch (_) {}
      resolve();
    }, 3000);
  });
  // additionally verify same host
  while (Date.now() - start < maxMs) {
    try {
      const got = await sendMessageAsync(tabId, { type: 'GS_GET_PAGE_URL' });
      if (got?.ok && got.url) {
        try {
          const tu = new URL(targetUrl);
          const au = new URL(got.url);
          if (au.host === tu.host) break;
        } catch (_) {
          if (got.url.startsWith(targetUrl)) break;
        }
      }
    } catch (_) {}
    await wait(250);
  }
}

async function waitDownloadComplete(downloadId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(true);
      } else if (delta.error) {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(false);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    setTimeout(() => {
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch (_) {}
      resolve(false);
    }, timeoutMs);
  });
}

// ===== CSV save (BOM for Excel) =====
function buildCsvFromItemsWithSchema(items, schema) {
  const cols = ['取得日時', 'URL', ...(schema?.fields || []).map(f => f.name)];
  const header = cols.join(',');
  const rows = (items || []).map(r =>
    cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g, '""')}"`).join(',')
  );
  // Excel対策でBOM付与
  return '\ufeff' + [header, ...rows].join('\n');
}

async function saveResultsCsvDataUrl(items, schema) {
  const csv = buildCsvFromItemsWithSchema(items, schema);
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  return chrome.downloads.download({
    url: dataUrl,
    filename: `gui_scraper_batch_result_${tsStamp()}.csv`,
    saveAs: false,
  });
}

// ===== Batch Queue (parallel, pool of tabs) =====
const Queue = {
  urls: [],
  results: [],
  running: false,
  done: 0,
  failed: 0,
  singleRow: true,
  mode: 'auto', // 'auto' | 'static' | 'dynamic'
  MAX_CONCURRENCY: 6,
  RATE_MS: 300,
  RETRIES: 2,
  tabPool: {}, // workerId -> tabId
  startedAt: 0,
};
let __REQ_SEQ__ = 1;
function nextReqId() {
  return __REQ_SEQ__++;
}

function notifyProgress(currentUrl) {
  chrome.runtime.sendMessage(
    { type: 'GS_QUEUE_PROGRESS', done: Queue.done, total: Queue.urls.length, currentUrl },
    () => {}
  );
}
function notifyDone(extra = {}) {
  chrome.runtime.sendMessage(
    {
      type: 'GS_QUEUE_DONE',
      done: Queue.done,
      total: Queue.urls.length,
      failed: Queue.failed,
      elapsedMs: typeof extra.elapsedMs === 'number' ? extra.elapsedMs : null,
    },
    () => {}
  );
}

function emptyRowForUrl(u, schema) {
  const row = { '取得日時': nowJSTStr(), 'URL': u };
  (schema.fields || []).forEach(f => { row[f.name] = ''; });
  return row;
}

function pickWaitField(schema) {
  const prefs = ['会社名', '企業名', '法人名', '店名', '施設名'];
  const fs = schema.fields || [];
  return fs.find((f) => prefs.includes(f.name)) || fs[0] || null;
}

// frames helper
function getAllFrameIds(tabId) {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve((frames || []).map((f) => f.frameId));
    });
  });
}
function sendToFrame(tabId, frameId, payload) {
  return sendMessageSafe(tabId, payload, { frameId });
}
function scoreItems(items, schema) {
  const fields = (schema.fields || []).map((f) => f.name);
  let s = 0;
  for (const row of items || []) for (const k of fields) if ((row?.[k] || '').toString().trim()) s++;
  return s;
}
async function extractWithRetryAllFrames(tabId, schema, singleRow, reqId, expectedUrl) {
  const MAX_TRY = 10;
  const INTERVAL = 800;
  let expectedHost = null;
  try {
    expectedHost = new URL(expectedUrl).host;
  } catch (_) {}
  for (let t = 0; t < MAX_TRY; t++) {
    const frameIds = await getAllFrameIds(tabId);
    const payload = { type: 'GS_EXTRACT_SCHEMA_XPATHS', schema, singleRow, reqId };
    const resps = await Promise.all(frameIds.map((fid) => sendToFrame(tabId, fid, payload)));
    let pool = resps.filter((r) => r?.ok);
    pool = pool.filter((r) => {
      if (!r.pageUrl) return true;
      try {
        return new URL(r.pageUrl).host === expectedHost;
      } catch (_) {
        return true;
      }
    });
    const exact = pool.filter((r) => r.pageUrl && r.pageUrl === expectedUrl);
    if (exact.length) pool = exact;
    const sameReq = pool.filter((r) => !('reqId' in r) || r.reqId === reqId);
    if (sameReq.length) pool = sameReq;
    let best = null, bestScore = -1;
    for (const r of pool) {
      const sc = scoreItems(r.items, schema);
      if (sc > bestScore) {
        best = r;
        bestScore = sc;
      }
    }
    if (best && bestScore > 0) {
      return { items: best.items || [], pageUrl: best.pageUrl || expectedUrl };
    }
    await wait(INTERVAL);
  }
  return { items: [], pageUrl: expectedUrl };
}

async function openOrReuseTabFor(workerId, url) {
  const existing = Queue.tabPool[workerId];
  if (existing) {
    try {
      await chrome.tabs.update(existing, { url, active: false });
      return existing;
    } catch (_) {
      delete Queue.tabPool[workerId];
    }
  }
  const created = await new Promise((resolve) => chrome.tabs.create({ url, active: false }, (t) => resolve(t)));
  const id = created?.id || null;
  if (id) Queue.tabPool[workerId] = id;
  return id;
}

async function processOneUrlWithRetry(workerId, url, schema, singleRow) {
  let attempt = 0;

  // ① static (if provided externally)
  if (Queue.mode !== 'dynamic' && typeof tryStaticExtract === 'function') {
    try {
      const staticItems = await tryStaticExtract(url, schema, singleRow);
      if (staticItems && staticItems.length) {
        for (const it of staticItems) {
          const row = emptyRowForUrl(url, schema);
          (schema.fields || []).forEach((f) => (row[f.name] = it[f.name] ?? ''));
          if (!row['取得日時']) row['取得日時'] = nowJSTStr();
          Queue.results.push(row);
        }
        return true;
      } else if (Queue.mode === 'static') {
        Queue.results.push(emptyRowForUrl(url, schema));
        Queue.failed++;
        return false;
      }
    } catch (_) {
      if (Queue.mode === 'static') {
        Queue.results.push(emptyRowForUrl(url, schema));
        Queue.failed++;
        return false;
      }
    }
  }

  // ② dynamic
  while (attempt <= Queue.RETRIES) {
    try {
      if (Queue.mode === 'static') throw new Error('static-only mode');

      const tabId = await openOrReuseTabFor(workerId, url);
      if (!tabId) throw new Error('tab open failed');

      try {
        await waitTabComplete(tabId, url, 25000);
      } catch (_) {}
      await wait(150);
      const ready = await ensureContent(tabId);
      if (!ready) throw new Error('content not ready');

      let actualUrl = url;
      try {
        const got = await sendToFrame(tabId, 0, { type: 'GS_GET_PAGE_URL' });
        if (got?.ok && got.url) actualUrl = got.url;
      } catch (_) {}

      const waitField = pickWaitField(schema);
      if (waitField?.xpath) {
        try {
          await sendToFrame(tabId, 0, {
            type: 'GS_WAIT_SCHEMA_READY',
            schema: { fields: [waitField] },
            minHits: 1,
            timeoutMs: 20000,
            intervalMs: 250,
            textStable: {
              xpath: waitField.xpath,
              attr: waitField.attr || 'text',
              minLength: 3,
              stableMs: 700,
            },
          });
        } catch (_) {}
      } else {
        try {
          await sendToFrame(tabId, 0, {
            type: 'GS_WAIT_SCHEMA_READY',
            schema,
            minHits: 1,
            timeoutMs: 15000,
            intervalMs: 300,
          });
        } catch (_) {}
      }

      const reqId = nextReqId();
      const { items } = await extractWithRetryAllFrames(tabId, schema, singleRow, reqId, actualUrl);
      if (!items || !items.length) throw new Error('no items');

      for (const it of items) {
        let finalUrl = actualUrl;
        try {
          const got2 = await sendToFrame(tabId, 0, { type: 'GS_GET_PAGE_URL' });
          if (got2?.ok && got2.url) finalUrl = got2.url;
        } catch (_) {}
        const row = emptyRowForUrl(finalUrl, schema);
        (schema.fields || []).forEach((f) => (row[f.name] = it[f.name] ?? ''));
        if (!row['取得日時']) row['取得日時'] = nowJSTStr();
        Queue.results.push(row);
      }
      return true;
    } catch (e) {
      if (attempt >= Queue.RETRIES) {
        console.warn('[GS] worker', workerId, 'url failed:', url, e);
        Queue.results.push(emptyRowForUrl(url, schema));
        Queue.failed++;
        return false;
      }
      attempt++;
      await wait(400);
    }
  }
}

// run queue
async function runQueue() {
  if (Queue.running) return;
  Queue.running = true;
  Queue.done = 0;
  Queue.failed = 0;
  Queue.results = [];
  Queue.startedAt = Date.now();

  const schema = await new Promise((res) =>
    chrome.storage.local.get(['guiScraperXPathSchema'], (v) => res(v.guiScraperXPathSchema || { fields: [] }))
  );

  const total = Queue.urls.length;
  let nextIdx = 0;

  async function worker(workerId) {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= total) break;
      const url = Queue.urls[myIdx];
      notifyProgress(url);
      await processOneUrlWithRetry(workerId, url, schema, Queue.singleRow);
      Queue.done++;
      notifyProgress(url);
      await wait(Queue.RATE_MS);
    }
  }

  const N = Math.max(1, Queue.MAX_CONCURRENCY | 0);
  const workers = Array.from({ length: N }, (_, i) => worker(i));
  await Promise.all(workers);

  // cleanup tabs
  for (const id of Object.values(Queue.tabPool)) {
    try { chrome.tabs.remove(id); } catch (_) {}
  }
  Queue.tabPool = {};

  Queue.running = false;

  // auto-save and record run meta
  let elapsedMs = Date.now() - Queue.startedAt;
  try {
    const downloadId = await saveResultsCsvDataUrl(Queue.results, schema);
    if (typeof downloadId === 'number') await waitDownloadComplete(downloadId);
    elapsedMs = Date.now() - Queue.startedAt;
  } catch (e) {
    console.warn('[GS] auto save failed:', e);
  }

  chrome.storage.local.set(
    {
      gs_lastRun: {
        startedAt: Queue.startedAt,
        finishedAt: Date.now(),
        elapsedMs,
        done: Queue.done,
        total: Queue.urls.length,
        failed: Queue.failed,
      },
    },
    () => {}
  );

  notifyDone({ elapsedMs });
}

// ===== URL Crawler =====
const Crawler = {
  running: false,
  seeds: [],
  linkXPath: '',
  nextXPath: '',
  pageParamKeys: ['p'],          // ← 追加: デフォルトのページ送りキー
  sameHostOnly: true,
  maxPages: 10,
  maxUrls: 1000,
  results: [],
  seen: new Set(),
  visitedPages: new Set(),
  tabId: null,
  pageTotal: 0,
  stripHash: true,
  stripQuery: true,
  stripTrailingSlash: true,
  allowPattern: '',
  denyPattern: '',
  allowRe: null,
  denyRe: null,
};

function notifyCrawlProgress(seedIndex, seedTotal, pageCount, urlCount, currentPage) {
  chrome.runtime.sendMessage(
    { type: 'GS_URLCRAWL_PROGRESS', seedIndex, seedTotal, pageCount, urlCount, currentPage },
    () => {}
  );
}
function notifyCrawlDone(seedTotal, pageTotal, urlCount) {
  chrome.runtime.sendMessage({ type: 'GS_URLCRAWL_DONE', seedTotal, pageTotal, urlCount }, () => {});
}

async function openOrReuseTabForCrawler(url) {
  if (Crawler.tabId) {
    try {
      await chrome.tabs.update(Crawler.tabId, { url, active: false });
      return Crawler.tabId;
    } catch (_) {
      Crawler.tabId = null;
    }
  }
  const t = await new Promise((res) => chrome.tabs.create({ url, active: false }, res));
  Crawler.tabId = t?.id || null;
  return Crawler.tabId;
}

async function extractHrefs(tabId, xpath) {
  const resp = await sendToFrame(tabId, 0, {
    type: 'GS_EXTRACT_USING_XPATH',
    xpath,
    opts: { extract: { href: true } },
  });
  if (!resp?.ok) return [];
  const out = [];
  for (const r of resp.items || []) {
    const href = (r?.href || '').trim();
    if (!href) continue;
    if (href.startsWith('#')) continue;
    out.push(href);
  }
  return out;
}
function normalizeAbsUrl(u, base) {
  try {
    const url = new URL(u, base);
    url.hash = ''; // drop fragments
    return url.href;
  } catch (_) {
    return '';
  }
}
function normalizeForDedup(u) {
  try {
    const url = new URL(u);
    if (Crawler.stripHash) url.hash = '';
    if (Crawler.stripQuery) url.search = '';
    let path = url.pathname || '/';
    if (Crawler.stripTrailingSlash && path.length > 1) path = path.replace(/\/$/, '');
    return url.origin + path;
  } catch (_) {
    return '';
  }
}
function compileFilters() {
  Crawler.allowRe = Crawler.allowPattern ? new RegExp(Crawler.allowPattern) : null;
  Crawler.denyRe = Crawler.denyPattern ? new RegExp(Crawler.denyPattern) : null;
}
function shouldKeep(u) {
  if (Crawler.allowRe && !Crawler.allowRe.test(u)) return false;
  if (Crawler.denyRe && Crawler.denyRe.test(u)) return false;
  return true;
}

// --- 追加：?p=2,3... のURLを生成（keys優先順で）
function tryParamIncrement(u, keys = ['p']) {
  try {
    const url = new URL(u);
    const sp = new URLSearchParams(url.search || '');
    // 既存キーがあれば +1、無ければ先頭キーに 2 を入れる
    let touched = false;
    for (const k of keys) {
      if (sp.has(k)) {
        const cur = parseInt(sp.get(k) || '1', 10);
        if (!Number.isNaN(cur)) {
          sp.set(k, String(cur + 1));
          touched = true;
          break;
        }
      }
    }
    if (!touched) {
      const k0 = keys[0] || 'p';
      sp.set(k0, '2');
    }
    url.search = sp.toString();
    return url.href;
  } catch (_) {
    return '';
  }
}

async function runUrlCrawl() {
  if (Crawler.running) return;
  Crawler.running = true;
  Crawler.results = [];
  Crawler.seen.clear();
  Crawler.visitedPages.clear();
  Crawler.pageTotal = 0;

  const seedTotal = Crawler.seeds.length;

  for (let si = 0; si < seedTotal; si++) {
    let current = Crawler.seeds[si];
    let pageCount = 0;

    let host0 = '';
    try {
      host0 = new URL(current).host;
    } catch (_) {}

    while (current && pageCount < Crawler.maxPages && Crawler.results.length < Crawler.maxUrls) {
      if (Crawler.visitedPages.has(current)) break;
      Crawler.visitedPages.add(current);

      const tabId = await openOrReuseTabForCrawler(current);
      if (!tabId) break;

      try {
        await waitTabComplete(tabId, current, 25000);
      } catch (_) {}
      await wait(150);
      const ready = await ensureContent(tabId);
      if (!ready) break;

      // 1) collect detail links
      const beforeCount = Crawler.results.length; // このページで増えた件数を確認
      const hrefs = await extractHrefs(tabId, Crawler.linkXPath);
      for (const h of hrefs) {
        const abs = normalizeAbsUrl(h, current);
        if (!abs) continue;
        if (!shouldKeep(abs)) continue;

        const key = normalizeForDedup(abs);
        if (!key) continue;
        if (!Crawler.seen.has(key)) {
          if (Crawler.sameHostOnly) {
            try {
              if (new URL(abs).host !== host0) continue;
            } catch (_) {
              continue;
            }
          }
          Crawler.seen.add(key);
          Crawler.results.push(abs);
          if (Crawler.results.length >= Crawler.maxUrls) break;
        }
      }
      const added = Crawler.results.length - beforeCount;

      pageCount++;
      Crawler.pageTotal++;
      notifyCrawlProgress(si + 1, seedTotal, pageCount, Crawler.results.length, current);
      if (Crawler.results.length >= Crawler.maxUrls) break;

      // 2) next page 決定
      let nextHref = '';
      // 明示の次へXPath
      if (Crawler.nextXPath) {
        try {
          const nexts = await extractHrefs(tabId, Crawler.nextXPath);
          if (nexts.length) nextHref = normalizeAbsUrl(nexts[0], current);
        } catch (_) {}
      }
      // ヒューリスティック
      if (!nextHref) {
        try {
          const r = await sendToFrame(tabId, 0, { type: 'GS_FIND_NEXT_URL' });
          if (r?.ok && r.url) nextHref = normalizeAbsUrl(r.url, current);
        } catch (_) {}
      }
      // フォールバック：このページで新規URLが取れている間だけ ?p=+1 を試す
      if (!nextHref && added > 0) {
        const inc = tryParamIncrement(current, Crawler.pageParamKeys);
        if (inc) nextHref = inc;
      }

      if (!nextHref) break;
      if (Crawler.sameHostOnly) {
        try {
          if (new URL(nextHref).host !== host0) break;
        } catch (_) {
          break;
        }
      }
      current = nextHref;
    }
  }

  Crawler.running = false;
  notifyCrawlDone(Crawler.seeds.length, Crawler.pageTotal, Crawler.results.length);

  // auto-save URL list
  try {
    const header = 'URL';
    const rows = Crawler.results.map((u) => `"${u.replace(/"/g, '""')}"`);
    const csv = '\ufeff' + [header, ...rows].join('\n');
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    await chrome.downloads.download({
      url: dataUrl,
      filename: `url_list_${tsStamp()}.csv`,
      saveAs: false,
    });
  } catch (e) {
    console.warn('[GS] URL list auto save failed:', e);
  }

  // cleanup crawler tab
  if (Crawler.tabId) {
    try { chrome.tabs.remove(Crawler.tabId); } catch (_) {}
    Crawler.tabId = null;
  }
}

// ===== Message API =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    switch (msg.type) {
      // ---- Batch queue ----
      case '__PING__': {
        // ミニビルダーが生存確認で叩く
        sendResponse({ ok: true, who: 'background' });
        return true; // ← これ大事（非同期応答のためにチャネルを開けておく）
      }
      // === Options(設定)ページを開く ===
      case 'GS_OPEN_WORKDIR_PAGE': {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return true;
      }


      case 'GS_QUEUE_LOAD': {
        const arr = Array.isArray(msg.urls) ? msg.urls.filter((u) => /^https?:\/\//i.test(u)) : [];
        Queue.urls = arr;
        Queue.done = 0;
        Queue.failed = 0;
        Queue.results = [];
        sendResponse({ ok: true, count: arr.length });
        return true;
      }
      case 'GS_QUEUE_RUN': {
        if (Queue.running) {
          sendResponse({ ok: false, error: 'queue already running' });
          return true;
        }
        Queue.singleRow = !!msg.singleRow;
        Queue.mode = msg.mode === 'static' || msg.mode === 'dynamic' ? msg.mode : 'auto';
        if (typeof msg.concurrency === 'number') {
          Queue.MAX_CONCURRENCY = Math.max(1, Math.min(8, Math.floor(msg.concurrency)));
        }
        if (typeof msg.rateMs === 'number') {
          Queue.RATE_MS = Math.max(0, Math.floor(msg.rateMs));
        }
        runQueue().then(() => {});
        sendResponse({ ok: true });
        return true;
      }
      case 'GS_QUEUE_GET_RESULTS': {
        sendResponse({
          ok: true,
          items: Queue.results.slice(),
          running: !!Queue.running,
          done: Queue.done | 0,
          total: Queue.urls?.length || 0,
          failed: Queue.failed | 0,
          mode: Queue.mode || 'auto',
        });
        return true;
      }
      case 'GS_QUEUE_CLEAR': {
        if (Queue.running) {
          sendResponse({ ok: false, error: 'queue running' });
          return true;
        }
        Queue.urls = [];
        Queue.results = [];
        Queue.done = 0;
        Queue.failed = 0;
        sendResponse({ ok: true });
        return true;
      }

      // ---- URL Crawler ----
      case 'GS_URLCRAWL_RUN': {
        if (Crawler.running) {
          sendResponse({ ok: false, error: 'crawler running' });
          return true; // 非同期応答を続ける
        }

        (async () => {
          const seedsFromMsg = Array.isArray(msg.seeds)
            ? msg.seeds.filter(u => /^https?:\/\//i.test(u))
            : [];
          const seedXPath   = String(msg.seedXPath || '').trim();
          const originTabId = msg.originTabId || null;

          // 設定の取り込み
          Crawler.linkXPath          = String(msg.linkXPath || '').trim();
          Crawler.nextXPath          = String(msg.nextXPath || '').trim();
          Crawler.sameHostOnly       = !!msg.sameHostOnly;
          Crawler.maxPages           = Math.max(1, Math.min(500, (msg.maxPages|0) || 10));
          Crawler.maxUrls            = Math.max(10, Math.min(200000, (msg.maxUrls|0) || 1000));
          Crawler.stripHash          = msg.stripHash !== false;
          Crawler.stripQuery         = msg.stripQuery !== false;
          Crawler.stripTrailingSlash = msg.stripTrailingSlash !== false;
          Crawler.allowPattern       = String(msg.allowPattern || '');
          Crawler.denyPattern        = String(msg.denyPattern || '');
          compileFilters && compileFilters();

          // ページ送りパラメータの取り込み（"p,page,pg" または配列）
          let pageParamKeys = [];
          if (Array.isArray(msg.pageParamKeys)) {
            pageParamKeys = msg.pageParamKeys;
          } else if (typeof msg.pageParamKeys === 'string' && msg.pageParamKeys.trim()) {
            pageParamKeys = msg.pageParamKeys.split(',');
          }
          Crawler.pageParamKeys = pageParamKeys.map(s => String(s || '').trim()).filter(Boolean);
          if (!Crawler.pageParamKeys.length) Crawler.pageParamKeys = ['p'];

          if (!Crawler.linkXPath) {
            sendResponse({ ok: false, error: 'linkXPath required' });
            return;
          }

          // ヘルパ（このIIFE内でawait可）
          async function pickActiveHttpTab() {
            return new Promise((resolve) => {
              chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
                let t = (tabs || []).find(x => /^https?:/i.test(x.url || ''));
                if (t) return resolve(t.id);
                chrome.tabs.query({ windowType: 'normal', url: ['http://*/*','https://*/*'] }, (cands) => {
                  if (!cands || !cands.length) return resolve(null);
                  cands.sort((a,b) => (b.active - a.active) || (a.index - b.index));
                  resolve(cands[0].id);
                });
              });
            });
          }
          async function collectSeedsViaXPath(tabId, xp) {
            let base = '';
            try {
              const got = await sendToFrame(tabId, 0, { type: 'GS_GET_PAGE_URL' });
              base = got?.ok && got.url ? got.url : '';
            } catch(_) {}
            const hrefs = await extractHrefs(tabId, xp);
            const out = [];
            for (const h of (hrefs || [])) {
              const abs = normalizeAbsUrl(h, base);
              if (abs) out.push(abs);
            }
            return out;
          }

          // シード作成（CSV or seedXPath）
          const seedsList = [];
          if (seedsFromMsg.length) seedsList.push(...seedsFromMsg);

          if (seedXPath) {
            const tabId = originTabId || (await pickActiveHttpTab());
            if (!tabId) {
              sendResponse({ ok: false, error: 'no active tab for seedXPath' });
              return;
            }
            const ready = await ensureContent(tabId);
            if (!ready) {
              sendResponse({ ok: false, error: 'content not ready on seed page' });
              return;
            }
            const seedUrls = await collectSeedsViaXPath(tabId, seedXPath);
            seedsList.push(...seedUrls);
          }

          // ★追加：seedXPath も CSV も無い場合は、現在のタブURLを 1 件だけシードにする
          if (!seedsFromMsg.length && !seedXPath) {
            const tabId = originTabId || (await pickActiveHttpTab());
            if (tabId) {
              try {
                const got = await sendToFrame(tabId, 0, { type: 'GS_GET_PAGE_URL' });
                const u = got?.ok && got.url ? got.url : '';
                if (/^https?:\/\//i.test(u)) seedsList.push(u);
              } catch (_) {}
            }
          }


          // 重複除去
          const uniqSeeds = Array.from(new Set(seedsList));
          if (!uniqSeeds.length) {
            sendResponse({ ok: false, error: 'no seeds (CSV or seedXPath)' });
            return;
          }

          // 状態に流し込んで開始
          Crawler.seeds = uniqSeeds;
          runUrlCrawl().then(() => {});
          sendResponse({ ok: true, seedCount: uniqSeeds.length });
        })().catch(err => {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        });

        return true; // 非同期で sendResponse するよ宣言
      }

      case 'GS_URLCRAWL_GET': {
        sendResponse({ ok: true, urls: Crawler.results.slice() });
        return true;
      }

      default:
        return false;
    }
  } catch (e) {
    sendResponse && sendResponse({ ok: false, error: String(e) });
    return true;
  }
});
