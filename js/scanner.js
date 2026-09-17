import { apiFetch, getMarkets, getCandles } from './market.js';
import { LatestTask, priceFormat, compact, escapeHtml as esc, readStorage, writeStorage, download, csv, symbolValid } from './core.js';
import { MetricCache, filterRows, heuristic } from './scanner-model.js';
import { initUI, toast, showDialog } from './ui.js';
initUI('scanner');
const $=id=>document.getElementById(id);
const columns=[['symbol','Market'],['price','Price'],['chg','24h %'],['chgAbs','24h change'],['high','24h high'],['low','24h low'],['range','Range %'],['vol','Quote volume'],['trades','Trades'],['r5','RSI 5m'],['r15','RSI 15m'],['r60','RSI 1h'],['spike','Volume ×'],['signal','Heuristic']];
const presets=['all','gainers','losers','volume','volatile','oversold','overbought','volspike'];
const saved=readStorage('chartpro-scanner',{},v=>v&&typeof v==='object');
const state={quote:['USDT','FDUSD','BTC'].includes(saved.quote)?saved.quote:'USDT',preset:presets.includes(saved.preset)?saved.preset:'all',search:typeof saved.search==='string'?saved.search.slice(0,24):'',minVolume:Number.isFinite(saved.minVolume)&&saved.minVolume>=0?saved.minVolume:0,sortKey:'chg',sortDir:-1,page:1,rows:[],columns:Array.isArray(saved.columns)?saved.columns.filter(k=>columns.some(([c])=>c===k)):columns.map(([k])=>k)};
if(!state.columns.includes('symbol'))state.columns.unshift('symbol');
const cache=new MetricCache(),refreshTask=new LatestTask(),scopeTask=new LatestTask();let scope=scopeTask.begin(),pumping=false,loading=false,markets=[],updated=0,renderTimer,paused=false;
const retryAfter=new Map();
function metrics(sym){const five=cache.get(sym,'5m'),fifteen=cache.get(sym,'15m'),hour=cache.get(sym,'1h');return five&&fifteen&&hour&&[five.rsi,fifteen.rsi,hour.rsi].every(Number.isFinite)?{r5:five.rsi,r15:fifteen.rsi,r60:hour.rsi,spike:five.spike}:null;}
function save(){writeStorage('chartpro-scanner',{quote:state.quote,preset:state.preset,search:state.search,minVolume:state.minVolume,columns:state.columns});}
function candidates(){return filterRows(state.rows,{...state,preset:'all'},metrics);}
function scheduleRender(){if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},180);}
async function refresh(){
  if(loading)return;loading=true;const task=refreshTask.begin(),quote=state.quote;
  try{
    if(!markets.length)markets=await getMarkets();
    const data=await apiFetch('/api/v3/ticker/24hr',{signal:task.signal});if(!task.current()||quote!==state.quote)return;
    if(!Array.isArray(data))throw new Error('Invalid market response');
    const known=new Map(markets.filter(m=>m.quoteAsset===quote).map(m=>[m.symbol,m]));
    state.rows=data.filter(t=>known.has(t.symbol)&&+t.quoteVolume>0&&Number.isFinite(+t.priceChangePercent)).map(t=>({symbol:t.symbol,base:known.get(t.symbol).baseAsset,price:+t.lastPrice,chg:+t.priceChangePercent,chgAbs:+t.priceChange,high:+t.highPrice,low:+t.lowPrice,range:+t.lowPrice>0?(+t.highPrice-+t.lowPrice)/+t.lowPrice*100:0,vol:+t.quoteVolume,trades:+t.count}));
    updated=Date.now();$('scanner-error').hidden=true;render();pump();
  }catch(error){if(task.current()){$('scanner-error').hidden=false;$('scanner-error').textContent=error.message+' Previously loaded rows, if any, may be stale.';}}
  finally{loading=false;}
}
async function pump(){
  if(pumping||paused||document.hidden)return;pumping=true;const token=scope;
  // Analyze the unfiltered universe (prioritize visible rows), so RSI filters cannot starve work.
  const queue=[...new Set([...filterRows(state.rows,state,metrics).slice((state.page-1)*50,state.page*50),...state.rows].map(r=>r.symbol))].filter(sym=>!metrics(sym)&&(retryAfter.get(sym)||0)<Date.now());
  async function worker(){while(queue.length&&token.current()&&!paused&&!document.hidden){const symbol=queue.shift();try{
    for(const tf of ['5m','15m','1h']){if(!token.current())return;if(cache.get(symbol,tf))continue;const candles=await getCandles(symbol,tf,{signal:token.signal,limit:120});if(!token.current())return;cache.set(symbol,tf,candles);}
    retryAfter.delete(symbol);
  }catch(error){if(!token.current())return;retryAfter.set(symbol,Date.now()+30000);$('scan-analysis-status').textContent=error.message;}
  scheduleRender();}}
  try{await Promise.all([worker(),worker()]);}finally{pumping=false;if(!token.current())pump();else scheduleRender();}
}
function pill(v){return v==null?'<span class="rsi-na">Pending</span>':`<span class="rsi-pill ${v>70?'rsi-ob':v<30?'rsi-os':'rsi-mid'}">${v.toFixed(1)}</span>`;}
function render(){
  const rows=filterRows(state.rows,state,metrics),pages=Math.max(1,Math.ceil(rows.length/50));state.page=Math.min(state.page,pages);
  const analyzed=state.rows.filter(r=>metrics(r.symbol)).length;
  $('sum-pairs').textContent=state.rows.length;$('sum-adv').textContent=state.rows.filter(r=>r.chg>0).length;$('sum-dec').textContent=state.rows.filter(r=>r.chg<0).length;
  const avg=state.rows.length?state.rows.reduce((s,r)=>s+r.chg,0)/state.rows.length:0;$('sum-avg').textContent=(avg>=0?'+':'')+avg.toFixed(2)+'%';$('sum-avg').className=avg>=0?'up':'down';$('sum-vol').textContent=compact(state.rows.reduce((s,r)=>s+r.vol,0))+' '+state.quote;
  $('scan-status').textContent=updated?`Tickers updated ${new Date(updated).toLocaleTimeString()}${Date.now()-updated>30000?' · stale':''}`:'Waiting for market data';
  $('scan-analysis-status').textContent=`${analyzed} / ${state.rows.length} markets analyzed · closed candles${paused?' · paused':pumping?' · calculating…':''}`;
  $('coverage-fill').style.width=(state.rows.length?analyzed/state.rows.length*100:0)+'%';
  $('scan-table').querySelector('thead tr').innerHTML=columns.map(([k,label])=>`<th ${state.columns.includes(k)?'':'hidden'} scope="col" aria-sort="${state.sortKey===k?(state.sortDir===1?'ascending':'descending'):'none'}">${k==='signal'?label:`<button type="button" data-sort="${k}">${label}${state.sortKey===k?(state.sortDir===1?' ↑':' ↓'):''}</button>`}</th>`).join('');
  $('scan-tbody').innerHTML=rows.slice((state.page-1)*50,state.page*50).map(r=>{
    const m=metrics(r.symbol),sig=heuristic(r,m),up=r.chg>=0?'up':'down';
    const cells=[`<a class="market-link" href="index.html?symbol=${r.symbol}&tf=1h"><span class="coin-avatar">${esc(r.base.slice(0,1))}</span><span><b>${esc(r.base)}</b><small> / ${state.quote}</small></span></a>`,priceFormat(r.price),`<span class="change-chip ${up}">${r.chg>=0?'+':''}${r.chg.toFixed(2)}%</span>`,priceFormat(r.chgAbs),priceFormat(r.high),priceFormat(r.low),r.range.toFixed(2)+'%',compact(r.vol),compact(r.trades),pill(m?.r5),pill(m?.r15),pill(m?.r60),m?.spike!=null?`<span class="${m.spike>=2?'vs-hot':'vs-cool'}">${m.spike.toFixed(2)}×</span>`:'Pending',`<span class="sig ${sig.className}" title="${esc(sig.description)}">${sig.label}</span>`];
    return `<tr data-sym="${r.symbol}">${cells.map((v,i)=>`<td ${i?'class="num"':''} ${state.columns.includes(columns[i][0])?'':'hidden'}>${v}</td>`).join('')}</tr>`;
  }).join('');
  $('scanner-empty').hidden=rows.length>0;$('scanner-empty').textContent=loading?'Loading markets…':analyzed<state.rows.length&&['oversold','overbought','volspike'].includes(state.preset)?'Calculating indicators across the market. Matches will appear as analysis completes.':'No markets match your filters. Try a different preset or volume threshold.';
  $('scan-page').textContent=`Page ${state.page} of ${pages} · ${rows.length} matches`;$('scan-prev').disabled=state.page<=1;$('scan-next').disabled=state.page>=pages;
  document.querySelectorAll('[data-quote]').forEach(b=>{b.classList.toggle('active',b.dataset.quote===state.quote);b.setAttribute('aria-pressed',String(b.dataset.quote===state.quote));});
  document.querySelectorAll('[data-preset]').forEach(b=>{b.classList.toggle('active',b.dataset.preset===state.preset);b.setAttribute('aria-pressed',String(b.dataset.preset===state.preset));});
}
$('scan-table').querySelector('thead').onclick=e=>{const b=e.target.closest('[data-sort]');if(!b)return;const key=b.dataset.sort;state.sortDir=state.sortKey===key?-state.sortDir:key==='symbol'?1:-1;state.sortKey=key;render();};
document.querySelectorAll('[data-quote]').forEach(b=>b.onclick=()=>{state.quote=b.dataset.quote;state.rows=[];state.page=1;scope=scopeTask.begin();refreshTask.cancel();loading=false;save();render();refresh();});
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{state.preset=b.dataset.preset;state.page=1;[state.sortKey,state.sortDir]=({gainers:['chg',-1],losers:['chg',1],volume:['vol',-1],volatile:['range',-1],oversold:['r60',1],overbought:['r60',-1],volspike:['spike',-1]})[state.preset]||['chg',-1];save();render();pump();});
$('scan-search-input').value=state.search;$('scan-search-input').oninput=e=>{state.search=e.target.value.trim().toUpperCase().slice(0,24);state.page=1;save();render();};
$('scan-min-volume').value=state.minVolume;$('scan-min-volume').oninput=e=>{state.minVolume=Math.max(0,Number(e.target.value)||0);state.page=1;save();render();};
$('scan-prev').onclick=()=>{state.page--;render();};$('scan-next').onclick=()=>{state.page++;render();pump();};
$('scan-refresh').onclick=()=>{retryAfter.clear();refresh();pump();};
$('scan-pause').onclick=()=>{paused=!paused;$('scan-pause').textContent=paused?'Resume':'Pause';render();if(!paused){refresh();pump();}};
$('scan-export').onclick=()=>download(`chartpro_scanner_${state.quote}.csv`,csv([columns.map(([,label])=>label),...filterRows(state.rows,state,metrics).map(r=>{const m=metrics(r.symbol);return columns.map(([key])=>key==='signal'?heuristic(r,m).label:key in r?r[key]:m?.[key]);})]),'text/csv');
$('scan-columns').onclick=()=>showDialog('Scanner columns',`<div class="column-choices">${columns.filter(([k])=>k!=='symbol').map(([k,label])=>`<label class="check-field"><input type="checkbox" name="${k}" ${state.columns.includes(k)?'checked':''}> ${label}</label>`).join('')}</div>`,form=>{state.columns=['symbol',...columns.filter(([k])=>form.has(k)).map(([k])=>k)];save();render();});
$('scan-save').onclick=()=>{save();toast('Scanner filters and columns saved to this browser.','success');};
$('scan-reset').onclick=()=>{state.search='';state.minVolume=0;state.preset='all';state.page=1;$('scan-search-input').value='';$('scan-min-volume').value='0';save();render();pump();};
setInterval(()=>{if(!paused&&!document.hidden){refresh();pump();}},10000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!paused){refresh();pump();}});
window.addEventListener('pagehide',()=>{refreshTask.cancel();scopeTask.cancel();});
window.addEventListener('pageshow',e=>{if(e.persisted){scope=scopeTask.begin();refresh();pump();}});
render();refresh();
