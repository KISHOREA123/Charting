import { validateTrade } from './trades.js';
let connection;
export function openJournal() {
  if (!connection) connection = new Promise((resolve,reject) => {
    const request = indexedDB.open('chartpro-journal',2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('trades')) request.result.createObjectStore('trades',{keyPath:'id'}); };
    request.onerror = () => reject(new Error('Local database unavailable. Enable browser storage and retry.'));
    request.onblocked = () => reject(new Error('Database upgrade blocked. Close other ChartPro tabs and retry.'));
    request.onsuccess = () => { request.result.onversionchange = () => {request.result.close();connection=null;}; resolve(request.result); };
  }).catch(error => {connection=null;throw error;});
  return connection;
}
export async function listTrades() {
  const db = await openJournal();
  return new Promise((resolve,reject) => { const request = db.transaction('trades','readonly').objectStore('trades').getAll(); request.onsuccess=()=>{try{resolve(request.result.map(validateTrade));}catch(e){reject(new Error('Stored data failed validation: '+e.message));}};request.onerror=()=>reject(request.error); });
}
export async function saveTrade(input, expectedRevision = null) {
  const trade=validateTrade(input), db=await openJournal();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('trades','readwrite'),store=tx.objectStore('trades');let conflict=false;
    const existing=store.get(trade.id);
    existing.onsuccess=()=>{const old=existing.result;if(expectedRevision!=null&&(!old||old.revision!==expectedRevision)||expectedRevision==null&&old){conflict=true;tx.abort();return;}trade.revision=(old?.revision||0)+1;store.put(trade);};
    tx.oncomplete=()=>resolve(trade);tx.onabort=()=>reject(new Error(conflict?'This trade changed in another tab. Reload before editing.':'Save failed. Your form has not been cleared.'));tx.onerror=()=>{};
  });
}
export async function deleteTrade(id, revision) {
  const db=await openJournal();return new Promise((resolve,reject)=>{const tx=db.transaction('trades','readwrite'),store=tx.objectStore('trades'),get=store.get(id);get.onsuccess=()=>{if(get.result?.revision!==revision){tx.abort();return;}store.delete(id);};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(new Error('Delete failed or record changed. Reload and retry.'));tx.onerror=()=>{};});
}
export async function mergeTrades(records) {
  const valid=records.map(validateTrade),db=await openJournal();
  return new Promise((resolve,reject)=>{const tx=db.transaction('trades','readwrite'),store=tx.objectStore('trades');let added=0;for(const t of valid){const get=store.get(t.id);get.onsuccess=()=>{if(!get.result){store.add({...t,revision:1});added++;}};}tx.oncomplete=()=>resolve(added);tx.onabort=()=>reject(new Error('Import failed. No records were imported.'));tx.onerror=()=>{};});
}
