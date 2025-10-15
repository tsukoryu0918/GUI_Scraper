// 同じ DB/STORE 名で保存（popup.js と揃える）
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

const st = document.getElementById('status');
function setStatus(t){ st.textContent = t || ''; }

document.getElementById('pick')?.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker();
    // ここで権限を確実に取る（ユーザー操作内）
    let perm = await dirHandle.queryPermission?.({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await dirHandle.requestPermission?.({ mode: 'readwrite' });

    // 簡単な書き込みプローブ
    try {
      const fh = await dirHandle.getFileHandle('.gs_probe.txt', { create: true });
      const w = await fh.createWritable(); await w.write('ok'); await w.close();
      await dirHandle.removeEntry('.gs_probe.txt');
    } catch (_) {}

    await idbSet('workdir', dirHandle);
    setStatus(`選択: ${dirHandle.name}（perm: ${perm}）`);
  } catch (e) {
    setStatus('キャンセル/失敗しました');
  }
});

document.getElementById('clear')?.addEventListener('click', async () => {
  await idbDel('workdir');
  setStatus('未選択');
});

// 起動時、復元＆表示
(async () => {
  try {
    const dirHandle = await idbGet('workdir');
    if (!dirHandle) return setStatus('未選択');
    let perm = await dirHandle.queryPermission?.({ mode: 'readwrite' });
    setStatus(`選択: ${dirHandle.name}（perm: ${perm}）`);
  } catch {
    setStatus('未選択');
  }
})();
