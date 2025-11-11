// popup.js — ①カラム指定 → ②CSV読み込み（記憶/ヘッダー可）+ 作業フォルダ
//            → ③プレビュー（全フレーム） → ④一括実行（全フレーム+リトライ） → ⑤Python出力
//            → ⑥ URL収集（seedXPath + CSV 両対応、次へ自動推測にフォールバック）

function log(...args){ try{ console.log('[GS]', ...args); }catch(_){} }

// ===== Active tab utils =====
function withActiveHttpTab(fn) {
  chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
    let tab = (tabs || []).find(t => /^https?:/i.test(t.url || ''));
    if (tab) return fn(tab.id);
    chrome.tabs.query({ windowType: 'normal', url: ['http://*/*', 'https://*/*'] }, (cands) => {
      if (!cands || !cands.length) {
        const st = document.querySelector('#status');
        if (st) st.textContent = '操作可能な通常タブが見つかりません（http/https ページで試してください）';
        return;
      }
      cands.sort((a, b) => (b.active - a.active) || (a.index - b.index));
      fn(cands[0].id);
    });
  });
}

function renderDebugBox(containerEl, debug) {
  if (!containerEl) return;
  if (!debug?.fields?.length) {
    containerEl.insertAdjacentHTML('beforeend',
      `<div class="small" style="color:#666; margin-top:6px;">（debug: 情報なし）</div>`);
    return;
  }
  const rows = debug.fields.map(f =>
    `<tr>
      <td>${f.name}</td>
      <td><code>${(f.xpath||'').replace(/</g,'&lt;')}</code></td>
      <td style="text-align:right;">${f.hitCount}</td>
      <td>${(f.sample ?? '').toString().replace(/</g,'&lt;')}</td>
    </tr>`).join('');
  const html = `
    <div class="small" style="margin-top:8px;">debug: page = ${(debug.pageUrl||'').replace(/</g,'&lt;')}</div>
    <div style="max-height:160px; overflow:auto; border:1px solid #eee; border-radius:6px; margin-top:4px;">
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr>
          <th>name</th><th>xpath</th><th style="width:56px;text-align:right;">hits</th><th>sample</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  containerEl.insertAdjacentHTML('beforeend', html);
}

function ping(tabId, cb) {
  chrome.tabs.sendMessage(tabId, { type: 'GS_PING' }, (resp) => {
    cb(!chrome.runtime.lastError && resp && resp.ok);
  });
}
function ensureContentScript(tabId, cb) {
  ping(tabId, (ok) => {
    if (ok) return cb(true);
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['content.js'] },
      () => {
        if (chrome.runtime.lastError) {
          const st = document.querySelector('#status');
          if (st) st.textContent = 'content.js 注入エラー: ' + chrome.runtime.lastError.message;
          return cb(false);
        }
        ping(tabId, (ok2) => cb(!!ok2));
      }
    );
  });
}

// ===== 全フレーム抽出（プレビュー用） =====
function sendToFrame(tabId, frameId, payload){
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, { frameId }, (resp) => {
      if (chrome.runtime.lastError) return resolve({ ok:false, error: chrome.runtime.lastError.message });
      resolve(resp || { ok:false });
    });
  });
}
function getAllFrameIds(tabId){
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      resolve((frames || []).map(f => f.frameId));
    });
  });
}
function scoreItems(items, schema){
  const fields = (schema.fields || []).map(f => f.name);
  let s = 0;
  for (const row of (items || [])) {
    for (const k of fields) if ((row?.[k] || '').toString().trim()) s++;
  }
  return s;
}
async function extractFromAllFrames(schema, singleRow){
  return new Promise((resolve) => {
    withActiveHttpTab((tabId) => {
      ensureContentScript(tabId, async (ready) => {
        if (!ready) return resolve({ ok:false, error:'content not ready' });
        const frameIds = await getAllFrameIds(tabId);
        if (!frameIds.length) return resolve({ ok:false, error:'no frames' });
        const payload = { type:'GS_EXTRACT_SCHEMA_XPATHS', schema, singleRow, reqId: Date.now() };
        const resps = await Promise.all(frameIds.map(fid => sendToFrame(tabId, fid, payload)));
        let best = null, bestScore = -1;
        for (const r of resps) if (r?.ok) {
          const sc = scoreItems(r.items, schema);
          if (sc > bestScore) { best = r; bestScore = sc; }
        }
        if (!best) best = resps.find(r => r?.ok) || { ok:false, error:'no ok responses' };
        resolve(best);
      });
    });
  });
}

// ===== IndexedDB（作業フォルダハンドル保存用） =====
const DB_NAME = 'gs_idb';
const STORE   = 'handles';
function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function idbSet(key, value){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function idbDel(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ===== DOM helpers =====
const qs = (s) => document.querySelector(s);

function setBatchKitStatus(t) {
  const el = document.querySelector('#batchKitStatus');
  if (el) el.textContent = t || '';
  else setStatus(t || ''); // フォールバック
}


function setStatus(t) {
  const el = qs('#status');
  if (el) el.textContent = t || '';
}

// 追加：CSV専用ステータス（#csvStatus があればそこへ、無ければ #status へ）
// 新規：CSV専用の表示先
function setCsvStatus(t) {
  const el = qs('#csvStatus');
  if (el) el.textContent = t || '';
  else setStatus(t || ''); // 保険：csvStatusが無ければ #status に出す
}

// 抽出モード（'auto' | 'static' | 'dynamic'）
function getMode() {
  return document.querySelector('input[name="gs_mode"]:checked')?.value || 'auto';
}
function setMode(v) {
  const el = document.querySelector(`input[name="gs_mode"][value="${v}"]`);
  if (el) el.checked = true;
}

// 時間表記
function fmtDuration(ms){
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return h ? `${h}時間${m}分${ss}秒` : (m ? `${m}分${ss}秒` : `${ss}秒`);
}


document.addEventListener('DOMContentLoaded', async () => {
  // === 追加：この拡張の唯一の作業フォルダハンドル ===
  /** @type FileSystemDirectoryHandle|null */
  // --- 作業フォルダ（共通ユーティリティ） ---
  let workdirReady = false;

  function setWorkdirReadyFlag(ready) {
    workdirReady = !!ready;
    // ここで必ずUIを更新（“光らない”を即解消）
    updateUiState?.();
  }

    // 起動時復元（※ユーザー操作ではないので requestPermission は呼ばない）
  (async () => {
    try {
      const stored = await idbGet('workdir');
      if (stored) {
        currentDirHandle = stored;
        const perm = await stored.queryPermission?.({ mode: 'readwrite' });
        await updateWorkdirStatus(stored);
        setWorkdirReadyFlag(perm === 'granted'); // 起動時は request しない
      } else {
        currentDirHandle = null;
        await updateWorkdirStatus(null);
        setWorkdirReadyFlag(false);
      }
    } catch (e) {
      console.warn('workdir restore failed', e);
      await updateWorkdirStatus(null);
      setWorkdirReadyFlag(false);
    }
  })();


  async function updateWorkdirStatus(handle){
  const el = qs('#workdirStatus');
  if (!el) return;
  if (!handle) { el.textContent = '未選択 / 必須'; return; }
  let perm = 'unknown';
  try { perm = await handle.queryPermission({ mode:'readwrite' }); } catch (_) {}
  el.textContent = (perm === 'granted')
    ? `選択中: ${handle.name}（perm: granted）`
    : `選択中: ${handle.name}（perm: ${perm} / 再許可が必要）`;
  }

  async function writeToWorkdir(filename, blob){
    try {
        // ここからは currentDirHandle を唯一参照
      log('writeToWorkdir: handle?', !!currentDirHandle, currentDirHandle?.name, '->', filename);
      if (!currentDirHandle) {
        setWorkdirReadyFlag(false);
        await updateWorkdirStatus(null);
        return false;
      }
      let perm = await currentDirHandle.queryPermission({ mode: 'readwrite' });
      log('writeToWorkdir: perm(before)=', perm);
            if (perm !== 'granted') {
        // ★ ユーザー操作起因の関数から呼ばれる前提なので request が許可される
        perm = await currentDirHandle.requestPermission({ mode: 'readwrite' });
        log('writeToWorkdir: perm(after request)=', perm);
                if (perm !== 'granted') {
          setWorkdirReadyFlag(false);
          await updateWorkdirStatus(currentDirHandle);
          return false;
        }
      }
      const fileHandle = await currentDirHandle.getFileHandle(filename, { create: true });
      const w = await fileHandle.createWritable();
      await w.write(blob); await w.close();
      log('writeToWorkdir: ok ->', filename);
        // 成功時も READY を再確認してUIに反映
      setWorkdirReadyFlag(true);
      await updateWorkdirStatus(currentDirHandle);
      return true;
    } catch (e) {
      console.warn('writeToWorkdir failed:', e);
       // 失敗時は状態を未準備に落として UI も更新
      setWorkdirReadyFlag(false);
      if (currentDirHandle) await updateWorkdirStatus(currentDirHandle);
      return false;
    }
  }

    // 作業フォルダ設定ページ（workdir）を開く
  qs('#btnPickWorkdir')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GS_OPEN_WORKDIR_PAGE' });
    setStatus('作業フォルダ設定ページを開きます…');
  });

  
  // 解除も当面は設定ページ側に寄せる（ここではページを開くだけ）
  qs('#btnClearWorkdir')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GS_OPEN_WORKDIR_PAGE' });
    setStatus('作業フォルダ設定ページを開きます…');
  });

function requireWorkdirOrWarn() {
  if (!workdirReady) {
    const st = qs('#status');
    if (st) st.textContent = '先に「作業フォルダを選択」してください';
    return false;
  }
  return true;
}

// UIの主要ボタンを一括でdisable/enable
function setBulkDisabled(disabled) {
  [
    '#btnLoadCsv', '#btnSchemaExtract', '#btnRunQueue', '#btnQueueCsv',
    '#btnDownloadJson', '#btnDownloadCsv',
    '#btnExportPy', '#btnExportBatchKit'
  ].forEach(sel => {
    const el = qs(sel);
    if (el) el.disabled = !!disabled;
  });
}


  // ===== Mail config (UI <-> storage <-> file) =====
function defaultMailConfig() {
  return {
    smtp: { host: "", port: 465, security: "ssl" },
    auth: { user: "", password: "" },
    from: { name: "取得BOT", email: "" },
    to:   [],
    cc:   [],
    bcc:  [],
    attach: true,
    fail_notify: false,
    subject_template: "【取得報告】{list_name}_{date}",
    body_template: "{list_name}の取得が完了しました({pc_id})"
  };
}

function normalizeList(s) {
  return (String(s||"").split(",").map(x=>x.trim()).filter(Boolean));
}

function collectMailConfigFromUi() {
  return {
    smtp: {
      host: (qs('#mailSmtpHost')?.value || '').trim(),
      port: parseInt(qs('#mailSmtpPort')?.value || '465', 10) || 465,
      security: (qs('#mailSecurity')?.value || 'ssl')
    },
    auth: {
      user: (qs('#mailUser')?.value || '').trim(),
      password: (qs('#mailPass')?.value || '')
    },
    from: {
      name: (qs('#mailFromName')?.value || '取得BOT').trim(),
      email: (qs('#mailFromEmail')?.value || '').trim()
    },
    to:  normalizeList(qs('#mailTo')?.value || ''),
    cc:  normalizeList(qs('#mailCc')?.value || ''),
    bcc: normalizeList(qs('#mailBcc')?.value || ''),
    attach: !!qs('#mailAttach')?.checked,
    fail_notify: !!qs('#mailFailNotify')?.checked,
    subject_template: (qs('#mailSubjectTpl')?.value || '【取得報告】{list_name}_{date}'),
    body_template: (qs('#mailBodyTpl')?.value || '{list_name}の取得が完了しました({pc_id})')
  };
}

function applyMailConfigToUi(cfg) {
  const c = cfg || defaultMailConfig();
  if (qs('#mailFromName'))  qs('#mailFromName').value  = c.from?.name || '取得BOT';
  if (qs('#mailFromEmail')) qs('#mailFromEmail').value = c.from?.email || '';
  if (qs('#mailTo'))        qs('#mailTo').value        = (c.to || []).join(', ');
  if (qs('#mailCc'))        qs('#mailCc').value        = (c.cc || []).join(', ');
  if (qs('#mailBcc'))       qs('#mailBcc').value       = (c.bcc || []).join(', ');
  if (qs('#mailSmtpHost'))  qs('#mailSmtpHost').value  = c.smtp?.host || '';
  if (qs('#mailSmtpPort'))  qs('#mailSmtpPort').value  = c.smtp?.port || 465;
  if (qs('#mailSecurity'))  qs('#mailSecurity').value  = c.smtp?.security || 'ssl';
  if (qs('#mailUser'))      qs('#mailUser').value      = c.auth?.user || '';
  if (qs('#mailPass'))      qs('#mailPass').value      = c.auth?.password || '';
  if (qs('#mailAttach'))    qs('#mailAttach').checked  = !!c.attach;
  if (qs('#mailFailNotify'))qs('#mailFailNotify').checked = !!c.fail_notify;
  if (qs('#mailSubjectTpl'))qs('#mailSubjectTpl').value = c.subject_template || '【取得報告】{list_name}_{date}';
  if (qs('#mailBodyTpl'))   qs('#mailBodyTpl').value    = c.body_template || '{list_name}の取得が完了しました({pc_id})';
}

function setMailStatus(t) { const el = qs('#mailStatus'); if (el) el.textContent = t || ''; }

// 保存（storage.local）
async function saveMailConfigToStorage(cfg) {
  return new Promise(res => chrome.storage.local.set({ gs_mail_config: cfg }, () => res()));
}
async function loadMailConfigFromStorage() {
  return new Promise(res => chrome.storage.local.get(['gs_mail_config'], v => res(v.gs_mail_config || null)));
}

// ファイル保存（作業フォルダ or ダウンロード）
async function saveMailConfigToWorkdir(cfg) {
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const ok = await writeToWorkdir('mail_config.json', blob);
  if (!ok) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'mail_config.json'; a.click();
    URL.revokeObjectURL(url);
    return false;
  }
  return true;
}

// 作業フォルダに mail_config.json があれば取り込み
async function tryImportMailConfigFromWorkdir() {
  try {
    const dirHandle = await idbGet('workdir');
    if (!dirHandle) return false;
    const fh = await dirHandle.getFileHandle('mail_config.json', { create: false });
    const f = await fh.getFile();
    const text = await f.text();
    const cfg = JSON.parse(text);
    await saveMailConfigToStorage(cfg);
    applyMailConfigToUi(cfg);
    setMailStatus('作業フォルダの mail_config.json を読み込みました');
    return true;
  } catch (_) {
    return false;
  }
}

// UIイベント
qs('#mailShowPass')?.addEventListener('change', () => {
  const pw = qs('#mailPass'); if (pw) pw.type = (qs('#mailShowPass').checked ? 'text' : 'password');
});

// 「保存」ボタン
qs('#btnSaveMailConfig')?.addEventListener('click', async () => {
  const cfg = collectMailConfigFromUi();
  await saveMailConfigToStorage(cfg);
  const ok = await saveMailConfigToWorkdir(cfg);
  setMailStatus(ok ? 'mail_config.json を保存しました' : 'mail_config.json をダウンロードしました');
});

// 起動時：storage → UI 反映（無ければデフォ）
(async () => {
  const loaded = await loadMailConfigFromStorage();
  applyMailConfigToUi(loaded || defaultMailConfig());
  // 作業フォルダが選択済みなら自動取り込み（あれば上書き）
  await tryImportMailConfigFromWorkdir();
})();


  function buildRenamePy() {
  // ※ cleansing() は必要に応じて中身を書いてください（今は素通し）
  return `# -*- coding: utf-8 -*-
import sys, os, datetime
import pandas as pd

def cleansing(df: pd.DataFrame) -> pd.DataFrame:
    # TODO: 必要なクレンジングがある場合はここで実装
    return df

def main():
    if len(sys.argv) != 4:
        print("使い方: python rename.py <pc_id> <list_name> <csvファイルパス>")
        sys.exit(1)

    pc_id = sys.argv[1]
    list_name = sys.argv[2]
    file_path = sys.argv[3]

    if not os.path.isfile(file_path):
        print(f"エラー: ファイルが見つかりません: {file_path}")
        sys.exit(1)

    today = datetime.datetime.now().strftime("%Y%m%d")

    try:
        df = pd.read_csv(file_path, encoding='utf-8-sig', encoding_errors='ignore',
                         engine='python', on_bad_lines='skip')
    except Exception as e:
        print(f"エラー: CSVの読み込みに失敗しました: {e}")
        sys.exit(1)

    df = cleansing(df)
    num = len(df)

    new_filename = f"{today}_{pc_id}_{list_name}_{num}件.csv"
    dir_name = os.path.dirname(file_path)
    new_path = os.path.join(dir_name, new_filename)

    try:
        df.to_csv(new_path, index=False, encoding='utf-8-sig')
        print(f"ファイルを保存しました: {new_filename}")
    except Exception as e:
        print(f"エラー: ファイルの保存中に問題が発生しました: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
`;
}

function buildSendPy() {
return `# -*- coding: utf-8 -*-
import sys, os, datetime
import pandas as pd


def cleansing(df: pd.DataFrame) -> pd.DataFrame:
    """
    クレンジング処理:
    - 日時とURL以外がすべて空欄またはNaNの行を削除
    """
    if df.empty:
        return df

    # 全列が2列以上ある前提（日時とURLの列が1,2列目）
    if df.shape[1] > 2:
        # 3列目以降を対象に「何かしら値がある行」を残す
        mask = df.iloc[:, 2:].notna().any(axis=1) & (df.iloc[:, 2:] != "").any(axis=1)
        cleaned = df[mask].copy()
        print(f"空欄行削除: {len(df) - len(cleaned)} 件削除 ({len(cleaned)} 件残存)")
        return cleaned
    else:
        print("列が2列以下のため、空欄削除スキップ")
        return df


def main():
    if len(sys.argv) != 4:
        print("使い方: python rename.py <pc_id> <list_name> <csvファイルパス>")
        sys.exit(1)

    pc_id = sys.argv[1]
    list_name = sys.argv[2]
    file_path = sys.argv[3]

    if not os.path.isfile(file_path):
        print(f"エラー: ファイルが見つかりません: {file_path}")
        sys.exit(1)

    today = datetime.datetime.now().strftime("%Y%m%d")

    try:
        df = pd.read_csv(
            file_path,
            encoding="utf-8-sig",
            encoding_errors="ignore",
            engine="python",
            on_bad_lines="skip",
        )
    except Exception as e:
        print(f"エラー: CSVの読み込みに失敗しました: {e}")
        sys.exit(1)

    # --- クレンジング処理 ---
    df = cleansing(df)

    num = len(df)
    new_filename = f"{today}_{pc_id}_{list_name}_{num}件.csv"
    dir_name = os.path.dirname(file_path)
    new_path = os.path.join(dir_name, new_filename)

    try:
        df.to_csv(new_path, index=False, encoding="utf-8-sig")
        print(f"ファイルを保存しました: {new_filename}")
    except Exception as e:
        print(f"エラー: ファイルの保存中に問題が発生しました: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

`;
}


function buildRunBat(pcId, listName, inputCsvName) {
  const INPUT = inputCsvName || 'input.csv';
  return `
rem If you are running it for the first time, please run the following two lines:
rem pip install playwright
rem python -m playwright install chromium

@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

set "PC_ID=02"
set "LIST_NAME=jobchan_detail_urls_2"

set "INPUT_CSV=jobchan_detail_urls_2.csv"
set "OUTPUT_CSV=datalist.csv"

if not exist "%INPUT_CSV%" (
  echo ERROR: INPUT_CSV not found: "%INPUT_CSV%"
  goto :ERR
)

set "PY_EXE="
set "PY_ARGS="

where python >nul 2>&1 && set "PY_EXE=python"
if not defined PY_EXE (
  where py >nul 2>&1 && ( set "PY_EXE=py" & set "PY_ARGS=-3" )
)
if not defined PY_EXE (
  echo ERROR: Python not found.
  goto :ERR
)

echo PY: %PY_EXE% %PY_ARGS%

if exist "%OUTPUT_CSV%" del /f /q "%OUTPUT_CSV%"

echo --- run scraper ---
"%PY_EXE%" %PY_ARGS% gui_scraper_runner.py "%INPUT_CSV%" "%OUTPUT_CSV%"
if errorlevel 1 goto :ERR

echo --- rename ---
"%PY_EXE%" %PY_ARGS% rename.py "%PC_ID%" "%LIST_NAME%" "%OUTPUT_CSV%"
if errorlevel 1 goto :ERR

echo rename finished. pausing 5s...
timeout /t 5 /nobreak >nul

set "RENAMED="
for /f "delims=" %%F in ('dir /b /a:-d /o:-d *.csv 2^>nul') do (
  if /i not "%%~nxF"=="%OUTPUT_CSV%" (
    set "RENAMED=%cd%\%%F"
    goto :FOUND_RENAMED
  )
)
:FOUND_RENAMED

if not defined RENAMED (
  echo ERROR: renamed CSV not found
  goto :ERR
)

echo RENAMED: %RENAMED%

echo --- send ---
"%PY_EXE%" %PY_ARGS% send.py "%PC_ID%" "%LIST_NAME%" "%RENAMED%"
if errorlevel 1 goto :ERR

echo send finished. pausing 5s...
timeout /t 5 /nobreak >nul

echo DONE
popd
exit /b 0

:ERR
echo FAILED
popd
exit /b 1
`;
}





qs('#btnExportBatchKit')?.addEventListener('click', async () => {
  if (!requireWorkdirOrWarn()) return;

  const pcId     = (qs('#gsPcId')?.value || '').trim();
  const listName = (qs('#gsListName')?.value || '').trim();

  // 直近取り込みCSV名（なければ 'input.csv'）
  const meta = await new Promise(res => chrome.storage.local.get(['gs_lastCsv'], v => res(v.gs_lastCsv || null)));
  const inputCsvName = meta?.name || 'input.csv';

  // ★ 同梱しない方針：mail_config.json は “メール設定 → 保存” で別途出す
  const files = [
    ['rename.py',  buildRenamePy()],
    // ['send.py',    buildSendPy()],
    ['run.bat',    buildRunBat(pcId, listName, inputCsvName)],
  ];

  let savedAll = true;
  for (const [name, text] of files) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const ok = await writeToWorkdir(name, blob);
    if (!ok) savedAll = false; // ダウンロードにフォールバックしない（MOTW回避）
  }

  setBatchKitStatus(
    savedAll
      ? 'run.bat / rename.py を作業フォルダに保存しました'
      : '一部保存に失敗しました（作業フォルダ権限を確認してください）'
  );
  setStatus(savedAll ? 'バッチキット出力：成功' : 'バッチキット出力：一部失敗');

  // ---- POST-PROCESS: run.bat をコピー新規作成して元を削除（MOTW回避）----
  try {
    if (!savedAll) {
      setBatchKitStatus('一部保存失敗のため、run.batのコピー作成はスキップしました。');
      return;
    }
    const dirHandle = await idbGet('workdir');
    if (!dirHandle) {
      setBatchKitStatus('作業フォルダ未選択のため、run.batのコピー作成はスキップしました。');
      return;
    }

    // まず元の run.bat を読む
    let srcHandle;
    try {
      srcHandle = await dirHandle.getFileHandle('run.bat', { create: false });
    } catch {
      setBatchKitStatus('run.bat が見つからず、コピー作成をスキップしました。');
      return;
    }
    const srcFile = await srcHandle.getFile();
    let batText = await srcFile.text();
    // BOM除去 & 改行を CRLF に（念のため）
    if (batText.charCodeAt(0) === 0xFEFF) batText = batText.slice(1);
    batText = batText.replace(/\r?\n/g, '\r\n');

    // run_local.bat（重複回避で連番）
    const base = 'run_local';
    const ext = '.bat';
    let outName = base + ext;
    const exists = async (name) => {
      try { await dirHandle.getFileHandle(name, { create: false }); return true; }
      catch { return false; }
    };
    let i = 1;
    while (await exists(outName)) {
      outName = `${base}_${i}${ext}`;
      i++;
      if (i > 50) break;
    }

    // 新規作成（新ファイル＝MOTWなし）
    const outHandle = await dirHandle.getFileHandle(outName, { create: true });
    const w = await outHandle.createWritable();
    await w.write(new Blob([batText], { type: 'text/plain' }));
    await w.close();

    // 元の run.bat を削除
    try {
      await dirHandle.removeEntry('run.bat');
    } catch (_) {
      // 削除失敗は致命的ではない
    }

    setBatchKitStatus(`実行用バッチを作成しました: ${outName}（元の run.bat は削除）`);
  } catch (e) {
    console.warn('run.bat duplicate/delete failed:', e);
    setBatchKitStatus('run.bat のコピー作成でエラーが発生しました。エクスプローラの「ブロック解除」も検討してください。');
  }
});



//   if (qs('#crawlPageParamKeys') && !qs('#crawlPageParamKeys').value) {
//   qs('#crawlPageParamKeys').value = 'p';
// }

  function schemaFieldNames() {
  return (xpathSchema.fields || []).map(f => f.name);
}
function orderedColsForCsv() {
  return ['取得日時','URL', ...schemaFieldNames()];
}


  const statusEl      = qs('#status');       // 汎用
  const previewEl     = qs('#preview');      // ③の下に移動したプレビュー
  const queueStatusEl = qs('#queueStatus');  // ④ 一括実行の直下
  const csvStatusEl   = qs('#csvStatus');    // ② CSVの直下（新規）
  const lastCsvInfoEl = qs('#lastCsvInfo');
  const workdirStatusEl = qs('#workdirStatus');
  const pcIdInput     = qs('#gsPcId');
  const listNameInput = qs('#gsListName');
  const nameInput     = qs('#gsName');


  let lastResult  = { selector: null, items: [] };
  let xpathSchema = { fields: [] };
  let loadedUrls  = [];
  let csvReady    = false;
  let currentDirHandle = null;

  // ▼ URL収集用の状態（CSVなしでもOKにするため）
  // let crawlerSeeds = []; // シードURL（CSV読み込みで追加。seedXPathがある場合は空でもOK）

  // URL収集：入力ゲッター（popup.html の ID と一致させる）
  // const getSeedXPath = () => (qs('#crawlSeedXPath')?.value || '').trim();  // （任意）都道府県などのシードXPath
  // const getLinkXPath = () => (qs('#crawlLinkXPath')?.value || '').trim();  // （必須）一覧の各詳細リンクXPath
  // const getNextXPath = () => (qs('#crawlNextXPath')?.value || '').trim();  // （任意）次へボタンXPath

//   const getPageParamKeys = () => {
//   const raw = (qs('#crawlPageParamKeys')?.value || '').trim();
//   if (!raw) return ['p'];
//   return raw.split(',').map(s => s.trim()).filter(Boolean);
// };


  // ステータス表示
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };
  const setQueueStatus = (t) => { if (queueStatusEl) queueStatusEl.textContent = t || ''; };
  const setCsvStatus = (t) => { if (csvStatusEl) csvStatusEl.textContent = t || ''; };
  // 追加：ボタン直下に出す専用ログ
  const setPyStatus = (t) => {
    const el = document.querySelector('#pyExportStatus');
    if (el) el.textContent = t || '';
  };
  const setBatchKitStatus = (t) => {
    const el = document.querySelector('#batchKitStatus');
    if (el) el.textContent = t || '';
  };

  // const setCrawlStatus = (t) => { const el = qs('#crawlStatus'); if (el) el.textContent = t || ''; };

  // 「URL収集開始」ボタン活性ロジック
  // function updateCrawlerUiState() {
  //   const startBtn = qs('#btnCrawlRun');
  //   if (!startBtn) return;
  //   const hasLink = !!getLinkXPath();
  //   const hasSeeds = (crawlerSeeds?.length || 0) > 0 || !!getSeedXPath();
  //   startBtn.disabled = !(hasLink && hasSeeds);
  // }
  

  function renderPreview(items) {
    if (!previewEl) return;
    if (!items || !items.length) { previewEl.innerHTML = ''; return; }
    const cols = orderedColsForCsv();
    const header = cols.join(',');
    const rows = items.map(r =>
      cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header, ...rows].join('\n');
    const head = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
    previewEl.innerHTML = `<table>${head}${rows}</table>`;
  }

  function updateUiState() {
    // 作業フォルダ未選択なら、ほぼ全部を停止
    if (!workdirReady) {
      setBulkDisabled(true);
      const wd = qs('#workdirStatus');
      if (wd) wd.textContent = '未選択 / 必須';
      return;
    }

    // 作業フォルダOKなら従来の条件で活性化
    setBulkDisabled(false);

    const hasSchema = !!(xpathSchema.fields && xpathSchema.fields.length);
    const btnRunQueue = qs('#btnRunQueue');
    if (btnRunQueue) btnRunQueue.disabled = !(csvReady && hasSchema);
  }

  function updateLastCsvInfo(meta){
    if (!lastCsvInfoEl) return;
    if (!meta || !meta.urls?.length) {
      lastCsvInfoEl.textContent = '';
      return;
    }
    const dt = meta.savedAt ? new Date(meta.savedAt) : null;
    const when = dt ? dt.toLocaleString() : '';
    lastCsvInfoEl.textContent =
      `前回CSV: ${meta.name || '(名称不明)'} / URL: ${meta.urls.length}件 / ヘッダー:${meta.skipHeader?'ON':'OFF'} ${when ? `(${when})` : ''}`;
  }


  // 起動時ロード
  chrome.storage.local.get(['guiScraperXPathSchema', 'gs_lastCsv', 'gs_extract_mode', 'gs_pc_id', 'gs_list_name', 'gs_name'], async (obj) => {
    console.log('[POPUP] storage.get start');
    // 復元済みの currentDirHandle を表示に反映
    try {
      await updateWorkdirStatus(currentDirHandle || null);
      const perm = currentDirHandle
        ? await currentDirHandle.queryPermission?.({ mode:'readwrite' })
        : 'denied';
      setWorkdirReadyFlag(perm === 'granted');
    } catch (_) {
      await updateWorkdirStatus(null);
      setWorkdirReadyFlag(false);
    }

    if (obj.guiScraperXPathSchema) xpathSchema = obj.guiScraperXPathSchema;
    renderSchemaTable();

    const last = obj.gs_lastCsv;
    if (last && Array.isArray(last.urls) && last.urls.length) {
      loadedUrls = last.urls.slice();
      csvReady = true;
      updateLastCsvInfo(last);
      setStatus(`（前回のCSVを記憶）URL ${loadedUrls.length} 件`);
    }
    try {
      const dirHandle = await idbGet('workdir');
      updateWorkdirStatus(dirHandle || null);
      setWorkdirReadyFlag(!!dirHandle);
    } catch (_) {
      updateWorkdirStatus(null);
      setWorkdirReadyFlag(false);
    }
    

    // 抽出モードの復元
    setMode(obj?.gs_extract_mode || 'auto');

    // 直近の一括実行の所要時間（任意表示）
    chrome.storage.local.get(['gs_lastRun'], (o2) => {
      const lr = o2?.gs_lastRun;
      if (lr && typeof lr.elapsedMs === 'number') {
        const t = fmtDuration(lr.elapsedMs);
        setStatus(`直近の一括実行: ${lr.done}/${lr.total}（失敗: ${lr.failed || 0}） 所要時間: ${t}`);
      }
    });

     // ▼ 追加：PC ID / リスト名の復元
    if (pcIdInput)     pcIdInput.value     = obj.gs_pc_id     || '';
    if (listNameInput) listNameInput.value = obj.gs_list_name || '';
    if (nameInput)     nameInput.value     = obj.gs_name      || '';

    // ▼ 追加：CSV読み込み済みなら、リスト名が未設定の場合はCSV名のベースを初期値に
    if (obj.gs_lastCsv?.name && listNameInput && !listNameInput.value) {
      const base = obj.gs_lastCsv.name.replace(/\.[^.]+$/, '');
      listNameInput.value = base;
      chrome.storage.local.set({ gs_list_name: base });
    }

    updateUiState();
    // updateCrawlerUiState(); // URL収集の活性も初期化
    console.log('[POPUP] storage.get get');
  });

    pcIdInput?.addEventListener('input', () => {
    chrome.storage.local.set({ gs_pc_id: (pcIdInput.value || '').trim() });
  });
  listNameInput?.addEventListener('input', () => {
    chrome.storage.local.set({ gs_list_name: (listNameInput.value || '').trim() });
  });

  // ここから追記：PC ID / リスト名の保存・復元
  chrome.storage.local.get(['gs_pc_id', 'gs_list_name'], (obj) => {
    if (qs('#gsPcId')) qs('#gsPcId').value = obj.gs_pc_id || '';
    if (qs('#gsListName')) qs('#gsListName').value = obj.gs_list_name || '';
    if (qs('#gsName'))     qs('#gsName').value     = obj.gs_name      || '';
  });

  // 入力即保存
  qs('#gsPcId')?.addEventListener('input', () =>
    chrome.storage.local.set({ gs_pc_id: (qs('#gsPcId').value || '').trim() })
  );
  qs('#gsListName')?.addEventListener('input', () =>
    chrome.storage.local.set({ gs_list_name: (qs('#gsListName').value || '').trim() })
  );
  qs('#gsName')?.addEventListener('input', () =>
  chrome.storage.local.set({ gs_name: (qs('#gsName').value || '').trim() })
  );



  // モード変更を保存
  document.querySelectorAll('input[name="gs_mode"]').forEach(r =>
    r.addEventListener('change', () =>
      chrome.storage.local.set({ gs_extract_mode: getMode() })));

  function renderSchemaTable() {
    const box = qs('#schemaTable');
    if (!box) return;
    if (!xpathSchema.fields.length) {
      box.innerHTML = '<div class="small">（スキーマ未登録）</div>';
      updateUiState();
      return;
    }
    const head = `<tr><th>順</th><th>カラム名</th><th>xpath</th><th>attr</th><th>proc</th><th></th></tr>`;
    const rows = xpathSchema.fields.map((f,i)=>`<tr>
      <td>${i+1}</td>
      <td>${f.name}</td>
      <td><code>${(f.xpath||'')}</code></td>
      <td>${f.attr}</td>
      <td>${f.proc}</td>
      <td><button data-del="${i}">削除</button></td>
    </tr>`).join('');
    box.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse;">${head}${rows}</table>`;
    box.querySelectorAll('button[data-del]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const idx = +btn.getAttribute('data-del');
        xpathSchema.fields.splice(idx,1);
        chrome.storage.local.set({ guiScraperXPathSchema: xpathSchema }, () => {
          renderSchemaTable();
          updateUiState();
        });
      });
    });
    updateUiState();
    
  
  }

  // ① カラム指定（ミニビルダー）
  const btnOpenBuilder = qs('#btnOpenBuilder');
  if (btnOpenBuilder) btnOpenBuilder.addEventListener('click', () => {
    withActiveHttpTab((tabId) => {
      chrome.tabs.sendMessage(tabId, { type: 'GS_PING' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          setStatus('このページではcontent.jsが未起動です。ページをリロードしてください。');
          return;
        }
        // 応答を待たずに閉じる（ポート警告対策）
        chrome.tabs.sendMessage(tabId, { type: 'GS_OPEN_MINI_BUILDER' }), { frameId: 0 };
        setTimeout(() => window.close(), 30);
      });
    });
  });

  const btnSchemaClear = qs('#btnSchemaClear');
  if (btnSchemaClear) btnSchemaClear.addEventListener('click', () => {
    xpathSchema = { fields: [] };
    chrome.storage.local.set({ guiScraperXPathSchema: xpathSchema }, () => {
      renderSchemaTable();
      setStatus('スキーマをクリアしました');
      updateUiState();
    });
  });

  // ② CSV 読み込み（記憶）
  function parseCsvToUrls(text, skipFirst){
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const split = (s) => {
      // 単純CSV（カンマ・ダブルクォート対応の簡易版）
      const cells = [];
      let cur = '', inQ = false;
      for (let i=0;i<s.length;i++){
        const ch = s[i];
        if (ch === '"') {
          if (inQ && s[i+1] === '"'){ cur+='"'; i++; }
          else inQ = !inQ;
        } else if (ch === ',' && !inQ){ cells.push(cur.trim()); cur=''; }
        else cur += ch;
      }
      cells.push(cur.trim());
      return cells.map(x => x.replace(/^"|"$/g,''));
    };
    const start = skipFirst ? 1 : 0;
    const urls = [];
    for (let i = start; i < lines.length; i++) {
      const cells = split(lines[i]);
      const v = (cells[0] || '').trim();
      if (/^https?:\/\//i.test(v)) urls.push(v);
    }
    return urls;
  }

const btnLoadCsv = qs('#btnLoadCsv');
  if (btnLoadCsv) btnLoadCsv.addEventListener('click', async () => {
    setCsvStatus('CSV読み込みを開始しました…');
    btnLoadCsv.disabled = true;

    try {
      const input = qs('#csvUpload');
      if (!input?.files?.length) {
        setCsvStatus('CSVファイルを選択してください');
        return;
      }

      const file = input.files[0];
      const skipFirst = !!(qs('#csvSkipHeader')?.checked);

      // 1) 読み込み
      setCsvStatus('CSVを読み込んでいます…');
      const text = await file.text();

      // 2) 解析
      setCsvStatus('CSVを解析しています…');
      loadedUrls = parseCsvToUrls(text, skipFirst);
      csvReady = loadedUrls.length > 0;

      // 3) 作業フォルダへ保存（MOTW回避）
      setCsvStatus(`作業フォルダに保存しています…（${loadedUrls.length}件）`);
      const blob = new Blob([text], { type: file.type || 'text/csv;charset=utf-8;' });

      // ←← ここ重要：外に変数を置いて、try 内で代入 → 後で使う
      let savedToWorkdir = false;
      try {
        savedToWorkdir = await writeToWorkdir(file.name, blob);
      } catch (e) {
        console.warn('writeToWorkdir failed:', e);
        savedToWorkdir = false;
      }

      // 4) 記録
      const meta = { name: file.name, skipHeader: skipFirst, urls: loadedUrls, savedAt: Date.now() };
      await new Promise(res => chrome.storage.local.set({ gs_lastCsv: meta }, res));
      updateLastCsvInfo(meta);

      // 5) UI反映
      const headerNote = skipFirst ? 'スキップ' : '未スキップ';
      const msg = `CSV取り込み: ${loadedUrls.length} 件（ヘッダー${headerNote}）`
                + (savedToWorkdir ? '\n作業フォルダに保存しました' : '\n作業フォルダ保存に失敗しました');
      setCsvStatus(msg);

      // 初回はリスト名をCSV名から自動補完（空のときだけ）
      const base = file.name.replace(/\.[^.]+$/, '');
      if (qs('#gsListName') && !qs('#gsListName').value) {
        qs('#gsListName').value = base;
        chrome.storage.local.set({ gs_list_name: base });
      }

      updateUiState();
    } catch (e) {
      console.error(e);
      setCsvStatus('CSVの読み込みに失敗しました');
    } finally {
      btnLoadCsv.disabled = false;
    }
  });



  // ---- CSV自動保存ヘルパー（単ページ/一括用） ----
  function buildCsvFromItems(items) {
    const cols = orderedColsForCsv();
    const header = cols.join(',');
    const rows = items.map(r =>
      cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header, ...rows].join('\n');
    return [header, ...rows].join('\n');
  }
  function tsStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  async function autoSaveBatchResults(items) {
    if (!items?.length) return false;

    const csv = buildCsvFromItems(items);
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });

    // 前回CSV名があればベース名に利用
    const meta = await new Promise(res => chrome.storage.local.get(['gs_lastCsv'], v => res(v.gs_lastCsv)));
    const base = (meta?.name ? meta.name.replace(/\.[^.]+$/,'') : 'gui_scraper_batch');
    const filename = `${base}_result_${tsStamp()}.csv`;

    // 作業フォルダに保存（権限がなければダウンロード）
    const ok = await writeToWorkdir(filename, blob);
    if (!ok) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }
    return true;
  }

  // ③ プレビュー（このページ：全フレーム）
  const btnSchemaExtract = qs('#btnSchemaExtract');
  if (btnSchemaExtract) btnSchemaExtract.addEventListener('click', async () => {
    if (!xpathSchema.fields.length) { setStatus('先に「カラム指定」でスキーマを登録してください'); return; }
    const singleRow = !!qs('#optSingleRow')?.checked;

    const resp = await extractFromAllFrames(xpathSchema, singleRow);
    if (!resp || !resp.ok) { setStatus(resp?.error || '抽出に失敗'); return; }

    lastResult = { selector:'XPathSchema', items: resp.items || [] };
    renderPreview(lastResult.items);
    const previewEl2 = document.querySelector('#preview');
    if (resp.debug) {
      renderDebugBox(previewEl2, resp.debug);
    }

    setStatus(`（プレビュー）抽出 ${lastResult.items.length} 行`);
  });

  // 単ページ結果：保存
  const btnDownloadJson = qs('#btnDownloadJson');
  if (btnDownloadJson) btnDownloadJson.addEventListener('click', async () => {
    if (!(lastResult.items?.length)) { setStatus('先に「プレビュー（このページ）」を実行してください'); return; }
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    if (!requireWorkdirOrWarn()) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_result.json'; a.click();
    URL.revokeObjectURL(url);
    setStatus('JSONをダウンロードしました');
  });

  const btnDownloadCsv = qs('#btnDownloadCsv');
  if (btnDownloadCsv) btnDownloadCsv.addEventListener('click', async () => {
    if (!(lastResult.items?.length)) { setStatus('先に「プレビュー（このページ）」を実行してください'); return; }
    const cols = orderedColsForCsv();
    const header = cols.join(',');
    const rows = lastResult.items.map(r =>
      cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_result.csv'; a.click();
    URL.revokeObjectURL(url);
    setStatus('CSVをダウンロードしました');
  });

  // ④ 一括実行（CSVのURLを参照） —— 実処理は background.js
  const btnRunQueue = qs('#btnRunQueue');
  if (btnRunQueue) btnRunQueue.addEventListener('click', () => {
    if (!csvReady) { setStatus('先にCSVを読み込んでください'); return; }
    if (!xpathSchema.fields.length) { setStatus('先に「カラム指定」でスキーマを登録してください'); return; }
    const singleRow = !!qs('#optSingleRow')?.checked;
    const mode = getMode(); // ← 追加：抽出モード
    chrome.runtime.sendMessage({ type: 'GS_QUEUE_LOAD', urls: loadedUrls }, () => {
      if (chrome.runtime.lastError) { setStatus('キュー送信エラー: ' + chrome.runtime.lastError.message); return; }
      chrome.runtime.sendMessage({ type: 'GS_QUEUE_RUN', singleRow, mode }, () => {
        if (chrome.runtime.lastError) { setStatus('実行開始エラー: ' + chrome.runtime.lastError.message); return; }
        setQueueStatus(`一括実行を開始しました…（モード: ${mode}）`);
      });
    });
  });

  const btnQueueCsv = qs('#btnQueueCsv');
  if (btnQueueCsv) btnQueueCsv.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GS_QUEUE_GET_RESULTS' }, async (resp) => {
      if (!resp || !resp.ok) { setStatus(resp?.error || '結果の取得に失敗'); return; }
      const items = resp.items || [];
      if (!items.length) { setStatus('まだ一括結果がありません'); return; }
      const cols = orderedColsForCsv();
      const header = cols.join(',');
      const rows = items.map(r =>
        cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g,'""')}"`).join(',')
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });

      if (!requireWorkdirOrWarn()) return;
        const ok = await writeToWorkdir('gui_scraper_batch_result.csv', blob);
      if (ok) {
        setQueueStatus(`一括結果 ${items.length} 行を作業フォルダに保存しました`);
        return;
      }
      // フォールバック：ダウンロード
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_batch_result.csv'; a.click();
      URL.revokeObjectURL(url);
      setQueueStatus(`一括結果 ${items.length} 行をダウンロードしました`);
    });
  });

  // === 追加：Pythonコードを生成（取得日時を秒まで/JST） ===
// 先頭付近のユーティリティに追加（1回だけ定義）
// 先頭付近のユーティリティに追加（1回だけ定義）
function stripIndent(s) {
  // 先頭の共通インデントを除去
  const m = s.match(/^[ \t]*(?=\S)/gm);
  if (!m) return s;
  const indent = Math.min(...m.map(x => x.length));
  return s.replace(new RegExp(`^[ \\t]{${indent}}`, 'gm'), '');
}

// === これを唯一の buildPythonScript として使う（古いものは削除） ===
function buildPythonScript(schema, opts){
  const SINGLE_ROW = !!opts.singleRow;
  const CSV_SKIP_HEADER = !!opts.csvSkipHeader;
  const schemaJson = JSON.stringify(schema, null, 2);

  return stripIndent(`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Generated by GUI_Scraper (Chrome Extension)

# 初めての場合は下記の2行を実行してください
# pip install playwright
# python -m playwright install chromium

import asyncio, csv, re, json, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from playwright.async_api import async_playwright

SCHEMA_JSON = r'''${schemaJson}'''
SCHEMA = json.loads(SCHEMA_JSON)

SINGLE_ROW = ${SINGLE_ROW ? 'True' : 'False'}
CSV_SKIP_HEADER = ${CSV_SKIP_HEADER ? 'True' : 'False'}

JST = timezone(timedelta(hours=9))
def now_jst():
    return datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

def apply_proc(val, proc):
    val = (val or "")
    if proc == "digits":
        return re.sub(r"\\D+", "", val)
    elif proc == "yenToMan":
        t = re.sub(r"[ ,，\\s]", "", val)
        yen = 0
        m1 = re.search(r"([\\d.]+)万円", t)
        if m1: yen += round(float(m1.group(1)) * 10000)
        m2 = re.search(r"([\\d.]+)億", t)
        if m2: yen += round(float(m2.group(1)) * 100000000)
        m3 = re.search(r"([\\d.]+)万(?!円)", t)
        if m3: yen += round(float(m3.group(1)) * 10000)
        m4 = re.search(r"([\\d.]+)円", t)
        if m4: yen += round(float(m4.group(1)))
        if not (m1 or m2 or m3 or m4):
            digs = re.findall(r"\\d+", t)
            if digs: yen += int("".join(digs))
        return str(round(yen/10000)) if yen else ""
    elif proc == "dateYmd":
        x = val.strip()
        jp = re.search(r"(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日", x)
        if jp:
            y, m, d = int(jp.group(1)), int(jp.group(2)), int(jp.group(3))
            return f"{y}/{m:02d}/{d:02d}"
        m1 = re.search(r"(\\d{4})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{1,2})", x)
        if m1:
            y, m, d = int(m1.group(1)), int(m1.group(2)), int(m1.group(3))
            return f"{y}/{m:02d}/{d:02d}"
        return ""
    elif proc == "normalizeSpace":
        return re.sub(r"[\\s\\u3000]+", " ", val).strip()
    elif proc == "noSpaces":
        return re.sub(r"[\\s\\u3000]+", "", val)
    elif proc == "noNewlines":
        return re.sub(r"(\\r?\\n|\\r)", "", val)
    else:
        return val.strip()

async def extract_page(page, schema, single_row):
    data = {}
    max_len = 0
    for fdef in schema.get("fields", []):
        xp   = (fdef.get("xpath") or "").strip()
        attr = (fdef.get("attr")  or "text").strip()
        proc = (fdef.get("proc")  or "text").strip()
        vals = []
        if xp:
            elems = await page.query_selector_all(f"xpath={xp}")
            limit = min(1, len(elems)) if single_row else len(elems)
            for i in range(limit):
                el = elems[i]
                if not el:
                    continue
                if attr == "text":
                    raw = await el.text_content() or ""
                elif attr == "html":
                    raw = await el.inner_html() or ""
                elif attr == "href":
                    raw = await el.evaluate(\"\"\"(el)=>{const a=el.closest('a'); return a?a.href:(el.getAttribute('href')||'');}\"\"\") or ""
                elif attr == "src":
                    raw = await el.get_attribute("src") or ""
                else:
                    raw = await el.text_content() or ""
                vals.append(apply_proc(raw, proc))
        data[fdef["name"]] = vals
        if not single_row and len(vals) > max_len:
            max_len = len(vals)

    items = []
    if single_row:
        row = { name: (vals[0] if vals else "") for name, vals in data.items() }
        if "取得日時" not in row:
            row["取得日時"] = now_jst()
        items.append(row)
    else:
        rows = max(max_len, 1)
        for r in range(rows):
            row = {}
            for name, vals in data.items():
                row[name] = vals[r] if r < len(vals) else ""
            if "取得日時" not in row:
                row["取得日時"] = now_jst()
            items.append(row)
    return items

def empty_row_for_url(u):
    row = {"取得日時": now_jst(), "URL": u}
    for fdef in SCHEMA.get("fields", []):
        row[fdef["name"]] = ""
    return row

def ordered_cols_from_schema():
    base = ["取得日時", "URL"] + [f["name"] for f in SCHEMA.get("fields", [])]
    out = []
    for c in base:
        if c not in out:
            out.append(c)
    return out

async def main():
    input_csv  = sys.argv[1] if len(sys.argv) >= 2 else "input.csv"
    output_csv = sys.argv[2] if len(sys.argv) >= 3 else "output.csv"

    urls = []
    with open(input_csv, newline="", encoding="utf-8-sig") as rf:
        reader = csv.reader(rf)
        if CSV_SKIP_HEADER:
            next(reader, None)
        for row in reader:
            if not row:
                continue
            u = (row[0] or "").strip()
            if u.lower().startswith("http"):
                urls.append(u)

    ordered_cols = ordered_cols_from_schema()
    p = Path(output_csv)
    need_header = not (p.exists() and p.stat().st_size > 0)

    mode = "w" if need_header else "a"
    enc  = "utf-8-sig" if need_header else "utf-8"
    f = open(output_csv, mode, newline="", encoding=enc)
    writer = csv.DictWriter(
        f,
        fieldnames=ordered_cols,
        quoting=csv.QUOTE_ALL,
        lineterminator="\\r\\n"
    )
    if need_header:
        writer.writeheader(); f.flush()

    async with async_playwright() as pwt:
        browser = await pwt.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        for i, u in enumerate(urls, start=1):
            print(f"[{i}/{len(urls)}] GET {u}")
            try:
                await page.goto(u, wait_until="domcontentloaded", timeout=60000)
                await page.wait_for_timeout(400)

                # ★ 欠陥②の修正：実際に到達したURLを使う
                actual_url = page.url
                try:
                    first_xp = next((fd["xpath"] for fd in SCHEMA.get("fields", []) if fd.get("xpath")), None)
                    if first_xp:
                        await page.wait_for_selector(f"xpath={first_xp}", timeout=3000)
                except Exception:
                    pass

                items = await extract_page(page, SCHEMA, SINGLE_ROW)
                rows = []
                if not items:
                    rows.append(empty_row_for_url(actual_url))
                else:
                    for it in items:
                        row = empty_row_for_url(actual_url)
                        for fdef in SCHEMA.get("fields", []):
                            row[fdef["name"]] = it.get(fdef["name"], "")
                        if not row.get("取得日時"):
                            row["取得日時"] = now_jst()
                        rows.append(row)

                for row in rows:
                    for c in ordered_cols:
                        row.setdefault(c, "")
                        if isinstance(row[c], str):
                            row[c] = row[c].replace("\\r\\n", "\\n").replace("\\r", "\\n")
                    writer.writerow(row)
                f.flush()  # 1URLごとに追記

            except Exception as e:
                print("  ! error:", e)
                row = empty_row_for_url(u)
                for c in ordered_cols:
                    row.setdefault(c, "")
                writer.writerow(row); f.flush()

        await browser.close()

    f.close()
    print(f"Appended {len(urls)} pages to {output_csv}")

if __name__ == "__main__":
    asyncio.run(main())
`);
}



  const btnExportPy = qs('#btnExportPy');
  if (btnExportPy) btnExportPy.addEventListener('click', async () => {
    if (!xpathSchema.fields.length) { setStatus('先に「カラム指定」でスキーマを登録してください'); return; }
    const meta = (await new Promise(res => chrome.storage.local.get(['gs_lastCsv'], v => res(v.gs_lastCsv)))) || {};
    const singleRow = !!qs('#optSingleRow')?.checked;
    const csvSkipHeader = meta.skipHeader ?? !!qs('#csvSkipHeader')?.checked;

    const py = buildPythonScript(xpathSchema, { singleRow, csvSkipHeader });
    const blob = new Blob([py], { type: 'text/x-python;charset=utf-8;' });
    if (!requireWorkdirOrWarn()) return;
    const ok = await writeToWorkdir('gui_scraper_runner.py', blob);
    if (ok) {
      setPyStatus('作業フォルダに Python コードを保存しました');
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'gui_scraper_runner.py'; a.click();
      URL.revokeObjectURL(url);
      setPyStatus('Python コードをダウンロードしました');
    }
    // 全体の案内は従来どおり #status に出す（任意）
    setStatus(
      'Pythonコードを生成しました。実行前に以下を1回だけ実施してください：\n' +
      '  pip install playwright\n  python -m playwright install chromium\n' +
      '定期実行する場合は「⑥ 定期取得ファイルの出力」で run.bat / rename.py / send.py を作成してください。\n' +
      '実行例：run.bat（同じフォルダ内に input.csv を置いてください）'
    );

  });

  // ===== ⑥ URL収集：CSV読み込み（シード） =====
  qs('#btnCrawlLoadCsv')?.addEventListener('click', () => {
    const input = qs('#crawlSeedsCsv');
    if (!input?.files?.length) { setCrawlStatus('URL収集: CSVを選択してください'); return; }
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const skipFirst = !!(qs('#crawlCsvSkipHeader')?.checked);
      crawlerSeeds = parseCsvToUrls(String(reader.result || ''), skipFirst);
      setCrawlStatus(`URL収集: シードURL ${crawlerSeeds.length} 件を読み込みました`);
      // updateCrawlerUiState();
    };
    reader.onerror = () => setCrawlStatus('URL収集: CSVの読み込みに失敗しました');
    reader.readAsText(file, 'utf-8');
  });

  // // ===== ⑥ URL収集：開始 =====
  // qs('#btnCrawlRun')?.addEventListener('click', () => {
  //   if (!getLinkXPath()) { setCrawlStatus('URL収集: linkXPath（一覧の詳細リンクXPath）を入力してください'); return; }
  //   // 代表ページのアクティブタブID（seedXPathを評価するページ）
  //   withActiveHttpTab((tabId) => {
  //     const payload = {
  //       type: 'GS_URLCRAWL_RUN',
  //       seeds: crawlerSeeds,           // CSVからのシードURL配列（空でもOK）
  //       seedXPath: getSeedXPath(),     // 代表ページで評価する “シード用XPath”
  //       originTabId: tabId,            // 代表ページのタブID
  //       linkXPath: getLinkXPath(),     // （必須）一覧の各詳細リンクXPath
  //       nextXPath: getNextXPath(),     // （任意）次へXPath（未指定なら自動推測フォールバック）
  //       sameHostOnly: qs('#crawlSameHost')?.checked ?? true,
  //       // 任意の上限（該当入力が無ければデフォルト値でOK）
  //       maxPages: parseInt(qs('#crawlMaxPages')?.value || '50', 10),
  //       maxUrls:  parseInt(qs('#crawlMaxUrls')?.value  || '10000', 10),
  //       pageParamKeys: (qs('#crawlPageParamKeys')?.value || 'p'),
  //       // URL正規化（該当入力が無ければデフォルトtrue）
  //       stripHash: qs('#crawlStripHash')?.checked ?? true,
  //       stripQuery: qs('#crawlStripQuery')?.checked ?? true,
  //       stripTrailingSlash: qs('#crawlStripTrailing')?.checked ?? true,
  //       // フィルタ（該当入力が無ければ空文字でOK）
  //       allowPattern: (qs('#crawlAllow')?.value || ''),
  //       denyPattern:  (qs('#crawlDeny')?.value  || ''),
  //       pageParamKeys: getPageParamKeys(),
  //     };
  //     chrome.runtime.sendMessage(payload, (resp) => {
        
  //       if (chrome.runtime.lastError) {
  //         setCrawlStatus('URL収集開始エラー: ' + chrome.runtime.lastError.message);
  //         return;
  //       }
  //       if (!resp?.ok) {
  //         setCrawlStatus('URL収集開始エラー: ' + (resp?.error || 'unknown'));
  //         return;
  //       }
  //       setCrawlStatus('URL収集を開始しました…');
        
  //     });
      
  //   });
  // });

  // ⑥ URL収集：フォーム入力の変化で開始ボタン活性更新
  // [
  //   '#crawlSeedXPath', '#crawlLinkXPath', '#crawlNextXPath',
  //   '#crawlAllow', '#crawlDeny',
  //   '#crawlMaxPages', '#crawlMaxUrls',
  //   '#crawlSameHost', '#crawlStripHash', '#crawlStripQuery', '#crawlStripTrailing',
  //   '#crawlPageParamKeys'
  // ].forEach(sel => {
  //   const el = qs(sel);
  //   if (!el) return;
  //   el.addEventListener('input',  updateCrawlerUiState);
  //   el.addEventListener('change', updateCrawlerUiState);
  // });
  // updateCrawlerUiState();

  // 進捗表示（backgroundからの通知）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GS_WORKDIR_READY') {
    // ここで必ずUI更新（未選択/無効ボタンを即解消）
    updateWorkdirStatus({ name: msg.name, queryPermission: async()=> 'granted' });
    setWorkdirReadyFlag(true);
    setStatus('作業フォルダが設定されました');
    } else if (msg?.type === 'GS_WORKDIR_CLEARED') {
    updateWorkdirStatus(null);
    setWorkdirReadyFlag(false);
    setStatus('作業フォルダを解除しました');
    }
      if (msg?.type === 'GS_QUEUE_PROGRESS') {
      setQueueStatus(`進捗: ${msg.done}/${msg.total} 完了（現在: ${msg.currentUrl || '-' }）`);
    } else if (msg?.type === 'GS_QUEUE_DONE') {
      const t = (typeof msg.elapsedMs === 'number') ? ` 所要時間: ${fmtDuration(msg.elapsedMs)}` : '';
      setQueueStatus(`完了: ${msg.done}/${msg.total}（失敗: ${msg.failed || 0}）。自動保存（ダウンロード）が完了しました。${t}`);
    }
    
    // else if (msg?.type === 'GS_URLCRAWL_PROGRESS') {
    //   const p = msg;
    //   setCrawlStatus(`URL収集 進捗: 種 ${p.seedIndex + 1}/${p.seedTotal} / ページ ${p.pageCount} / URL ${p.urlCount}\n現在: ${p.currentPage || '-'}`);
    // } else if (msg?.type === 'GS_URLCRAWL_DONE') {
    //   const p = msg;
    //   setCrawlStatus(`URL収集 完了: 全${p.seedTotal}シード / 巡回ページ ${p.pageTotal} / 収集URL ${p.urlCount}`);
    // }
  });

});
