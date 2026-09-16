/* ============ ChartPro Market Scanner ============
   Live screener over all Binance spot pairs for a chosen quote asset.
   - 24h ticker table, auto-refresh every 10s
   - Preset filters (gainers, losers, volume, volatility, RSI extremes)
   - RSI(14) on 1h candles computed lazily for visible rows
   - Composite signal from 24h momentum + RSI
   - Click row -> opens chart page with ?symbol= */

(() => {
  'use strict';

  const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
  let restIdx = 0;

  async function apiFetch(path) {
    for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
      try {
        const res = await fetch(REST_HOSTS[restIdx] + path);
        if (res.ok) return res.json();
        throw new Error('HTTP ' + res.status);
      } catch (err) {
        if (attempt === REST_HOSTS.length - 1) throw err;
        restIdx = (restIdx + 1) % REST_HOSTS.length;
      }
    }
  }

  const state = {
    quote: 'USDT',
    preset: 'all',
    search: '',
    sortKey: 'chg',
    sortDir: -1,
    rows: [],          // enriched ticker rows
    rsi: {},           // symbol -> { r5, r15, r60, vspike } | 'loading'
    validSymbols: null,
  };

  const tbody = document.getElementById('scan-tbody');

  // Leveraged-token suffixes to exclude
  const EXCLUDE = /(UP|DOWN|BULL|BEAR)$/;

  async function loadValidSymbols() {
    try {
      const d = await apiFetch('/api/v3/exchangeInfo?permissions=SPOT');
      state.validSymbols = new Set(
        d.symbols.filter(s => s.status === 'TRADING').map(s => s.symbol)
      );
    } catch (e) { state.validSymbols = null; /* fall back to no filtering */ }
  }

  async function refresh() {
    try {
      const all = await apiFetch('/api/v3/ticker/24hr');
      const q = state.quote;
      state.rows = all
        .filter(t => t.symbol.endsWith(q) &&
          (!state.validSymbols || state.validSymbols.has(t.symbol)) &&
          !EXCLUDE.test(t.symbol.slice(0, -q.length)) &&
          +t.quoteVolume > 0)
        .map(t => {
          const price = +t.lastPrice, high = +t.highPrice, low = +t.lowPrice;
          return {
            symbol: t.symbol,
            base: t.symbol.slice(0, -q.length),
            price,
            chg: +t.priceChangePercent,
            chgAbs: +t.priceChange,
            high, low,
            range: low > 0 ? (high - low) / low * 100 : 0,
            vol: +t.quoteVolume,
            trades: +t.count,
          };
        });
      document.getElementById('scan-status').textContent =
        'Updated ' + new Date().toLocaleTimeString();
      render();
    } catch (e) {
      document.getElementById('scan-status').textContent = 'Data error — retrying…';
    }
  }

  function filteredRows() {
    let rows = state.rows;
    if (state.search) {
      const s = state.search.toUpperCase();
      rows = rows.filter(r => r.base.includes(s));
    }
    switch (state.preset) {
      case 'gainers': rows = rows.filter(r => r.chg > 0); break;
      case 'losers': rows = rows.filter(r => r.chg < 0); break;
      case 'volume': break; // sort handles it
      case 'volatile': rows = rows.filter(r => r.range > 5); break;
      case 'oversold': rows = rows.filter(r => rsiOf(r.symbol, 'r60') != null && rsiOf(r.symbol, 'r60') < 30); break;
      case 'overbought': rows = rows.filter(r => rsiOf(r.symbol, 'r60') != null && rsiOf(r.symbol, 'r60') > 70); break;
      case 'volspike': rows = rows.filter(r => rsiOf(r.symbol, 'vspike') != null && rsiOf(r.symbol, 'vspike') >= 2); break;
    }
    const k = state.sortKey, dir = state.sortDir;
    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (k === 'symbol') { av = a.base; bv = b.base; return dir * av.localeCompare(bv); }
      const rsiKeys = { rsi: 'r60', rsi5: 'r5', rsi15: 'r15', vspike: 'vspike' };
      if (rsiKeys[k]) {
        av = rsiOf(a.symbol, rsiKeys[k]) ?? -1;
        bv = rsiOf(b.symbol, rsiKeys[k]) ?? -1;
      } else { av = a[k]; bv = b[k]; }
      return dir * (av - bv);
    });
    return rows.slice(0, 150);
  }

  function rsiOf(sym, key) {
    const v = state.rsi[sym];
    return (v && typeof v === 'object' && typeof v[key] === 'number' && !isNaN(v[key])) ? v[key] : null;
  }

  function signal(r) {
    const rsi = rsiOf(r.symbol, 'r60');
    const r15 = rsiOf(r.symbol, 'r15');
    const vs = rsiOf(r.symbol, 'vspike');
    let score = 0;
    if (r.chg > 5) score += 2; else if (r.chg > 1) score += 1;
    else if (r.chg < -5) score -= 2; else if (r.chg < -1) score -= 1;
    if (rsi != null) {
      if (rsi < 30) score += 2; else if (rsi < 42) score += 1;
      else if (rsi > 70) score -= 2; else if (rsi > 58) score -= 1;
    }
    if (r15 != null) {
      if (r15 < 25) score += 1;
      else if (r15 > 75) score -= 1;
    }
    if (vs != null && vs >= 2) score += (r.chg >= 0 ? 1 : -1); // volume confirms direction
    if (score >= 3) return ['STRONG BUY', 'sig-strongbuy'];
    if (score >= 1) return ['BUY', 'sig-buy'];
    if (score <= -3) return ['STRONG SELL', 'sig-strongsell'];
    if (score <= -1) return ['SELL', 'sig-sell'];
    return ['NEUTRAL', 'sig-neutral'];
  }

  function render() {
    const rows = filteredRows();
    // summary
    const adv = state.rows.filter(r => r.chg > 0).length;
    const dec = state.rows.filter(r => r.chg < 0).length;
    const avg = state.rows.length ? state.rows.reduce((s, r) => s + r.chg, 0) / state.rows.length : 0;
    const tvol = state.rows.reduce((s, r) => s + r.vol, 0);
    document.getElementById('sum-pairs').textContent = state.rows.length;
    document.getElementById('sum-adv').textContent = adv;
    document.getElementById('sum-dec').textContent = dec;
    const avgEl = document.getElementById('sum-avg');
    avgEl.textContent = (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%';
    avgEl.className = avg >= 0 ? 'up' : 'down';
    document.getElementById('sum-vol').textContent = fmtCompact(tvol);

    // table
    const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.chg)));
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.sym = r.symbol;
      const upCls = r.chg >= 0 ? 'up' : 'down';
      const barW = Math.min(100, Math.abs(r.chg) / maxAbs * 100);
      const [sigTxt, sigCls] = signal(r);
      tr.innerHTML = `
        <td class="sym-cell">${r.base}<span class="quote">/${state.quote}</span></td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="num chg-cell">
          <span class="chg-bar" style="width:${barW}%;background:${r.chg >= 0 ? '#26a69a' : '#ef5350'}"></span>
          <span class="chg-val ${upCls}">${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(2)}%</span>
        </td>
        <td class="num hide-sm ${upCls}">${r.chgAbs >= 0 ? '+' : ''}${fmtPrice(Math.abs(r.chgAbs))}</td>
        <td class="num hide-sm">${fmtPrice(r.high)}</td>
        <td class="num hide-sm">${fmtPrice(r.low)}</td>
        <td class="num hide-sm">${r.range.toFixed(2)}%</td>
        <td class="num hide-xs">${fmtCompact(r.vol)}</td>
        <td class="num hide-sm">${fmtCompact(r.trades)}</td>
        <td class="num hide-sm">${rsiPill(r.symbol, 'r5')}</td>
        <td class="num hide-sm">${rsiPill(r.symbol, 'r15')}</td>
        <td class="num">${rsiPill(r.symbol, 'r60')}</td>
        <td class="num hide-xs">${vspikeCell(r.symbol)}</td>
        <td class="num"><span class="sig ${sigCls}">${sigTxt}</span></td>`;
      tr.addEventListener('click', () => {
        location.href = `index.html?symbol=${r.symbol}&tf=1h`;
      });
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    queueRsi(rows);
  }

  function rsiPill(sym, key) {
    const v = rsiOf(sym, key);
    if (v == null) return '<span class="rsi-na">…</span>';
    const cls = v > 70 ? 'rsi-ob' : v < 30 ? 'rsi-os' : 'rsi-mid';
    return `<span class="rsi-pill ${cls}">${v.toFixed(1)}</span>`;
  }
  function vspikeCell(sym) {
    const v = rsiOf(sym, 'vspike');
    if (v == null) return '<span class="rsi-na">…</span>';
    const hot = v >= 2;
    return `<span class="${hot ? 'vs-hot' : 'vs-cool'}">${v.toFixed(1)}×</span>`;
  }

  // ---- Lazy multi-TF RSI + volume-spike, small batches for rate limits ----
  let rsiQueue = [];
  let rsiBusy = false;

  function queueRsi(rows) {
    for (const r of rows.slice(0, 50)) {
      if (state.rsi[r.symbol] === undefined) {
        state.rsi[r.symbol] = 'loading';
        rsiQueue.push(r.symbol);
      }
    }
    pumpRsi();
  }

  async function pumpRsi() {
    if (rsiBusy) return;
    rsiBusy = true;
    while (rsiQueue.length) {
      const batch = rsiQueue.splice(0, 3);
      await Promise.all(batch.map(async sym => {
        try {
          const [k5, k15, k60] = await Promise.all([
            apiFetch(`/api/v3/klines?symbol=${sym}&interval=5m&limit=60`),
            apiFetch(`/api/v3/klines?symbol=${sym}&interval=15m&limit=60`),
            apiFetch(`/api/v3/klines?symbol=${sym}&interval=1h&limit=60`),
          ]);
          const closes = k => k.map(x => +x[4]);
          // volume spike: last CLOSED 5m volume vs 20-bar average before it
          const vols = k5.map(x => +x[5]);
          let vspike = NaN;
          if (vols.length >= 23) {
            const lastClosed = vols[vols.length - 2];
            const prior = vols.slice(vols.length - 22, vols.length - 2);
            const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
            vspike = avg > 0 ? lastClosed / avg : NaN;
          }
          state.rsi[sym] = {
            r5: calcRsi(closes(k5), 14),
            r15: calcRsi(closes(k15), 14),
            r60: calcRsi(closes(k60), 14),
            vspike,
          };
        } catch (e) {
          delete state.rsi[sym]; // retry next refresh
        }
      }));
      updateRsiCells(batch);
      await new Promise(r => setTimeout(r, 450));
    }
    rsiBusy = false;
  }

  function updateRsiCells(symbols) {
    for (const sym of symbols) {
      const tr = tbody.querySelector(`tr[data-sym="${sym}"]`);
      if (!tr || !state.rsi[sym] || state.rsi[sym] === 'loading') continue;
      // cells: 9=rsi5, 10=rsi15, 11=rsi1h, 12=vspike, 13=signal
      if (tr.cells[9]) tr.cells[9].innerHTML = rsiPill(sym, 'r5');
      if (tr.cells[10]) tr.cells[10].innerHTML = rsiPill(sym, 'r15');
      if (tr.cells[11]) tr.cells[11].innerHTML = rsiPill(sym, 'r60');
      if (tr.cells[12]) tr.cells[12].innerHTML = vspikeCell(sym);
      const r = state.rows.find(x => x.symbol === sym);
      if (r && tr.cells[13]) {
        const [sigTxt, sigCls] = signal(r);
        tr.cells[13].innerHTML = `<span class="sig ${sigCls}">${sigTxt}</span>`;
      }
    }
  }

  function calcRsi(closes, period) {
    if (closes.length <= period) return NaN;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
      l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  // ---- UI wiring ----
  document.querySelectorAll('#quote-filter .tf-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('#quote-filter .tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.quote = btn.dataset.quote;
      state.rsi = {};
      rsiQueue = [];
      refresh();
    }));

  document.querySelectorAll('#preset-filter .preset').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('#preset-filter .preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.preset = btn.dataset.preset;
      // sensible default sorts per preset
      const presetSort = {
        gainers: ['chg', -1], losers: ['chg', 1], volume: ['vol', -1],
        volatile: ['range', -1], oversold: ['rsi', 1], overbought: ['rsi', -1],
        volspike: ['vspike', -1], all: ['chg', -1],
      };
      [state.sortKey, state.sortDir] = presetSort[state.preset] || ['chg', -1];
      markSortHeader();
      render();
    }));

  document.getElementById('scan-search-input').addEventListener('input', e => {
    state.search = e.target.value.trim();
    render();
  });

  document.querySelectorAll('#scan-table th.sortable').forEach(th =>
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = k === 'symbol' ? 1 : -1; }
      markSortHeader();
      render();
    }));

  function markSortHeader() {
    document.querySelectorAll('#scan-table th').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === state.sortKey) {
        th.classList.add(state.sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      }
    });
  }

  // ---- Formatting ----
  function fmtPrice(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(4);
    return v.toPrecision(4);
  }
  function fmtCompact(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return (+v).toFixed(0);
  }

  // ---- Init ----
  (async () => {
    await loadValidSymbols();
    await refresh();
    setInterval(refresh, 10000);
  })();
})();
