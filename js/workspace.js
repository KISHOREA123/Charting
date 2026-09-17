import { escapeHtml as esc, download, csv, readStorage, writeStorage, symbolValid, INTERVALS, drawingsValid, alertsValid } from './core.js';
import { showDialog, toast } from './ui.js';
import { openComparison } from './comparison.js';
export const PARAMETERS = {
  sma20: [20], sma50: [50], sma200: [200], ema20: [20], ema50: [50], ema200: [200], wma20: [20],
  bb: [20, 2], keltner: [20, 2], donchian: [20], ichimoku: [9, 26, 52, 26], psar: [.02, .2], supertrend: [10, 3],
  rsi: [14], macd: [12, 26, 9], stoch: [14, 3, 3], stochrsi: [14, 14, 3, 3], atr: [14], adx: [14], cci: [20], mfi: [14], willr: [14],
};
const LABELS = { bb: ['Period', 'Deviation multiplier'], keltner: ['Period', 'ATR multiplier'], supertrend: ['ATR period', 'Multiplier'], ichimoku: ['Conversion', 'Base', 'Span B', 'Displacement'], psar: ['Acceleration', 'Maximum acceleration'], macd: ['Fast', 'Slow', 'Signal'], stoch: ['Lookback', 'K smoothing', 'D smoothing'], stochrsi: ['RSI period', 'Stochastic period', 'K smoothing', 'D smoothing'] };
export function validParameters(key, values) {
  return Object.hasOwn(PARAMETERS,key) && Array.isArray(values) && values.length === PARAMETERS[key].length && values.every((v,i) => Number.isFinite(v) && v > 0 && v <= 500 && ((key === 'psar' && v <= 1) || (['bb','keltner','supertrend'].includes(key) && i === 1) || Number.isInteger(v))) && (key !== 'macd' || values[0] < values[1]) && (key !== 'psar' || values[0] <= values[1]);
}
export function initWorkspace(app) {
  const {state} = app;
  const bind = (id,fn) => { document.getElementById(id).onclick = fn; };
  const moveHistory = redo => { state.drawings = redo ? app.history.redo() : app.history.undo(); state.selectedIdx = -1; app.saveDrawings(false); app.selectTool('cursor'); };
  bind('undo-drawing', () => moveHistory(false)); bind('redo-drawing', () => moveHistory(true));
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select,dialog,.modal,[contenteditable]') || !(e.ctrlKey || e.metaKey)) return;
    if (['z','y'].includes(e.key.toLowerCase())) { e.preventDefault(); moveHistory(e.shiftKey || e.key.toLowerCase() === 'y'); }
  });
  document.querySelectorAll('input[data-ind]').forEach(cb => {
    const key = cb.dataset.ind, button = document.createElement('button');
    button.type = 'button'; button.className = 'indicator-gear'; button.setAttribute('aria-label',`Configure ${key.toUpperCase()}`); button.innerHTML = '<i class="fa-solid fa-sliders"></i>'; cb.closest('label').append(button);
    button.onclick = e => {
      e.preventDefault(); e.stopPropagation(); const values = state.params[key] || PARAMETERS[key] || [], labels = LABELS[key] || ['Period'];
      showDialog(`${key.toUpperCase()} settings`, `<p class="muted">Saved locally. Your color applies to the first series.</p>${values.map((v,i) => `<label class="field">${labels[i] || 'Period'}<input name="p${i}" type="number" min="${key === 'psar' ? '.001' : '1'}" max="${key === 'psar' ? '1' : '500'}" step="${key === 'psar' || i === 1 && ['bb','keltner','supertrend'].includes(key) ? 'any' : '1'}" value="${v}" required></label>`).join('')}<label class="field">Primary color<input name="color" type="color" value="${esc(state.colors[key] || '#5b8cff')}"></label><label class="check-field"><input name="enabled" type="checkbox" ${state.indicators[key] ? 'checked' : ''}> Show indicator</label>`, form => {
        const next = values.map((_,i) => Number(form.get(`p${i}`)));
        if (values.length && !validParameters(key,next)) throw new Error('Invalid parameters. Use periods 1–500; MACD fast must be smaller than slow.');
        if (values.length) state.params[key] = next;
        state.colors[key] = String(form.get('color')); state.indicators[key] = form.has('enabled'); cb.checked = state.indicators[key]; app.refresh(); app.save(); toast('Indicator settings saved.','success');
      });
    };
  });
  bind('workspace-settings', () => showDialog('Workspace settings', `<p class="muted">SMC uses confirmed candles only. Pivots appear after the confirmation window.</p><label class="field">Swing confirmation bars<input name="swing" type="number" min="2" max="50" value="${state.smcOptions.swingLen}" required></label><label class="field">Minimum fair value gap (%)<input name="gap" type="number" min="0" max="10" step=".01" value="${state.smcOptions.fvgMinPct}" required></label><label class="field">VWAP anchor<select name="vwap"><option value="session" ${state.vwapAnchor === 'session' ? 'selected' : ''}>UTC trading day</option><option value="loaded" ${state.vwapAnchor === 'loaded' ? 'selected' : ''}>Start of loaded history</option></select></label><p class="help-note">Volume profile approximates loaded candles. CVD and loaded-history VWAP reset when their history window changes. Sessions follow local market time and daylight saving.</p>`, form => {
    const swingLen = Number(form.get('swing')), fvgMinPct = Number(form.get('gap'));
    if (!Number.isInteger(swingLen) || swingLen < 2 || swingLen > 50 || !Number.isFinite(fvgMinPct) || fvgMinPct < 0 || fvgMinPct > 10) throw new Error('Invalid analysis settings.');
    state.smcOptions = {swingLen,fvgMinPct}; state.vwapAnchor = String(form.get('vwap')); app.save(); app.refresh(); app.smc(); toast('Workspace settings saved.','success');
  }));
  bind('export-chart', () => {
    if (!state.loaded) return toast('Load a market before taking a snapshot.','error');
    app.paint(); const shot = app.chart.takeScreenshot(), output = document.createElement('canvas'); output.width = shot.width; output.height = shot.height + 48;
    const ctx = output.getContext('2d'); ctx.fillStyle = '#131722'; ctx.fillRect(0,0,output.width,output.height); ctx.drawImage(shot,0,48);
    const ratio = shot.width / document.getElementById('main-chart').clientWidth; ctx.drawImage(app.overlay,0,48,shot.width,app.overlay.clientHeight * ratio);
    ctx.fillStyle = '#e3eaf8'; ctx.font = '600 16px sans-serif'; ctx.fillText(`ChartPro / ${state.symbol} / ${state.interval} / ${new Date().toISOString()}`,16,29);
    output.toBlob(blob => { if (blob) download(`${state.symbol}_${state.interval}_chart.png`,blob,'image/png'); });
  });
  const settings = () => ({version:2,symbol:state.symbol,interval:state.interval,chartType:state.chartType,indicators:state.indicators,params:state.params,colors:state.colors,smc:state.smc,smcOptions:state.smcOptions,intraday:state.intraday,vwapAnchor:state.vwapAnchor,toolStyle:state.toolStyle});
  const checkSettings = v => {
    if (!v || !symbolValid(v.symbol) || !Object.hasOwn(INTERVALS,v.interval) || v.params && Object.entries(v.params).some(([k,p]) => !validParameters(k,p))) throw new Error('Invalid workspace settings.');
  };
  const applySettings = value => {
    checkSettings(value); if (!writeStorage('chartpro-settings',value)) throw new Error('Could not save workspace.');
    const url = new URL(location.href); url.search = new URLSearchParams({symbol:value.symbol,tf:value.interval}); location.assign(url);
  };
  bind('workspace-more', () => {
    const actions = [['fit','Fit chart to history','expand'],['compare','Compare another market','table-columns'],['star','Add / remove market in watchlist','star'],['lock','Lock / unlock all drawings','lock'],['csv','Export candles (CSV)','file-csv'],['backup','Export workspace backup','download'],['restore','Restore workspace backup','upload'],['preset','Save layout preset','floppy-disk'],['load','Load layout preset','folder-open'],['journal','Log a trade for this market','book'],['copy','Copy market link','link']];
    showDialog('Your workspace',`<div class="action-grid">${actions.map(([id,label,icon]) => `<button type="button" class="action-card" data-action="${id}"><i class="fa-solid fa-${icon}"></i>${label}</button>`).join('')}</div><p class="help-note">Backups include this market’s drawings, all local alerts, watchlist and settings. Export the journal separately. Files stay on your device.</p>`,null,{submit:'Done'});
    document.querySelectorAll('[data-action]').forEach(b => b.onclick = async () => {
      b.closest('dialog').close(); const action = b.dataset.action;
      if (action === 'fit') app.chart.timeScale().fitContent();
      if (action === 'compare') showDialog('Compare a market','<label class="field">Spot symbol<input name="symbol" value="ETHUSDT" required maxlength="24"></label><p class="help-note">Independent live feed using the current timeframe.</p>',form => { const sym = String(form.get('symbol')).trim().toUpperCase(); if (!symbolValid(sym)) throw new Error('Enter a valid symbol.'); openComparison(sym,state.interval); });
      if (action === 'star') app.toggleWatch();
      if (action === 'lock') { const locked = !state.drawings.every(d => d.locked); state.drawings.forEach(d => {d.locked=locked;}); state.selectedIdx=-1; app.saveDrawings(); app.selectTool('cursor'); toast(locked?'Drawings locked.':'Drawings unlocked.'); }
      if (action === 'csv') download(`${state.symbol}_${state.interval}.csv`,csv([['time_utc','open','high','low','close','volume','taker_buy_volume'],...state.candles.map(c => [new Date(c.time*1000).toISOString(),c.open,c.high,c.low,c.close,c.volume,c.tb])]),'text/csv');
      if (action === 'backup') download(`chartpro_workspace_${state.symbol}.json`,JSON.stringify({app:'chartpro',version:2,settings:settings(),drawings:state.drawings,alerts:app.alerts(),watchlist:app.watchlist},null,2));
      if (action === 'restore') {
        const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
        input.onchange=async()=>{try {
          const file=input.files[0];if (!file || file.size>5e6) throw new Error('Choose a JSON backup under 5 MB.');
          const data=JSON.parse(await file.text());checkSettings(data.settings);
          if(data.app!=='chartpro'||data.version!==2||!drawingsValid(data.drawings)||!alertsValid(data.alerts)) throw new Error('Invalid workspace backup.');
          if(!Array.isArray(data.watchlist)||data.watchlist.length>40||!data.watchlist.every(x=>Array.isArray(x)&&symbolValid(x[0])&&typeof x[1]==='string')) throw new Error('Invalid watchlist.');
          showDialog('Restore workspace?',`<p>This replaces settings, alerts, watchlist and drawings for ${esc(data.settings.symbol)}. Export a backup first.</p>`,()=>{
            if(!writeStorage(`chartpro-drawings-${data.settings.symbol}`,data.drawings)||!writeStorage('chartpro-alerts',data.alerts)||!writeStorage('chartpro-watchlist',data.watchlist)) throw new Error('Restore could not finish: storage unavailable.');applySettings(data.settings);
          },{submit:'Restore'});
        }catch(error){toast(error.message,'error');}};input.click();
      }
      if(action==='preset') showDialog('Save layout preset','<label class="field">Preset name<input name="name" maxlength="40" placeholder="Intraday momentum" required></label>',form=>{
        const name=String(form.get('name')).trim();if(!name)throw new Error('Enter a name.');const presets=readStorage('chartpro-presets',[],Array.isArray);if(!writeStorage('chartpro-presets',[...presets.filter(p=>p.name!==name),{name,settings:settings()}].slice(-12)))throw new Error('Could not save preset.');toast('Preset saved.','success');
      });
      if(action==='load'){const presets=readStorage('chartpro-presets',[],Array.isArray);if(!presets.length)return toast('Save a layout preset first.');showDialog('Load layout preset',`<label class="field">Preset<select name="index">${presets.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label>`,form=>applySettings(presets[Number(form.get('index'))].settings));}
      if(action==='journal')location.href=`journal.html?symbol=${state.symbol}&entry=${state.candles.at(-1)?.close||''}`;
      if(action==='copy'){try{const url=new URL(location.href);url.search=new URLSearchParams({symbol:state.symbol,tf:state.interval});await navigator.clipboard.writeText(url.href);toast('Market link copied.','success');}catch{toast('Copy the address bar URL; clipboard unavailable.');}}
    });
  });
}
