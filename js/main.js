import * as LWC from 'lightweight-charts';
import { Indicators } from './indicators.js';
import { SMC } from './smc.js';
import { INTERVALS, LatestTask, History, symbolValid, positive, candleValid, mergeCandles, drawingsValid, alertsValid, readStorage, writeStorage, escapeHtml, assetInfo, precisionFor, priceFormat, compact, download, csv } from './core.js';
import { apiFetch, getMarkets, getCandles, MarketStream } from './market.js';
import { initUI, toast, showDialog } from './ui.js';
/* ============ ChartPro — main application ============
   Data: Binance public REST + WebSocket (no API key, CORS enabled)
   Charts: TradingView Lightweight Charts v4
   Features: 4 chart types, 21 indicators, 9 drawing tools with
   select/drag/delete + localStorage persistence. */

(() => {
  'use strict';
  initUI('chart');

  // ---------- State ----------
  const state = {
    symbol: 'BTCUSDT',
    interval: '4h',
    chartType: 'candles',
    candles: [],            // { time, open, high, low, close, volume }
    indicators: {},         // key -> true
    smc: {},                // SMC annotation toggles
    intraday: { countdown: true },  // intraday tool toggles (countdown on by default)
    toolStyle: { color: '#2962ff', width: 1.5, style: 'solid' },
    ws: null,
    wlWs: null,
    drawTool: 'cursor',
    drawings: [],           // shape objects (see drawing engine)
    pendingPoints: [],      // clicks collected for current tool
    hoverPoint: null,
    selectedIdx: -1,
    magnet: false,
    params: {}, colors: {}, smcOptions: { swingLen: 5, fvgMinPct: 0.05 }, vwapAnchor: 'session',
    market: assetInfo('BTCUSDT'), loaded: false,
  };

  const DEFAULT_WATCHLIST = [
    ['BTCUSDT', 'Bitcoin'], ['ETHUSDT', 'Ethereum'], ['BNBUSDT', 'BNB'],
    ['SOLUSDT', 'Solana'], ['XRPUSDT', 'XRP'], ['ADAUSDT', 'Cardano'],
    ['DOGEUSDT', 'Dogecoin'], ['AVAXUSDT', 'Avalanche'], ['DOTUSDT', 'Polkadot'],
    ['LINKUSDT', 'Chainlink'], ['LTCUSDT', 'Litecoin'], ['TONUSDT', 'Toncoin'],
  ];

  const WATCHLIST = readStorage('chartpro-watchlist', DEFAULT_WATCHLIST, v => Array.isArray(v) && v.length <= 40 && v.every(x => Array.isArray(x) && symbolValid(x[0]) && typeof x[1] === 'string'));
  const selection = new LatestTask(), statsTask = new LatestTask(), levelsTask = new LatestTask();
  let activeSelection, dataVersion = 0, lastMarketEvent = 0;
  function invalidate() { dataVersion++; }

  // ---------- Chart setup ----------
  const chartOpts = {
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc', fontFamily: 'Inter, system-ui, sans-serif', attributionLogo: true, panes: { separatorColor: '#303c50', separatorHoverColor: '#5b8cff', enableResize: true } },
    grid: { vertLines: { color: 'rgba(42,46,57,0.5)' }, horzLines: { color: 'rgba(42,46,57,0.5)' } },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#2a2e39', minimumWidth: 82 },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
  };

  const mainEl = document.getElementById('main-chart');
  const chart = LWC.createChart(mainEl, chartOpts);

  let priceSeries = null;
  const volumeSeries = chart.addSeries(LWC.HistogramSeries, {
    priceScaleId: 'vol',
    priceFormat: { type: 'volume' },
    lastValueVisible: false, priceLineVisible: false,
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  const overlaySeries = {}; // indicator key -> [series,...]

  function createPriceSeries() {
    if (priceSeries) chart.removeSeries(priceSeries);
    const t = state.chartType;
    if (t === 'candles') {
      priceSeries = chart.addSeries(LWC.CandlestickSeries, {
        upColor: '#26a69a', downColor: '#ef5350',
        wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        borderVisible: false,
      });
    } else if (t === 'bars') {
      priceSeries = chart.addSeries(LWC.BarSeries, { upColor: '#26a69a', downColor: '#ef5350' });
    } else if (t === 'line') {
      priceSeries = chart.addSeries(LWC.LineSeries, { color: '#2962ff', lineWidth: 2 });
    } else {
      priceSeries = chart.addSeries(LWC.AreaSeries, {
        lineColor: '#2962ff', lineWidth: 2,
        topColor: 'rgba(41,98,255,0.35)', bottomColor: 'rgba(41,98,255,0.02)',
      });
    }
    priceSeries.applyOptions({ priceFormat: { type: 'price', precision: precisionFor(state.market.tickSize || 0.00000001), minMove: state.market.tickSize || 0.00000001 } });
    setPriceData();
  }

  function setPriceData() {
    if (!priceSeries) return;
    const t = state.chartType;
    if (t === 'candles' || t === 'bars') priceSeries.setData(state.candles);
    else priceSeries.setData(state.candles.map(c => ({ time: c.time, value: c.close })));
    volumeSeries.setData(state.candles.map(c => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    })));
  }

  function updateLastBar(c) {
    if (!priceSeries) return;
    const t = state.chartType;
    if (t === 'candles' || t === 'bars') priceSeries.update(c);
    else priceSeries.update({ time: c.time, value: c.close });
    volumeSeries.update({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    });
  }

  // ---------- Data loading ----------
  async function loadCandles() {
    const task = activeSelection = selection.begin();
    state.ws?.close(); state.ws = null;
    const { symbol, interval } = state;
    state.loaded = false; state.candles = []; invalidate(); setPriceData();
    for (const series of Object.values(overlaySeries).flat()) series.setData([]);
    for (const pane of Object.values(activePanes)) for (const series of Object.values(pane.seriesMap)) series.setData([]);
    state.pendingPoints = []; state.hoverPoint = null; dragging = null; brushing = false;
    state.drawTool = 'cursor'; selectTool('cursor'); lastTickPrice = null;
    smcAnalysis = null; hideCandleStory(); redrawOverlay();
    setConn('connecting', 'Loading market…');
    const status = document.getElementById('chart-message');
    status.hidden = false; status.textContent = 'Loading market history…';
    try {
      const markets = await getMarkets();
      if (!task.current()) return;
      const market = markets.find(m => m.symbol === symbol);
      if (!market) throw new Error('This spot market is unavailable. Choose another symbol.');
      const candles = await getCandles(symbol, interval, { signal: task.signal });
      if (!task.current()) return;
      if (!candles.length) throw new Error('No candles available for this market.');
      state.market = market; state.candles = candles; state.loaded = true; invalidate();
      priceSeries.applyOptions({ priceFormat: { type: 'price', precision: precisionFor(market.tickSize), minMove: market.tickSize } });
      setPriceData(); refreshIndicators(); chart.timeScale().fitContent();
      status.hidden = true; lastMarketEvent = Date.now();
      updateLegend(); updateSmc(); redrawOverlay(); connectWs(task);
      document.getElementById('market-caption').textContent = `${market.baseAsset} / ${market.quoteAsset} · Binance Spot`;
    } catch (err) {
      if (!task.current()) return;
      setConn('offline', 'Market unavailable');
      status.textContent = err.message + ' Use Retry or choose another market.';
    }
  }

  async function load24hStats() {
    const task = statsTask.begin(), symbol = state.symbol;
    try {
      const d = await apiFetch(`/api/v3/ticker/24hr?symbol=${symbol}`, { signal: task.signal });
      if (!task.current() || symbol !== state.symbol) return;
      renderStats(+d.lastPrice, +d.priceChangePercent, +d.highPrice, +d.lowPrice, +d.quoteVolume);
    } catch { /* candle feed has its own freshness indicator */ }
  }

  function renderStats(price, chgPct, high, low, qVol) {
    document.getElementById('stat-price').textContent = fmtPrice(price);
    const chgEl = document.getElementById('stat-change');
    chgEl.textContent = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%';
    chgEl.className = 'stat-change ' + (chgPct >= 0 ? 'up' : 'down');
    document.getElementById('stat-price').className = 'stat-price ' + (chgPct >= 0 ? 'up' : 'down');
    document.getElementById('stat-high').textContent = fmtPrice(high);
    document.getElementById('stat-low').textContent = fmtPrice(low);
    document.getElementById('stat-vol').textContent = fmtCompact(qVol);
  }

  // ---------- WebSocket: live kline ----------
  function connectWs(task = activeSelection) {
    state.ws?.close();
    const { symbol, interval } = state;
    let syncing = false, buffered = [], seen = false;
    const accept = c => {
      const last = state.candles.at(-1);
      if (!task.current() || !candleValid(c) || (last && c.time < last.time)) return;
      state.candles = mergeCandles(state.candles, [c]); invalidate();
      if (state.candles.length === 3000 && last?.time !== c.time) setPriceData(); else updateLastBar(c);
      lastMarketEvent = Date.now(); lastTickPrice ??= last?.close ?? c.close; checkAlerts(c.close);
      scheduleIndicators(); scheduleSmc(); schedulePaint();
      document.getElementById('stat-price').textContent = fmtPrice(c.close); updateLegend();
      if (csTime === c.time) renderCandleStory();
    };
    const reconcile = async () => {
      if (syncing || !task.current()) return;
      syncing = true; setConn('connecting', 'Reconciling candles…');
      try {
        const last = state.candles.at(-1), step = INTERVALS[interval];
        const largeGap = !last || Date.now() / 1000 - last.time >= 999 * step;
        const fresh = await getCandles(symbol, interval, { signal: task.signal, ...(largeGap ? {} : { startTime: last.time - step }) });
        if (!task.current()) return;
        state.candles = mergeCandles(largeGap ? [] : state.candles, fresh);
        const tail = state.candles.at(-1)?.time || 0;
        state.candles = mergeCandles(state.candles, buffered.filter(c => c.time >= tail));
        buffered = []; invalidate(); setPriceData(); refreshIndicators(); updateSmc(); schedulePaint();
        lastMarketEvent = Date.now(); setConn('live', 'Live · reconciled');
      } catch (e) {
        if (task.current()) { setConn('stale', 'Reconciliation failed · reconnecting'); state.ws?.socket?.close(); }
      } finally { syncing = false; }
    };
    state.ws = new MarketStream(`/ws/${symbol.toLowerCase()}@kline_${interval}`, {
      onOpen: () => { seen = true; reconcile(); },
      onData: m => {
        if (!task.current() || !m.k || m.k.s !== symbol || m.k.i !== interval) return;
        const k = m.k;
        const c = { time: +k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, tb: +k.V, closed: !!k.x };
        if (!candleValid(c)) return;
        if (syncing) { buffered.push(c); buffered = buffered.slice(-200); return; }
        if (c.time > (state.candles.at(-1)?.time || c.time) + INTERVALS[interval]) { buffered.push(c); reconcile(); return; }
        accept(c);
      },
      onStatus: status => { if (task.current() && !syncing) setConn(status, status === 'live' ? 'Live market data' : status === 'connecting' && seen ? 'Reconnecting…' : status === 'stale' ? 'Stale feed · reconnecting' : status === 'offline' ? 'Offline · retrying' : 'Connecting stream…'); },
    });
  }

  function connectWatchlistWs() {
    state.wlWs?.close();
    if (!WATCHLIST.length) return;
    state.wlWs = new MarketStream('/stream?streams=' + WATCHLIST.map(([sym]) => `${sym.toLowerCase()}@miniTicker`).join('/'), {
      staleMs: 90000,
      onData: ({ data }) => { if (data && symbolValid(data.s) && positive(+data.c) && positive(+data.o)) updateWatchRow(data.s, +data.c, (+data.c - +data.o) / +data.o * 100); },
    });
  }

  // ---------- Watchlist UI ----------
  const wlPrices = {};
  const wlHistory = {}; // sym -> [{t, p}] for 5-minute move detection
  function buildWatchlist() {
    const el = document.getElementById('watchlist');
    el.innerHTML = '';
    for (const [sym, name] of WATCHLIST) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'wl-row' + (sym === state.symbol ? ' active' : '');
      row.dataset.sym = sym;
      row.innerHTML = `
        <span class="wl-sym">${escapeHtml(assetInfo(sym).baseAsset)}<span class="wl-name"> / ${escapeHtml(assetInfo(sym).quoteAsset)}</span></span>
        <span class="wl-price">—</span>
        <span class="wl-name">${escapeHtml(name)}</span>
        <span class="wl-chg">—</span>`;
      row.addEventListener('click', () => switchSymbol(sym));
      el.appendChild(row);
    }
  }

  function updateWatchRow(sym, price, chgPct) {
    const row = document.querySelector(`.wl-row[data-sym="${sym}"]`);
    if (!row) return;
    const pEl = row.querySelector('.wl-price');
    const cEl = row.querySelector('.wl-chg');
    const prev = wlPrices[sym];
    pEl.textContent = fmtPrice(price);
    pEl.className = 'wl-price ' + (chgPct >= 0 ? 'up' : 'down');
    cEl.textContent = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%';
    cEl.className = 'wl-chg ' + (chgPct >= 0 ? 'up' : 'down');
    if (prev !== undefined && prev !== price) {
      row.classList.remove('flash-up', 'flash-down');
      void row.offsetWidth;
      row.classList.add(price > prev ? 'flash-up' : 'flash-down');
    }
    wlPrices[sym] = price;

    // 5-minute move detection
    const now = Date.now();
    const h = wlHistory[sym] = (wlHistory[sym] || []).filter(x => now - x.t < 5 * 60 * 1000);
    h.push({ t: now, p: price });
    const symEl = row.querySelector('.wl-sym');
    let flag = symEl.querySelector('.wl-flag');
    if (h.length > 3) {
      const move = (price - h[0].p) / h[0].p * 100;
      if (Math.abs(move) >= 1) {
        if (!flag) {
          flag = document.createElement('span');
          flag.className = 'wl-flag';
          symEl.appendChild(flag);
        }
        flag.textContent = ` ${move > 0 ? '▲' : '▼'}${Math.abs(move).toFixed(1)}% 5m`;
        flag.className = 'wl-flag ' + (move > 0 ? 'up' : 'down');
      } else if (flag) flag.remove();
    }
  }

  // =====================================================================
  //  INDICATORS
  // =====================================================================
  let evaluatingKey = '';
  const I = new Proxy(Indicators, { get(target, method) { return (candles, ...args) => target[method](candles, ...(method === 'vwap' ? [state.vwapAnchor] : state.params[evaluatingKey] || args)); } });
  let indicatorTimer;
  function scheduleIndicators() { if (!indicatorTimer) indicatorTimer = setTimeout(() => { indicatorTimer = null; refreshIndicators(); }, 250); }


  // ---- Overlay indicator definitions: key -> () => [{opts,data,type?}] ----
  const overlayDefs = {
    sma20:  c => [{ opts: { color: '#f7b924', lineWidth: 1 }, data: I.sma(c, 20) }],
    sma50:  c => [{ opts: { color: '#e040fb', lineWidth: 1 }, data: I.sma(c, 50) }],
    sma200: c => [{ opts: { color: '#f44336', lineWidth: 2 }, data: I.sma(c, 200) }],
    ema20:  c => [{ opts: { color: '#00bcd4', lineWidth: 1 }, data: I.ema(c, 20) }],
    ema50:  c => [{ opts: { color: '#8bc34a', lineWidth: 1 }, data: I.ema(c, 50) }],
    ema200: c => [{ opts: { color: '#ff6d00', lineWidth: 2 }, data: I.ema(c, 200) }],
    wma20:  c => [{ opts: { color: '#26c6da', lineWidth: 1, lineStyle: 2 }, data: I.wma(c, 20) }],
    vwap:   c => [{ opts: { color: '#ba68c8', lineWidth: 1, lineStyle: 2 }, data: I.vwap(c) }],
    bb: c => {
      const b = I.bollinger(c, 20, 2);
      return [
        { opts: { color: 'rgba(41,98,255,0.9)', lineWidth: 1 }, data: b.upper },
        { opts: { color: 'rgba(41,98,255,0.5)', lineWidth: 1, lineStyle: 2 }, data: b.middle },
        { opts: { color: 'rgba(41,98,255,0.9)', lineWidth: 1 }, data: b.lower },
      ];
    },
    keltner: c => {
      const k = I.keltner(c, 20, 2);
      return [
        { opts: { color: 'rgba(0,188,212,0.9)', lineWidth: 1 }, data: k.upper },
        { opts: { color: 'rgba(0,188,212,0.5)', lineWidth: 1, lineStyle: 2 }, data: k.middle },
        { opts: { color: 'rgba(0,188,212,0.9)', lineWidth: 1 }, data: k.lower },
      ];
    },
    donchian: c => {
      const d = I.donchian(c, 20);
      return [
        { opts: { color: 'rgba(139,195,74,0.9)', lineWidth: 1 }, data: d.upper },
        { opts: { color: 'rgba(139,195,74,0.5)', lineWidth: 1, lineStyle: 2 }, data: d.middle },
        { opts: { color: 'rgba(139,195,74,0.9)', lineWidth: 1 }, data: d.lower },
      ];
    },
    ichimoku: c => {
      const ich = I.ichimoku(c);
      return [
        { opts: { color: '#2962ff', lineWidth: 1 }, data: ich.tenkan },
        { opts: { color: '#b71c1c', lineWidth: 1 }, data: ich.kijun },
        { opts: { color: 'rgba(38,166,154,0.8)', lineWidth: 1 }, data: ich.senkouA },
        { opts: { color: 'rgba(239,83,80,0.8)', lineWidth: 1 }, data: ich.senkouB },
        { opts: { color: '#66bb6a', lineWidth: 1, lineStyle: 2 }, data: ich.chikou },
      ];
    },
    psar: c => [{ type: 'dots', opts: {}, data: I.psar(c) }],
    supertrend: c => [{ type: 'colorline', opts: { lineWidth: 2 }, data: I.supertrend(c) }],
  };

  function addOverlaySeries(group) {
    if (group.type === 'dots') {
      // render PSAR as tiny histogram-like markers using a line series with point markers off
      const s = chart.addSeries(LWC.LineSeries, {
        lineWidth: 1, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        color: '#f7b924',
      });
      s.setData(group.data);
      return s;
    }
    const s = chart.addSeries(LWC.LineSeries, {
      ...group.opts,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(group.data);
    return s;
  }

  // ---- Sub-pane (oscillator) definitions ----
  // Each def: { label, height?, build(paneChart) -> seriesMap, update(seriesMap, candles) }
  const paneDefs = {
    rsi: {
      label: 'RSI 14',
      build(pc) {
        const s = pc.addSeries(LWC.LineSeries, { color: '#b388ff', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
        s.createPriceLine({ price: 70, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        s.createPriceLine({ price: 30, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { s };
      },
      update(m, c) {
        const d = I.rsi(c, 14);
        m.s.setData(d);
        return d.length ? d[d.length - 1].value.toFixed(2) : '';
      },
    },
    macd: {
      label: 'MACD 12 26 9',
      build(pc) {
        return {
          hist: pc.addSeries(LWC.HistogramSeries, { lastValueVisible: false, priceLineVisible: false }),
          line: pc.addSeries(LWC.LineSeries, { color: '#2962ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }),
          sig: pc.addSeries(LWC.LineSeries, { color: '#ff6d00', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }),
        };
      },
      update(m, c) {
        const d = I.macd(c);
        m.hist.setData(d.histogram);
        m.line.setData(d.macdLine);
        m.sig.setData(d.signal);
        return d.macdLine.length ? d.macdLine[d.macdLine.length - 1].value.toFixed(2) : '';
      },
    },
    stoch: {
      label: 'Stoch 14 3 3',
      build(pc) {
        const k = pc.addSeries(LWC.LineSeries, { color: '#2962ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        const d = pc.addSeries(LWC.LineSeries, { color: '#ff6d00', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        k.createPriceLine({ price: 80, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        k.createPriceLine({ price: 20, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { k, d };
      },
      update(m, c) {
        const s = I.stochastic(c, 14, 3, 3);
        m.k.setData(s.k);
        m.d.setData(s.d);
        return s.k.length ? s.k[s.k.length - 1].value.toFixed(2) : '';
      },
    },
    stochrsi: {
      label: 'StochRSI 14 14 3 3',
      build(pc) {
        const k = pc.addSeries(LWC.LineSeries, { color: '#00bcd4', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        const d = pc.addSeries(LWC.LineSeries, { color: '#e040fb', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        k.createPriceLine({ price: 80, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        k.createPriceLine({ price: 20, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { k, d };
      },
      update(m, c) {
        const s = I.stochRsi(c);
        m.k.setData(s.k);
        m.d.setData(s.d);
        return s.k.length ? s.k[s.k.length - 1].value.toFixed(2) : '';
      },
    },
    atr: {
      label: 'ATR 14',
      build(pc) {
        return { s: pc.addSeries(LWC.LineSeries, { color: '#f7b924', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }) };
      },
      update(m, c) {
        const d = I.atr(c, 14);
        m.s.setData(d);
        return d.length ? fmtPrice(d[d.length - 1].value) : '';
      },
    },
    adx: {
      label: 'ADX/DMI 14',
      build(pc) {
        return {
          adx: pc.addSeries(LWC.LineSeries, { color: '#f7b924', lineWidth: 2, lastValueVisible: false, priceLineVisible: false }),
          p: pc.addSeries(LWC.LineSeries, { color: '#26a69a', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }),
          m: pc.addSeries(LWC.LineSeries, { color: '#ef5350', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }),
        };
      },
      update(m, c) {
        const d = I.adx(c, 14);
        m.adx.setData(d.adxLine);
        m.p.setData(d.plusDI);
        m.m.setData(d.minusDI);
        return d.adxLine.length ? d.adxLine[d.adxLine.length - 1].value.toFixed(2) : '';
      },
    },
    cci: {
      label: 'CCI 20',
      build(pc) {
        const s = pc.addSeries(LWC.LineSeries, { color: '#26c6da', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        s.createPriceLine({ price: 100, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        s.createPriceLine({ price: -100, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { s };
      },
      update(m, c) {
        const d = I.cci(c, 20);
        m.s.setData(d);
        return d.length ? d[d.length - 1].value.toFixed(2) : '';
      },
    },
    mfi: {
      label: 'MFI 14',
      build(pc) {
        const s = pc.addSeries(LWC.LineSeries, { color: '#8bc34a', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        s.createPriceLine({ price: 80, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        s.createPriceLine({ price: 20, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { s };
      },
      update(m, c) {
        const d = I.mfi(c, 14);
        m.s.setData(d);
        return d.length ? d[d.length - 1].value.toFixed(2) : '';
      },
    },
    obv: {
      label: 'OBV',
      build(pc) {
        return { s: pc.addSeries(LWC.LineSeries, { color: '#64b5f6', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }) };
      },
      update(m, c) {
        const d = I.obv(c);
        m.s.setData(d);
        return d.length ? fmtCompact(Math.abs(d[d.length - 1].value)) : '';
      },
    },
    willr: {
      label: 'Williams %R 14',
      build(pc) {
        const s = pc.addSeries(LWC.LineSeries, { color: '#ff8a65', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
        s.createPriceLine({ price: -20, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        s.createPriceLine({ price: -80, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        return { s };
      },
      update(m, c) {
        const d = I.williamsR(c, 14);
        m.s.setData(d);
        return d.length ? d[d.length - 1].value.toFixed(2) : '';
      },
    },
    cvd: {
      label: 'CVD (Cumulative Volume Delta)',
      build(pc) {
        return { s: pc.addSeries(LWC.LineSeries, { color: '#64b5f6', lineWidth: 2, lastValueVisible: false, priceLineVisible: false }) };
      },
      update(m, c) {
        let cum = 0;
        const out = c.map(x => {
          const delta = (x.tb !== undefined && !isNaN(x.tb))
            ? (2 * x.tb - x.volume)
            : (x.close >= x.open ? x.volume : -x.volume);
          cum += delta;
          return { time: x.time, value: cum };
        });
        m.s.setData(out);
        return fmtCompact(Math.abs(cum)) + (cum >= 0 ? ' ▲' : ' ▼');
      },
    },
  };

  // Native v5 panes share the same timestamp index and price/time interactions.
  const activePanes = {};
  function createPane(key) {
    const def = paneDefs[key], index = chart.panes().length;
    const facade = { addSeries: (type, options) => chart.addSeries(type, options, index) };
    const seriesMap = def.build(facade);
    const el = document.createElement('div'); el.className = 'pane-label native-pane-label';
    el.innerHTML = `<span class="pane-title">${escapeHtml(def.label)}</span> <span class="pane-value"></span><button class="pane-close" aria-label="Remove ${escapeHtml(def.label)}">×</button>`;
    document.getElementById('main-chart-wrap').append(el);
    activePanes[key] = { seriesMap, el, valueEl: el.querySelector('.pane-value') };
    el.querySelector('button').onclick = () => {
      state.indicators[key] = false;
      document.querySelector(`input[data-ind="${key}"],input[data-intra="${key}"]`)?.removeAttribute('checked');
      const cb = document.querySelector(`input[data-ind="${key}"],input[data-intra="${key}"]`); if (cb) cb.checked = false;
      refreshIndicators(); saveSettings();
    };
  }
  function removePane(key) {
    const pane = activePanes[key]; if (!pane) return;
    Object.values(pane.seriesMap).forEach(series => chart.removeSeries(series)); pane.el.remove(); delete activePanes[key];
  }
  function refreshIndicators() {
    const c = state.candles;
    for (const key of Object.keys(overlayDefs)) {
      evaluatingKey = key;
      if (state.indicators[key] && c.length) {
        const groups = overlayDefs[key](c);
        if (!overlaySeries[key]) overlaySeries[key] = groups.map(addOverlaySeries);
        else overlaySeries[key].forEach((series, i) => series.setData(groups[i].data));
        if (state.colors[key]) overlaySeries[key][0].applyOptions({ color: state.colors[key] });
      } else if (overlaySeries[key]) { overlaySeries[key].forEach(series => chart.removeSeries(series)); delete overlaySeries[key]; }
    }
    let changed = false;
    for (const key of Object.keys(paneDefs)) {
      evaluatingKey = key;
      if (state.indicators[key] && c.length) {
        if (!activePanes[key]) { createPane(key); changed = true; }
        const p = activePanes[key]; p.valueEl.textContent = paneDefs[key].update(p.seriesMap, c);
        if (state.colors[key]) Object.values(p.seriesMap)[0].applyOptions({ color: state.colors[key] });
        p.el.querySelector('.pane-title').textContent = key.toUpperCase() + ' ' + (state.params[key]?.join(' / ') || paneDefs[key].label.replace(/^[^ ]+\s*/, ''));
      } else if (activePanes[key]) { removePane(key); changed = true; }
    }
    evaluatingKey = '';
    if (changed) adjustPaneHeights();
    schedulePaint();
  }
  function adjustPaneHeights() {
    const panes = chart.panes(), available = Math.max(200, mainEl.clientHeight - 28), n = panes.length - 1;
    const h = n ? Math.max(30, Math.min(130, available * .45 / n)) : 0;
    panes.forEach((pane, index) => pane.setHeight(index ? h : Math.max(80, available - h * n)));
    requestAnimationFrame(() => { resizeOverlay(); positionPaneLabels(); });
  }
  function positionPaneLabels() {
    const panes = chart.panes();
    for (const pane of Object.values(activePanes)) {
      const index = Object.values(pane.seriesMap)[0].getPane().paneIndex();
      pane.el.style.top = (panes.slice(0, index).reduce((sum, p) => sum + p.getHeight() + 1, 0) + 6) + 'px';
    }
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => schedulePaint());

  // ---------- Legend / crosshair ----------
  function updateLegend(bar) {
    const c = bar || state.candles[state.candles.length - 1];
    if (!c) return;
    const up = c.close >= c.open;
    const cls = up ? 'up' : 'down';
    document.getElementById('legend').innerHTML = `
      <div class="lg-sym">${escapeHtml(state.symbol)} · ${escapeHtml(state.interval.toUpperCase())} · Binance</div>
      <div class="lg-row">
        <span>O <b class="${cls}">${fmtPrice(c.open)}</b></span>
        <span>H <b class="${cls}">${fmtPrice(c.high)}</b></span>
        <span>L <b class="${cls}">${fmtPrice(c.low)}</b></span>
        <span>C <b class="${cls}">${fmtPrice(c.close)}</b></span>
        <span>Vol <b class="${cls}">${fmtCompact(c.volume)}</b></span>
      </div>`;
  }

  chart.subscribeCrosshairMove(param => {
    if (param.time && state.candles.length) {
      const bar = state.candles.find(x => x.time === param.time);
      if (bar) updateLegend(bar);
    } else {
      updateLegend();
    }
  });

  // =====================================================================
  //  DRAWING ENGINE
  //  Shape: { type, points: [{time,price},...], text? }
  //  Tools: trendline, ray, hline, vline, rect, fib, brush, text, ruler
  // =====================================================================
  const overlay = document.getElementById('draw-overlay');
  const octx = overlay.getContext('2d');

  const TWO_POINT_TOOLS = ['trendline', 'ray', 'rect', 'fib', 'ruler', 'long', 'short'];
  const ONE_POINT_TOOLS = ['hline', 'vline', 'text'];
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ['#787b86', '#ef5350', '#ff9800', '#f7b924', '#26a69a', '#00bcd4', '#787b86'];

  function storageKey() { return `chartpro-drawings-${state.symbol}`; }
  const drawingHistory = new History();
  function saveDrawings(record = true) {
    if (!drawingsValid(state.drawings)) { toast('Invalid drawing or drawing limit reached (300).', 'error'); return; }
    if (record) drawingHistory.push(state.drawings);
    writeStorage(storageKey(), state.drawings);
    document.getElementById('undo-drawing').disabled = drawingHistory.index === 0;
    document.getElementById('redo-drawing').disabled = drawingHistory.index === drawingHistory.entries.length - 1;
  }
  function loadDrawings() {
    state.drawings = readStorage(storageKey(), [], drawingsValid);
    drawingHistory.reset(state.drawings); state.selectedIdx = -1;
  }

  function resizeOverlay() {
    const r = mainEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = r.width * dpr;
    overlay.height = Math.max(0, chart.panes()[0].getHeight()) * dpr;
    overlay.style.width = r.width + 'px';
    overlay.style.height = chart.panes()[0].getHeight() + 'px';
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawOverlay();
  }

  function toXY(pt) {
    const x = xForTime(pt.time);
    const y = priceSeries ? priceSeries.priceToCoordinate(pt.price) : null;
    return (x == null || y == null) ? null : { x, y };
  }
  function toPoint(x, y) {
    let time = chart.timeScale().coordinateToTime(x);
    const price = priceSeries ? priceSeries.coordinateToPrice(y) : null;
    if (time == null) {
      // beyond last bar — extrapolate from logical index
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical != null && state.candles.length > 1) {
        const step = state.candles[1].time - state.candles[0].time;
        time = state.candles[0].time + Math.round(logical) * step;
      }
    }
    return (time == null || !positive(price) || y > chart.panes()[0].getHeight() || x >= mainEl.clientWidth - chart.priceScale('right').width()) ? null : { time, price };
  }

  // Magnet: snap price to nearest OHLC of the bar at `time`
  function snap(pt) {
    if (!state.magnet || !pt) return pt;
    const bar = state.candles.find(c => c.time === pt.time);
    if (!bar) return pt;
    const vals = [bar.open, bar.high, bar.low, bar.close];
    let best = vals[0], bd = Infinity;
    for (const v of vals) {
      const d = Math.abs(v - pt.price);
      if (d < bd) { bd = d; best = v; }
    }
    return { time: pt.time, price: best };
  }

  let paintFrame;
  function schedulePaint() { if (!paintFrame) paintFrame = requestAnimationFrame(() => { paintFrame = null; redrawOverlay(); }); }
  function redrawOverlay() {
    if (overlay.clientHeight !== chart.panes()[0].getHeight()) { resizeOverlay(); return; }
    positionPaneLabels();
    octx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
    drawSessions();
    drawVProfile();
    drawSmc();
    drawKeyLevels();
    drawAlertLines();
    drawCountdown();
    state.drawings.forEach((d, i) => drawShape(d, false, i === state.selectedIdx));
    // preview while drawing
    if (state.pendingPoints.length && state.hoverPoint) {
      drawShape({ type: state.drawTool, points: [...state.pendingPoints, state.hoverPoint] }, true, false);
    }
  }

  function drawShape(d, preview, selected) {
    const w = overlay.clientWidth, h = overlay.clientHeight;
    octx.save();
    const baseColor = d.color || '#2962ff';
    const lw = d.width || 1.5;
    octx.strokeStyle = preview ? 'rgba(41,98,255,0.7)' : baseColor;
    octx.lineWidth = selected ? lw + 1 : lw;
    octx.setLineDash(preview ? [5, 4] : dashFor(d.style));

    const P = d.points;

    if (d.type === 'hline') {
      const y = priceSeries ? priceSeries.priceToCoordinate(P[0].price) : null;
      if (y == null) { octx.restore(); return; }
      line(0, y, w, y);
      octx.setLineDash([]);
      octx.fillStyle = baseColor;
      octx.font = '11px Inter';
      octx.fillText(fmtPrice(P[0].price), 6, y - 5);
      if (selected) handle(w / 2, y);

    } else if (d.type === 'vline') {
      const x = xForTime(P[0].time);
      if (x == null) { octx.restore(); return; }
      line(x, 0, x, h);
      if (selected) handle(x, h / 2);

    } else if (d.type === 'trendline' || d.type === 'ray') {
      const a = toXY(P[0]), b = toXY(P[1]);
      if (!a || !b) { octx.restore(); return; }
      let bx = b.x, by = b.y;
      if (d.type === 'ray' && b.x !== a.x) {
        // extend to right edge
        const slope = (b.y - a.y) / (b.x - a.x);
        if (b.x > a.x) { by = a.y + slope * (w - a.x); bx = w; }
        else { by = a.y + slope * (0 - a.x); bx = 0; }
      }
      line(a.x, a.y, bx, by);
      if (selected) { handle(a.x, a.y); handle(b.x, b.y); }

    } else if (d.type === 'rect') {
      const a = toXY(P[0]), b = toXY(P[1]);
      if (!a || !b) { octx.restore(); return; }
      octx.fillStyle = hexToRgba(baseColor, 0.12);
      octx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      if (selected) { handle(a.x, a.y); handle(b.x, b.y); }

    } else if (d.type === 'fib') {
      const a = toXY(P[0]), b = toXY(P[1]);
      if (!a || !b) { octx.restore(); return; }
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      const pr1 = P[0].price, pr2 = P[1].price;
      octx.font = '10px Inter';
      for (let i = 0; i < FIB_LEVELS.length; i++) {
        const lv = FIB_LEVELS[i];
        const price = pr2 - (pr2 - pr1) * lv;
        const y = priceSeries.priceToCoordinate(price);
        if (y == null) continue;
        octx.strokeStyle = preview ? 'rgba(41,98,255,0.6)' : FIB_COLORS[i];
        line(x1, y, x2, y);
        if (!preview) {
          octx.fillStyle = FIB_COLORS[i];
          octx.fillText(`${lv}  ${fmtPrice(price)}`, x2 + 6, y + 3);
        }
        // shade between levels
        if (i > 0 && !preview) {
          const prevPrice = pr2 - (pr2 - pr1) * FIB_LEVELS[i - 1];
          const py = priceSeries.priceToCoordinate(prevPrice);
          if (py != null) {
            octx.fillStyle = hexToRgba(FIB_COLORS[i], 0.06);
            octx.fillRect(x1, Math.min(y, py), x2 - x1, Math.abs(y - py));
          }
        }
      }
      // diagonal reference
      octx.strokeStyle = 'rgba(120,123,134,0.5)';
      octx.setLineDash([4, 4]);
      line(a.x, a.y, b.x, b.y);
      if (selected) { handle(a.x, a.y); handle(b.x, b.y); }

    } else if (d.type === 'long' || d.type === 'short') {
      const pc = positionCoords(d);
      if (!pc) { octx.restore(); return; }
      const entry = P[0], target = P[1], stop = pc.stop;
      octx.setLineDash([]);
      octx.fillStyle = 'rgba(38,166,154,0.16)';
      octx.fillRect(pc.x1, Math.min(pc.yE, pc.yT), pc.x2 - pc.x1, Math.abs(pc.yT - pc.yE));
      octx.fillStyle = 'rgba(239,83,80,0.16)';
      octx.fillRect(pc.x1, Math.min(pc.yE, pc.yS), pc.x2 - pc.x1, Math.abs(pc.yS - pc.yE));
      octx.lineWidth = selected ? 2 : 1;
      octx.strokeStyle = '#787b86'; line(pc.x1, pc.yE, pc.x2, pc.yE);
      octx.strokeStyle = '#26a69a'; line(pc.x1, pc.yT, pc.x2, pc.yT);
      octx.strokeStyle = '#ef5350'; line(pc.x1, pc.yS, pc.x2, pc.yS);
      const reward = Math.abs(target.price - entry.price);
      const valid = d.type === 'long' ? target.price > entry.price && stop.price < entry.price : target.price < entry.price && stop.price > entry.price;
      const risk = valid ? Math.abs(entry.price - stop.price) : 0;
      const rr = risk > 0 ? reward / risk : 0;
      const pctT = (target.price - entry.price) / entry.price * 100;
      const pctS = (stop.price - entry.price) / entry.price * 100;
      octx.font = 'bold 11px Inter';
      octx.fillStyle = '#26a69a';
      octx.fillText(`Target ${fmtPrice(target.price)} (${pctT >= 0 ? '+' : ''}${pctT.toFixed(2)}%)`, pc.x1 + 4, pc.yT + (pc.yT < pc.yE ? -5 : 13));
      octx.fillStyle = '#ef5350';
      octx.fillText(`Stop ${fmtPrice(stop.price)} (${pctS >= 0 ? '+' : ''}${pctS.toFixed(2)}%)`, pc.x1 + 4, pc.yS + (pc.yS > pc.yE ? 13 : -5));
      octx.fillStyle = '#d1d4dc';
      octx.fillText(`${d.type === 'long' ? 'LONG' : 'SHORT'} ${fmtPrice(entry.price)} · ${valid ? 'R/R ' + rr.toFixed(2) : 'INVALID LEVELS'}`, pc.x1 + 4, pc.yE - 5);
      if (selected) { handle(pc.x1, pc.yE); handle(pc.x2, pc.yT); handle(pc.x2, pc.yS); }

    } else if (d.type === 'ruler') {
      const a = toXY(P[0]), b = toXY(P[1]);
      if (!a || !b) { octx.restore(); return; }
      const upMove = P[1].price >= P[0].price;
      const col = upMove ? '#26a69a' : '#ef5350';
      octx.strokeStyle = col;
      octx.fillStyle = hexToRgba(col, 0.1);
      octx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      const pct = (P[1].price - P[0].price) / P[0].price * 100;
      const bars = Math.round(Math.abs(P[1].time - P[0].time) / barStep());
      octx.setLineDash([]);
      octx.fillStyle = col;
      octx.font = 'bold 12px Inter';
      const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  Δ${fmtPrice(Math.abs(P[1].price - P[0].price))}  ${bars} bars`;
      octx.fillText(label, Math.min(a.x, b.x) + 6, Math.min(a.y, b.y) - 8);
      if (selected) { handle(a.x, a.y); handle(b.x, b.y); }

    } else if (d.type === 'brush') {
      octx.beginPath();
      let started = false;
      for (const p of P) {
        const xy = toXY(p);
        if (!xy) continue;
        if (!started) { octx.moveTo(xy.x, xy.y); started = true; }
        else octx.lineTo(xy.x, xy.y);
      }
      octx.stroke();
      if (selected && P.length) {
        const first = toXY(P[0]);
        if (first) handle(first.x, first.y);
      }

    } else if (d.type === 'text') {
      const a = toXY(P[0]);
      if (!a) { octx.restore(); return; }
      octx.setLineDash([]);
      octx.font = '600 13px Inter';
      octx.fillStyle = baseColor;
      const txt = d.text || 'Note';
      octx.fillText(txt, a.x + 8, a.y - 6);
      octx.beginPath();
      octx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      octx.fill();
      if (selected) {
        const m = octx.measureText(txt);
        octx.strokeStyle = '#2962ff';
        octx.strokeRect(a.x + 4, a.y - 22, m.width + 8, 20);
      }
    }
    octx.restore();

    function line(x1, y1, x2, y2) {
      octx.beginPath();
      octx.moveTo(x1, y1);
      octx.lineTo(x2, y2);
      octx.stroke();
    }
    function handle(x, y) {
      octx.setLineDash([]);
      octx.fillStyle = '#fff';
      octx.strokeStyle = '#2962ff';
      octx.beginPath();
      octx.arc(x, y, 4, 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }
  }

  function barStep() {
    return state.candles.length > 1 ? state.candles[1].time - state.candles[0].time : 60;
  }

  function dashFor(style) {
    if (style === 'dashed') return [6, 4];
    if (style === 'dotted') return [2, 3];
    return [];
  }

  function styleProps() {
    return { color: state.toolStyle.color, width: state.toolStyle.width, style: state.toolStyle.style };
  }

  // Default stop for a new position: half the target distance (R/R = 2)
  function autoStop(type, entry, target) {
    const dist = Math.abs(target.price - entry.price) / 2;
    return {
      time: target.time,
      price: type === 'long' ? entry.price - dist : entry.price + dist,
    };
  }

  function positionCoords(d) {
    const P = d.points;
    if (P.length < 2) return null;
    const stop = P[2] || autoStop(d.type, P[0], P[1]);
    const x1 = xForTime(Math.min(P[0].time, P[1].time));
    let x2 = xForTime(Math.max(P[0].time, P[1].time));
    const yE = priceSeries ? priceSeries.priceToCoordinate(P[0].price) : null;
    const yT = priceSeries ? priceSeries.priceToCoordinate(P[1].price) : null;
    const yS = priceSeries ? priceSeries.priceToCoordinate(stop.price) : null;
    if (x1 == null || x2 == null || yE == null || yT == null || yS == null) return null;
    if (x2 - x1 < 30) x2 = x1 + 30;
    return { x1, x2, yE, yT, yS, stop };
  }

  function hexToRgba(hex, a) {
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---- Hit testing for select / drag ----
  function hitTest(x, y) {
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const d = state.drawings[i];
      const P = d.points;
      if (d.locked) continue;
      if (d.type === 'hline') {
        const yy = priceSeries.priceToCoordinate(P[0].price);
        if (yy != null && Math.abs(y - yy) < 6) return { idx: i, part: 'body' };
      } else if (d.type === 'vline') {
        const xx = xForTime(P[0].time);
        if (xx != null && Math.abs(x - xx) < 6) return { idx: i, part: 'body' };
      } else if (d.type === 'text') {
        const a = toXY(P[0]);
        if (a && Math.abs(x - a.x) < 40 && y > a.y - 26 && y < a.y + 8) return { idx: i, part: 'body' };
      } else if (d.type === 'brush') {
        for (const p of P) {
          const xy = toXY(p);
          if (xy && Math.hypot(x - xy.x, y - xy.y) < 7) return { idx: i, part: 'body' };
        }
      } else if (d.type === 'long' || d.type === 'short') {
        const pc = positionCoords(d);
        if (pc) {
          if (Math.hypot(x - pc.x1, y - pc.yE) < 9) return { idx: i, part: 'p1' };
          if (Math.hypot(x - pc.x2, y - pc.yT) < 9) return { idx: i, part: 'p2' };
          if (Math.hypot(x - pc.x2, y - pc.yS) < 9) return { idx: i, part: 'p3' };
          if (x > pc.x1 && x < pc.x2 &&
              y > Math.min(pc.yE, pc.yT, pc.yS) - 4 && y < Math.max(pc.yE, pc.yT, pc.yS) + 4) {
            return { idx: i, part: 'body' };
          }
        }
      } else if (P.length >= 2) {
        const a = toXY(P[0]), b = toXY(P[1]);
        if (!a || !b) continue;
        if (Math.hypot(x - a.x, y - a.y) < 8) return { idx: i, part: 'p1' };
        if (Math.hypot(x - b.x, y - b.y) < 8) return { idx: i, part: 'p2' };
        if (d.type === 'rect' || d.type === 'ruler' || d.type === 'fib') {
          if (x > Math.min(a.x, b.x) - 4 && x < Math.max(a.x, b.x) + 4 &&
              y > Math.min(a.y, b.y) - 4 && y < Math.max(a.y, b.y) + 4) {
            // near edge OR fib/ruler interior
            return { idx: i, part: 'body' };
          }
        } else {
          // distance from segment (extend ray to right edge for hit purposes)
          let bx = b.x, by = b.y;
          if (d.type === 'ray' && b.x !== a.x) {
            const slope = (b.y - a.y) / (b.x - a.x);
            bx = b.x > a.x ? overlay.clientWidth : 0;
            by = a.y + slope * (bx - a.x);
          }
          if (distToSegment(x, y, a.x, a.y, bx, by) < 6) return { idx: i, part: 'body' };
        }
      }
    }
    return null;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ---- Mouse interaction ----
  let dragging = null;   // { idx, part, startPt, orig }
  let brushing = false;

  overlay.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !state.loaded) return;
    overlay.setPointerCapture(e.pointerId);
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const tool = state.drawTool;

    if (tool === 'cursor') {
      const hit = hitTest(x, y);
      if (hit) {
        state.selectedIdx = hit.idx;
        const pt = toPoint(x, y);
        dragging = {
          idx: hit.idx, part: hit.part, startPt: pt,
          orig: JSON.parse(JSON.stringify(state.drawings[hit.idx].points)),
        };
        overlay.style.cursor = 'grabbing';
      } else {
        state.selectedIdx = -1;
      }
      redrawOverlay();
      syncSettingsBar();
      return;
    }

    const pt = snap(toPoint(x, y));
    if (!pt) return;
    if (state.drawings.length >= 300 && !state.pendingPoints.length) { toast('Drawing limit reached. Export or remove drawings.', 'error'); return; }

    if (tool === 'alert') {
      addAlert(pt.price);
      selectTool('cursor');
      return;
    }

    if (tool === 'brush') {
      brushing = true;
      state.drawings.push({ type: 'brush', points: [pt], ...styleProps() });
      redrawOverlay();
      return;
    }

    if (ONE_POINT_TOOLS.includes(tool)) {
      const shape = { type: tool, points: [pt], ...styleProps() };
      if (tool === 'text') {
        const txt = prompt('Note text:', '');
        if (!txt) { selectTool('cursor'); return; }
        shape.text = txt.slice(0, 1000);
      }
      state.drawings.push(shape);
      saveDrawings();
      redrawOverlay();
      selectTool('cursor');
      return;
    }

    if (TWO_POINT_TOOLS.includes(tool)) {
      if (!state.pendingPoints.length) {
        state.pendingPoints = [pt];
      } else {
        const shape = { type: tool, points: [state.pendingPoints[0], pt], ...styleProps() };
        if (tool === 'long' || tool === 'short') {
          if ((tool === 'long' && pt.price <= shape.points[0].price) || (tool === 'short' && pt.price >= shape.points[0].price)) { toast('Place the target above entry for long, below entry for short.', 'error'); return; }
          shape.points.push(autoStop(tool, shape.points[0], shape.points[1]));
        }
        state.drawings.push(shape);
        state.pendingPoints = [];
        state.hoverPoint = null;
        saveDrawings();
        redrawOverlay();
        selectTool('cursor');
      }
    }
  });

  overlay.addEventListener('pointermove', e => {
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (brushing) {
      const pt = toPoint(x, y);
      if (pt && state.drawings.at(-1)?.points.length < 5000) {
        state.drawings[state.drawings.length - 1].points.push(pt);
        redrawOverlay();
      }
      return;
    }

    if (dragging) {
      const pt = toPoint(x, y);
      if (pt && dragging.startPt) {
        const dT = pt.time - dragging.startPt.time;
        const dP = pt.price - dragging.startPt.price;
        const shape = state.drawings[dragging.idx];
        if (/^p\d$/.test(dragging.part)) {
          const pi = +dragging.part.slice(1) - 1;
          if (dragging.orig[pi]) {
            shape.points[pi] = snap({ time: dragging.orig[pi].time + dT, price: dragging.orig[pi].price + dP });
          }
        } else {
          shape.points = dragging.orig.map(p => ({ time: p.time + dT, price: p.price + dP }));
        }
        redrawOverlay();
      }
      return;
    }

    if (state.drawTool === 'cursor') {
      overlay.style.cursor = hitTest(x, y) ? 'grab' : 'default';
      return;
    }

    if (state.pendingPoints.length) {
      state.hoverPoint = snap(toPoint(x, y));
      redrawOverlay();
    }
  });

  window.addEventListener('pointerup', () => {
    if (brushing) {
      brushing = false;
      saveDrawings();
      selectTool('cursor');
    }
    if (dragging) {
      dragging = null;
      overlay.style.cursor = 'default';
      saveDrawings();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select,[contenteditable],dialog,.modal')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      state.pendingPoints = [];
      state.hoverPoint = null;
      state.selectedIdx = -1;
      redrawOverlay();
      selectTool('cursor');
      closeModal();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIdx >= 0) {
      state.drawings.splice(state.selectedIdx, 1);
      state.selectedIdx = -1;
      saveDrawings();
      redrawOverlay();
      syncSettingsBar();
    } else if (e.key === 'v' || e.key === 'V') selectTool('cursor');
    else if (e.key === 't' || e.key === 'T') selectTool('trendline');
    else if (e.key === 'h' || e.key === 'H') selectTool('hline');
    else if (e.key === 'r' || e.key === 'R') selectTool('rect');
    else if (e.key === 'f' || e.key === 'F') selectTool('fib');
    else if (e.key === 'm' || e.key === 'M') selectTool('ruler');
  });

  function selectTool(tool) {
    state.drawTool = tool;
    state.pendingPoints = [];
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    // Overlay must intercept mouse when drawing OR when there are drawings to select.
    updateOverlayPointer();
    redrawOverlay();
    syncSettingsBar();
  }

  function updateOverlayPointer() {
    const active = state.drawTool !== 'cursor' || state.drawings.length > 0;
    overlay.classList.toggle('drawing', state.drawTool !== 'cursor');
    overlay.style.pointerEvents = state.drawTool !== 'cursor' ? 'auto' : 'none';
  }

  // In cursor mode the overlay is pointer-transparent so the chart pans normally.
  // We listen on the wrapper to catch clicks near drawings for selection.
  document.getElementById('main-chart-wrap').addEventListener('pointerdown', e => {
    if (state.drawTool !== 'cursor' || e.button !== 0 || !state.loaded || e.target.closest('.pane-label,#candle-story')) return;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = hitTest(x, y);
    if (hit) {
      // enable overlay to own this drag
      overlay.style.pointerEvents = 'auto';
      overlay.setPointerCapture(e.pointerId);
      state.selectedIdx = hit.idx;
      const pt = toPoint(x, y);
      dragging = {
        idx: hit.idx, part: hit.part, startPt: pt,
        orig: JSON.parse(JSON.stringify(state.drawings[hit.idx].points)),
      };
      redrawOverlay();
      syncSettingsBar();
      e.stopPropagation();
      e.preventDefault();
    } else if (state.selectedIdx >= 0) {
      state.selectedIdx = -1;
      redrawOverlay();
      syncSettingsBar();
    }
  }, true);

  window.addEventListener('pointerup', () => {
    if (state.drawTool === 'cursor' && !dragging) overlay.style.pointerEvents = 'none';
  });

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn =>
    btn.addEventListener('click', () => selectTool(btn.dataset.tool)));

  document.getElementById('clear-drawings').addEventListener('click', async () => {
    if (!state.drawings.length) return;
    const yes = await showDialog('Clear drawings?', '<p>Remove drawings for this symbol? You can undo this action.</p>', null, { submit: 'Clear drawings', destructive: true });
    if (!yes) return;
    state.drawings = [];
    state.selectedIdx = -1;
    saveDrawings();
    redrawOverlay();
  });

  document.getElementById('toggle-magnet').addEventListener('click', e => {
    state.magnet = !state.magnet;
    e.currentTarget.classList.toggle('active', state.magnet);
  });

  // ---------- Tool customization (draw-settings bar) ----------
  const dsEl = document.getElementById('draw-settings');
  const DS_COLORS = ['#2962ff', '#26a69a', '#ef5350', '#f7b924', '#e040fb', '#00bcd4', '#ff6d00', '#ffffff'];
  const dsColorsEl = document.getElementById('ds-colors');
  DS_COLORS.forEach(col => {
    const b = document.createElement('button');
    b.className = 'ds-color';
    b.style.background = col;
    b.dataset.color = col;
    b.title = col;
    b.addEventListener('click', () => applyStyle({ color: col }));
    dsColorsEl.appendChild(b);
  });
  document.getElementById('ds-width').addEventListener('change', e => applyStyle({ width: +e.target.value }));
  document.getElementById('ds-style').addEventListener('change', e => applyStyle({ style: e.target.value }));
  document.getElementById('ds-delete').addEventListener('click', () => {
    if (state.selectedIdx >= 0) {
      state.drawings.splice(state.selectedIdx, 1);
      state.selectedIdx = -1;
      saveDrawings();
      redrawOverlay();
    }
    syncSettingsBar();
  });
  document.getElementById('ds-close').addEventListener('click', () => {
    state.selectedIdx = -1;
    redrawOverlay();
    dsEl.classList.add('hidden');
  });

  function applyStyle(props) {
    if (state.selectedIdx >= 0) {
      Object.assign(state.drawings[state.selectedIdx], props);
      saveDrawings();
      redrawOverlay();
    }
    Object.assign(state.toolStyle, props);
    saveSettings();
    syncSettingsBar();
  }

  function syncSettingsBar() {
    const sel = state.selectedIdx >= 0 ? state.drawings[state.selectedIdx] : null;
    const show = sel || state.drawTool !== 'cursor';
    dsEl.classList.toggle('hidden', !show);
    if (!show) return;
    const src = sel || state.toolStyle;
    const names = {
      trendline: 'Trend Line', ray: 'Ray', hline: 'H-Line', vline: 'V-Line', rect: 'Rectangle',
      fib: 'Fibonacci', brush: 'Brush', text: 'Text', ruler: 'Ruler', long: 'Long Position', short: 'Short Position',
      alert: 'Price Alert',
    };
    document.getElementById('ds-title').textContent = names[sel ? sel.type : state.drawTool] || 'Tool';
    const col = src.color || state.toolStyle.color;
    dsColorsEl.querySelectorAll('.ds-color').forEach(x => x.classList.toggle('sel', x.dataset.color === col));
    document.getElementById('ds-width').value = String(src.width || state.toolStyle.width);
    document.getElementById('ds-style').value = src.style || state.toolStyle.style;
  }

  chart.timeScale().subscribeVisibleTimeRangeChange(redrawOverlay);

  // =====================================================================
  //  SMC (Smart Money Concepts) auto-annotations
  // =====================================================================
  let smcAnalysis = null;
  let smcLastRun = 0;
  let smcTimer = null;

  function smcEnabled() { return Object.keys(state.smc).some(k => state.smc[k]); }

  function updateSmc() {
    if (!smcEnabled()) { smcAnalysis = null; redrawOverlay(); return; }
    smcAnalysis = SMC.analyze(state.candles.filter(c => c.time + INTERVALS[state.interval] <= Date.now() / 1000), state.smcOptions);
    smcLastRun = Date.now();
    redrawOverlay();
  }

  function scheduleSmc() {
    if (!smcEnabled()) return;
    if (Date.now() - smcLastRun > 2000) updateSmc();
    else if (!smcTimer) {
      smcTimer = setTimeout(() => { smcTimer = null; updateSmc(); }, 2000);
    }
  }

  // Map any time (even off-scale) to an x coordinate via logical index
  function xForTime(t) {
    const direct = chart.timeScale().timeToCoordinate(t);
    if (direct != null) return direct;
    const c = state.candles;
    if (c.length < 2) return null;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (c[mid].time < t) lo = mid + 1; else hi = mid; }
    const left = t < c[0].time ? 0 : t > c.at(-1).time ? c.length - 1 : Math.max(0, lo - 1);
    const origin = chart.timeScale().timeToCoordinate(c[left].time);
    const logical = (chart.timeScale().coordinateToLogical(origin) ?? left) + (t - c[left].time) / INTERVALS[state.interval];
    return chart.timeScale().logicalToCoordinate(logical);
  }

  function drawSmc() {
    const A = smcAnalysis;
    if (!A || !priceSeries) return;
    const S = state.smc;
    const w = overlay.clientWidth;
    const yOf = p => priceSeries.priceToCoordinate(p);
    const cx = x => x == null ? null : Math.max(-80, Math.min(w + 80, x));
    octx.save();

    // Premium / Discount zones
    if (S.pd && A.range) {
      const x1 = cx(xForTime(A.range.startTime));
      const yH = yOf(A.range.high), yL = yOf(A.range.low), yE = yOf(A.range.eq);
      if (x1 != null && yH != null && yL != null && yE != null) {
        octx.fillStyle = 'rgba(239,83,80,0.06)';
        octx.fillRect(x1, yH, w - x1, yE - yH);
        octx.fillStyle = 'rgba(38,166,154,0.06)';
        octx.fillRect(x1, yE, w - x1, yL - yE);
        octx.strokeStyle = 'rgba(120,123,134,0.8)';
        octx.lineWidth = 1;
        octx.setLineDash([4, 4]);
        octx.beginPath(); octx.moveTo(x1, yE); octx.lineTo(w, yE); octx.stroke();
        octx.setLineDash([]);
        octx.font = 'bold 10px Inter';
        octx.fillStyle = '#ef5350'; octx.fillText('Premium', w - 118, yH + 12);
        octx.fillStyle = '#787b86'; octx.fillText('EQ ' + fmtPrice(A.range.eq), w - 118, yE - 4);
        octx.fillStyle = '#26a69a'; octx.fillText('Discount', w - 118, yL - 5);
      }
    }

    // Order Blocks
    if (S.ob) {
      octx.font = 'bold 9px Inter';
      octx.lineWidth = 1;
      for (const b of A.orderBlocks) {
        const x1 = cx(xForTime(b.startTime));
        const x2 = b.mitigated ? cx(xForTime(b.endTime)) : w;
        const y1 = yOf(b.top), y2 = yOf(b.bottom);
        if (x1 == null || x2 == null || y1 == null || y2 == null || x2 <= x1) continue;
        const alpha = b.mitigated ? 0.05 : 0.13;
        octx.fillStyle = b.dir === 'bull' ? `rgba(38,166,154,${alpha})` : `rgba(239,83,80,${alpha})`;
        octx.fillRect(x1, y1, x2 - x1, y2 - y1);
        octx.strokeStyle = b.dir === 'bull' ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)';
        octx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        octx.fillStyle = b.dir === 'bull' ? '#26a69a' : '#ef5350';
        octx.fillText(b.dir === 'bull' ? 'OB' : 'OB', x1 + 3, y1 + 10);
      }
    }

    // Fair Value Gaps
    if (S.fvg) {
      octx.font = 'bold 9px Inter';
      octx.lineWidth = 1;
      for (const g of A.fvg) {
        const x1 = cx(xForTime(g.startTime));
        const x2 = w;
        const y1 = yOf(g.top), y2 = yOf(g.bottom);
        if (x1 == null || y1 == null || y2 == null || x2 <= x1) continue;
        octx.fillStyle = g.dir === 'bull' ? 'rgba(41,98,255,0.10)' : 'rgba(224,64,251,0.10)';
        octx.fillRect(x1, y1, x2 - x1, y2 - y1);
        octx.fillStyle = g.dir === 'bull' ? '#5b8cff' : '#e040fb';
        octx.fillText('FVG', x1 + 3, (y1 + y2) / 2 + 3);
      }
    }

    // Liquidity: equal highs / equal lows
    if (S.liquidity) {
      octx.font = 'bold 10px Inter';
      octx.lineWidth = 1;
      for (const pool of A.liquidity) {
        const x1 = cx(xForTime(pool.startTime));
        const yv = yOf(pool.level);
        if (x1 == null || yv == null) continue;
        octx.strokeStyle = '#f7b924';
        octx.setLineDash([6, 4]);
        octx.beginPath(); octx.moveTo(x1, yv); octx.lineTo(w, yv); octx.stroke();
        octx.setLineDash([]);
        octx.fillStyle = '#f7b924';
        octx.fillText(pool.kind + ' $$$', x1 + 4, pool.kind === 'EQH' ? yv - 4 : yv + 12);
      }
    }

    // Market structure: BOS / CHoCH
    if (S.structure) {
      octx.font = 'bold 10px Inter';
      octx.lineWidth = 1;
      for (const ev of A.structure) {
        const x1 = cx(xForTime(ev.fromTime));
        const x2 = cx(xForTime(ev.breakTime));
        const yv = yOf(ev.level);
        if (x1 == null || x2 == null || yv == null || x2 <= x1) continue;
        const col = ev.dir === 'bull' ? '#26a69a' : '#ef5350';
        octx.strokeStyle = col;
        octx.beginPath(); octx.moveTo(x1, yv); octx.lineTo(x2, yv); octx.stroke();
        octx.fillStyle = col;
        const label = ev.type;
        const tw = octx.measureText(label).width;
        octx.fillText(label, (x1 + x2) / 2 - tw / 2, ev.dir === 'bull' ? yv - 4 : yv + 12);
      }
    }

    // Swing labels HH/HL/LH/LL
    if (S.swings) {
      octx.font = 'bold 10px Inter';
      const hs = A.swings.highs, ls = A.swings.lows;
      for (let i = 0; i < hs.length; i++) {
        const x = cx(xForTime(hs[i].time)), yv = yOf(hs[i].price);
        if (x == null || yv == null) continue;
        octx.fillStyle = '#f7b924';
        octx.fillText(i > 0 ? (hs[i].price > hs[i - 1].price ? 'HH' : 'LH') : 'H', x - 6, yv - 6);
      }
      for (let i = 0; i < ls.length; i++) {
        const x = cx(xForTime(ls[i].time)), yv = yOf(ls[i].price);
        if (x == null || yv == null) continue;
        octx.fillStyle = '#00bcd4';
        octx.fillText(i > 0 ? (ls[i].price > ls[i - 1].price ? 'HL' : 'LL') : 'L', x - 6, yv + 14);
      }
    }
    octx.restore();
  }

  // =====================================================================
  //  PRICE ALERTS
  // =====================================================================
  let alerts = [];
  let lastTickPrice = null;

  function loadAlerts() {
    alerts = readStorage('chartpro-alerts', [], alertsValid);
  }
  function saveAlerts() {
    writeStorage('chartpro-alerts', alerts);
  }

  function addAlert(price) {
    if (!positive(price) || alerts.length >= 200) { toast('Invalid price or alert limit reached.', 'error'); return; }
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume().catch(() => {});
    alerts.push({ id: crypto.randomUUID(), symbol: state.symbol, price, triggered: false, created: Date.now() });
    saveAlerts();
    renderAlertsList();
    redrawOverlay();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    setSidebarTab('alerts');
  }

  function checkAlerts(price) {
    if (lastTickPrice == null) { lastTickPrice = price; return; }
    let changed = false;
    for (const a of alerts) {
      if (a.triggered || a.symbol !== state.symbol) continue;
      const crossedUp = lastTickPrice < a.price && price >= a.price;
      const crossedDown = lastTickPrice > a.price && price <= a.price;
      if (crossedUp || crossedDown) {
        a.triggered = true;
        a.triggeredAt = Date.now();
        changed = true;
        beep(); toast(`${a.symbol} crossed ${fmtPrice(a.price)}`, 'success');
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(`${a.symbol} alert`, { body: `Price crossed ${fmtPrice(a.price)} (now ${fmtPrice(price)})` }); } catch { /* in-app notice remains available */ }
        }
      }
    }
    lastTickPrice = price;
    if (changed) { saveAlerts(); renderAlertsList(); redrawOverlay(); }
  }

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(t0 => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.15, audioCtx.currentTime + t0);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t0 + 0.2);
        o.start(audioCtx.currentTime + t0);
        o.stop(audioCtx.currentTime + t0 + 0.22);
      });
    } catch (e) {}
  }

  function drawAlertLines() {
    if (!priceSeries) return;
    const w = overlay.clientWidth;
    octx.save();
    octx.font = 'bold 10px Inter';
    for (const a of alerts) {
      if (a.symbol !== state.symbol) continue;
      const y = priceSeries.priceToCoordinate(a.price);
      if (y == null) continue;
      const col = a.triggered ? '#787b86' : '#ffb74d';
      octx.strokeStyle = col;
      octx.setLineDash([8, 4]);
      octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke();
      octx.setLineDash([]);
      octx.fillStyle = col;
      octx.fillText(`🔔 ${fmtPrice(a.price)}${a.triggered ? ' ✓' : ''}`, w - 110, y - 4);
    }
    octx.restore();
  }

  function renderAlertsList() {
    const el = document.getElementById('alerts-list');
    if (!alerts.length) { el.innerHTML = '<div class="alerts-empty">No alerts yet.</div>'; return; }
    el.innerHTML = '';
    for (const a of [...alerts].reverse()) {
      const row = document.createElement('div');
      row.className = 'alert-row' + (a.triggered ? ' done' : '');
      row.innerHTML = `
        <span class="al-sym">${escapeHtml(a.symbol)}</span>
        <span class="al-price">${fmtPrice(a.price)}</span>
        <span class="al-status">${a.triggered ? '✓ fired' : 'armed'}</span>
        <button class="al-del" title="Delete"><i class="fa-solid fa-xmark"></i></button>`;
      row.querySelector('.al-del').setAttribute('aria-label', 'Delete alert');
      row.querySelector('.al-del').addEventListener('click', () => {
        alerts = alerts.filter(x => x.id !== a.id);
        saveAlerts();
        renderAlertsList();
        redrawOverlay();
      });
      el.appendChild(row);
    }
  }

  // =====================================================================
  //  CANDLE STORY — click a candle for buyer/seller context.
  //  Live candle shows a Binance-style buy/sell progress bar that updates
  //  on every WebSocket tick (taker-buy volume vs total volume).
  // =====================================================================
  let csTime = null; // time of the candle currently shown in the story panel
  const csEl = document.getElementById('candle-story');

  function hideCandleStory() {
    csTime = null;
    csEl.classList.add('hidden');
  }
  document.getElementById('cs-close').addEventListener('click', hideCandleStory);

  // ignore "clicks" that were actually pans/drags
  let csDown = null;
  document.getElementById('main-chart-wrap').addEventListener('pointerdown', e => {
    csDown = { x: e.clientX, y: e.clientY };
  }, true);
  document.getElementById('main-chart-wrap').addEventListener('touchstart', e => {
    if (e.touches.length === 1) csDown = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { capture: true, passive: true });
  document.getElementById('main-chart-wrap').addEventListener('pointerup', e => {
    if (csDown && csDown !== 'moved' && Math.hypot(e.clientX - csDown.x, e.clientY - csDown.y) > 6) csDown = 'moved';
  }, true);

  chart.subscribeClick(param => {
    if (state.drawTool !== 'cursor' || param.time == null) return;
    if (csDown === 'moved') { csDown = null; return; }
    csDown = null;
    const bar = state.candles.find(c => c.time === param.time);
    if (!bar) return;
    // toggle off when the same candle is clicked again
    if (csTime === bar.time && !csEl.classList.contains('hidden')) { hideCandleStory(); return; }
    csTime = bar.time;
    renderCandleStory();
  });

  function renderCandleStory() {
    if (csTime == null) return;
    const idx = state.candles.findIndex(c => c.time === csTime);
    if (idx < 0) { hideCandleStory(); return; }
    const c = state.candles[idx];
    const step = TF_SECONDS[state.interval] || barStep();
    const isLive = idx === state.candles.length - 1 && (c.time + step) > Date.now() / 1000;

    const range = Math.max(c.high - c.low, 1e-12);
    const body = Math.abs(c.close - c.open);
    const up = c.close >= c.open;
    const buyVol = Math.min(c.tb || 0, c.volume);
    const sellVol = Math.max(0, c.volume - buyVol);
    const buyPct = c.volume > 0 ? (buyVol / c.volume) * 100 : 50;
    const chgPct = c.open ? ((c.close - c.open) / c.open) * 100 : 0;
    const closeLoc = (c.close - c.low) / range; // 0 = at low, 1 = at high
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    // volume vs the average of up to 20 prior candles
    let volRatio = null;
    if (idx >= 5) {
      const from = Math.max(0, idx - 20);
      const prior = state.candles.slice(from, idx);
      const avg = prior.reduce((s, b) => s + b.volume, 0) / prior.length;
      if (avg > 0) volRatio = c.volume / avg;
    }

    // ---- verdict ----
    let verdict, vClass;
    if (buyPct >= 65)      { verdict = 'Strong buy-side aggression';   vClass = 'buy'; }
    else if (buyPct >= 55) { verdict = 'Buy-side aggression';   vClass = 'buy'; }
    else if (buyPct > 45)  { verdict = up ? 'Balanced — slight buy edge' : 'Balanced — slight sell edge'; vClass = 'flat'; }
    else if (buyPct > 35)  { verdict = 'Sell-side aggression';  vClass = 'sell'; }
    else                   { verdict = 'Strong sell-side aggression';  vClass = 'sell'; }

    // ---- story notes ----
    const notes = [];
    if (isLive) notes.push('Candle still forming. Volume comparisons are provisional.');
    if (closeLoc >= 0.8) notes.push('Close near the high — buyers finished on top.');
    else if (closeLoc <= 0.2) notes.push('Close near the low — sellers finished on top.');
    if (lowerWick > body * 2 && lowerWick > range * 0.35)
      notes.push('Long lower wick — sellers pushed down but buyers absorbed it (rejection of lows).');
    if (upperWick > body * 2 && upperWick > range * 0.35)
      notes.push('Long upper wick — buyers pushed up but sellers faded it (rejection of highs).');
    if (body / range < 0.12) notes.push('Doji-like body — indecision between buyers and sellers.');
    else if (body / range > 0.75) notes.push(up ? 'Full-bodied bullish candle — one-sided buying.' : 'Full-bodied bearish candle — one-sided selling.');
    if (volRatio != null && !isLive) {
      if (volRatio >= 2) notes.push(`Volume spike ×${volRatio.toFixed(1)} vs recent average — strong participation.`);
      else if (volRatio >= 1.4) notes.push('Above-average volume — the move has backing.');
      else if (volRatio <= 0.5) notes.push('Very low volume — weak conviction behind this candle.');
    }
    const prev = state.candles[idx - 1];
    if (prev) {
      if (up && prev.close < prev.open && c.close > prev.open && c.open < prev.close)
        notes.push('Bullish engulfing of the previous candle.');
      if (!up && prev.close > prev.open && c.close < prev.open && c.open > prev.close)
        notes.push('Bearish engulfing of the previous candle.');
    }
    if (!notes.length) notes.push('No standout signals — an ordinary candle.');

    // ---- render ----
    const d = new Date(c.time * 1000);
    document.getElementById('cs-when').textContent =
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) +
      ' · ' + state.interval.toUpperCase();
    const chgEl = document.getElementById('cs-chg');
    chgEl.textContent = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%';
    chgEl.className = chgPct >= 0 ? 'up' : 'down';
    document.getElementById('cs-live-badge').classList.toggle('hidden', !isLive);
    const vd = document.getElementById('cs-verdict');
    vd.textContent = verdict;
    vd.className = 'cs-verdict ' + vClass;
    document.getElementById('cs-buy-label').textContent = `Taker buy ${buyPct.toFixed(1)}%`;
    document.getElementById('cs-sell-label').textContent = `${(100 - buyPct).toFixed(1)}% taker sell`;
    document.getElementById('cs-buy-fill').style.width = buyPct.toFixed(2) + '%';
    document.getElementById('cs-o').textContent = fmtPrice(c.open);
    document.getElementById('cs-h').textContent = fmtPrice(c.high);
    document.getElementById('cs-l').textContent = fmtPrice(c.low);
    document.getElementById('cs-c').textContent = fmtPrice(c.close);
    document.getElementById('cs-body').textContent = ((body / range) * 100).toFixed(0) + '% of range';
    document.getElementById('cs-vol').textContent = fmtCompact(c.volume) + (volRatio != null ? ` (×${volRatio.toFixed(1)})` : '');
    document.getElementById('cs-bv').textContent = fmtCompact(buyVol);
    document.getElementById('cs-sv').textContent = fmtCompact(sellVol);
    const notesEl = document.getElementById('cs-notes');
    notesEl.innerHTML = '';
    for (const n of notes) {
      const li = document.createElement('li');
      li.textContent = n;
      notesEl.appendChild(li);
    }
    csEl.classList.remove('hidden');
  }

  // =====================================================================
  //  INTRADAY: session boxes, key levels, volume profile, countdown
  // =====================================================================
  const SESSIONS = [
    { name: 'Tokyo', zone: 'Asia/Tokyo', start: 9, end: 17, color: '38,166,154' },
    { name: 'London', zone: 'Europe/London', start: 8, end: 17, color: '247,185,36' },
    { name: 'New York', zone: 'America/New_York', start: 8, end: 17, color: '224,64,251' },
  ].map(s => ({ ...s, formatter: new Intl.DateTimeFormat('en-CA', { timeZone: s.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }));
  let sessionCache = { version: -1, boxes: [] };
  const INTRADAY_TFS = ['1m', '5m', '15m', '1h'];

  function drawSessions() {
    if (!state.intraday.sessions || !priceSeries || !INTRADAY_TFS.includes(state.interval)) return;
    if (sessionCache.version !== dataVersion) {
      const boxes = new Map();
      for (const s of SESSIONS) for (const bar of state.candles) {
        const parts = Object.fromEntries(s.formatter.formatToParts(bar.time * 1000).map(p => [p.type, p.value]));
        const hour = +parts.hour + +parts.minute / 60;
        if (hour < s.start || hour >= s.end) continue;
        const key = `${s.name}-${parts.year}-${parts.month}-${parts.day}`;
        const box = boxes.get(key) || { name: s.name, color: s.color, start: bar.time, end: bar.time, hi: -Infinity, lo: Infinity };
        box.end = bar.time + INTERVALS[state.interval]; box.hi = Math.max(box.hi, bar.high); box.lo = Math.min(box.lo, bar.low); boxes.set(key, box);
      }
      sessionCache = { version: dataVersion, boxes: [...boxes.values()].slice(-45) };
    }
    octx.save(); octx.font = 'bold 10px Inter';
    for (const b of sessionCache.boxes) {
      const x1 = xForTime(b.start), x2 = xForTime(b.end), y1 = priceSeries.priceToCoordinate(b.hi), y2 = priceSeries.priceToCoordinate(b.lo);
      if ([x1, x2, y1, y2].some(v => v == null) || x2 < 0 || x1 > overlay.clientWidth) continue;
      octx.fillStyle = `rgba(${b.color},.07)`; octx.fillRect(x1, y1, x2 - x1, y2 - y1);
      octx.strokeStyle = `rgba(${b.color},.35)`; octx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      octx.fillStyle = `rgba(${b.color},.9)`; octx.fillText(b.name, x1 + 3, y1 + 12);
    }
    octx.restore();
  }

  // ---- PDH / PDL / PWH / PWL ----
  let keyLevels = null; // { pdh, pdl, pwh, pwl }
  async function loadKeyLevels() {
    const task = levelsTask.begin(), symbol = state.symbol;
    keyLevels = null;
    try {
      const [days, weeks] = await Promise.all([
        apiFetch(`/api/v3/klines?symbol=${symbol}&interval=1d&limit=3`, { signal: task.signal }),
        apiFetch(`/api/v3/klines?symbol=${symbol}&interval=1w&limit=3`, { signal: task.signal }),
      ]);
      if (!task.current() || symbol !== state.symbol) return;
      // second-to-last = previous completed period
      const pd = days.length >= 2 ? days[days.length - 2] : null;
      const pw = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
      keyLevels = {
        pdh: pd ? +pd[2] : null, pdl: pd ? +pd[3] : null,
        pwh: pw ? +pw[2] : null, pwl: pw ? +pw[3] : null,
      };
      redrawOverlay();
    } catch (e) { /* non-fatal */ }
  }

  function drawKeyLevels() {
    if (!keyLevels || !priceSeries) return;
    const w = overlay.clientWidth;
    const defs = [];
    if (state.intraday.pdlevels) {
      defs.push(['PDH', keyLevels.pdh, '#26a69a'], ['PDL', keyLevels.pdl, '#ef5350']);
    }
    if (state.intraday.pwlevels) {
      defs.push(['PWH', keyLevels.pwh, '#00bcd4'], ['PWL', keyLevels.pwl, '#ff6d00']);
    }
    if (!defs.length) return;
    octx.save();
    octx.font = 'bold 10px Inter';
    for (const [label, price, col] of defs) {
      if (price == null) continue;
      const y = priceSeries.priceToCoordinate(price);
      if (y == null) continue;
      octx.strokeStyle = col;
      octx.setLineDash([10, 5]);
      octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke();
      octx.setLineDash([]);
      octx.fillStyle = col;
      octx.fillText(`${label} ${fmtPrice(price)}`, 8, y - 4);
    }
    octx.restore();
  }

  // ---- Volume Profile (POC / VAH / VAL) ----
  let profileCache = null;
  function drawVProfile() {
    if (!state.intraday.vprofile || !priceSeries) return;
    const c = state.candles;
    if (c.length < 10) return;
    if (!profileCache || profileCache.version !== dataVersion) {
    const BINS = 48;
    let min = Infinity, max = -Infinity;
    for (const b of c) { min = Math.min(min, b.low); max = Math.max(max, b.high); }
    if (!(max > min)) return;
    const bins = new Array(BINS).fill(0);
    const binOf = p => Math.min(BINS - 1, Math.max(0, Math.floor((p - min) / (max - min) * BINS)));
    for (const b of c) {
      const tp = (b.high + b.low + b.close) / 3;
      bins[binOf(tp)] += b.volume;
    }
    const total = bins.reduce((s, v) => s + v, 0);
    if (!total) return;
    let poc = 0;
    for (let i = 1; i < BINS; i++) if (bins[i] > bins[poc]) poc = i;
    // 70% value area expanding from POC
    let covered = bins[poc], lo = poc, hi = poc;
    while (covered < total * 0.7 && (lo > 0 || hi < BINS - 1)) {
      const nextLo = lo > 0 ? bins[lo - 1] : -1;
      const nextHi = hi < BINS - 1 ? bins[hi + 1] : -1;
      if (nextHi >= nextLo) { hi++; covered += bins[hi]; }
      else { lo--; covered += bins[lo]; }
    }
      profileCache = { version: dataVersion, BINS, min, max, bins, poc, lo, hi };
    }
    const { BINS, min, max, bins, poc, lo, hi } = profileCache;
    const w = overlay.clientWidth;
    const maxBin = bins[poc];
    const priceOfBin = i => min + (i + 0.5) / BINS * (max - min);
    octx.save();
    // histogram bars (right-aligned)
    for (let i = 0; i < BINS; i++) {
      if (!bins[i]) continue;
      const y1 = priceSeries.priceToCoordinate(min + (i + 1) / BINS * (max - min));
      const y2 = priceSeries.priceToCoordinate(min + i / BINS * (max - min));
      if (y1 == null || y2 == null) continue;
      const bw = bins[i] / maxBin * w * 0.18;
      const inVA = i >= lo && i <= hi;
      octx.fillStyle = i === poc ? 'rgba(255,152,0,0.5)'
        : inVA ? 'rgba(41,98,255,0.28)' : 'rgba(120,123,134,0.18)';
      octx.fillRect(w - bw, y1, bw, Math.max(1, y2 - y1 - 1));
    }
    // POC / VAH / VAL lines
    const lines = [
      ['POC', priceOfBin(poc), '#ff9800', []],
      ['VAH', min + (hi + 1) / BINS * (max - min), '#787b86', [4, 4]],
      ['VAL', min + lo / BINS * (max - min), '#787b86', [4, 4]],
    ];
    octx.font = 'bold 9px Inter';
    for (const [label, price, col, dash] of lines) {
      const y = priceSeries.priceToCoordinate(price);
      if (y == null) continue;
      octx.strokeStyle = col;
      octx.setLineDash(dash);
      octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke();
      octx.setLineDash([]);
      octx.fillStyle = col;
      octx.fillText(label, w - w * 0.18 - 28, y + 3);
    }
    octx.restore();
  }

  // ---- Candle countdown (badge under the live price on the price axis) ----
  const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  let countdownText = '';
  let levelDay = Math.floor(Date.now() / 86400000);
  setInterval(() => {
    const day = Math.floor(Date.now() / 86400000);
    if (day !== levelDay) { levelDay = day; loadKeyLevels(); }
    if (state.loaded && lastMarketEvent && Date.now() - lastMarketEvent > 35000) setConn('stale', 'Stale market data');
    const el = document.getElementById('candle-countdown');
    if (!state.intraday.countdown || !state.candles.length) {
      el.style.display = 'none';
      if (countdownText) { countdownText = ''; redrawOverlay(); }
      return;
    }
    el.style.display = '';
    const step = TF_SECONDS[state.interval] || barStep();
    const last = state.candles[state.candles.length - 1];
    let rem = Math.max(0, Math.floor(last.time + step - Date.now() / 1000));
    const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60), ss = rem % 60;
    const p = n => String(n).padStart(2, '0');
    countdownText = `${hh > 0 ? p(hh) + ':' : ''}${p(mm)}:${p(ss)}`;
    el.innerHTML = `<i class="fa-regular fa-clock"></i> ${countdownText}`;
    schedulePaint(); // cached analytics; one canvas frame
  }, 1000);

  // Countdown badge painted right below the last-price label on the price scale
  function drawCountdown() {
    if (!state.intraday.countdown || !countdownText || !priceSeries || !state.candles.length) return;
    const last = state.candles[state.candles.length - 1];
    const y = priceSeries.priceToCoordinate(last.close);
    if (y == null) return;
    const w = overlay.clientWidth;
    let psw = 0;
    try { psw = chart.priceScale('right').width(); } catch (e) {}
    const bw = psw > 30 ? psw : 64;
    const x = w - bw;
    const up = last.close >= last.open;
    const bh = 15;
    octx.save();
    octx.fillStyle = up ? '#26a69a' : '#ef5350';
    octx.fillRect(x, y + 9, bw, bh);
    octx.fillStyle = '#fff';
    octx.font = 'bold 10px Inter';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText(countdownText, x + bw / 2, y + 9 + bh / 2 + 0.5);
    octx.restore();
  }

  // =====================================================================
  //  SIDEBAR: tabs, order book, time & sales
  // =====================================================================
  let currentTab = 'watchlist';
  let bookWs = null, tapeWs = null;

  function setSidebarTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.sb-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('watchlist').classList.toggle('hidden', tab !== 'watchlist');
    document.getElementById('orderbook').classList.toggle('hidden', tab !== 'book');
    document.getElementById('tape').classList.toggle('hidden', tab !== 'tape');
    document.getElementById('alerts-panel').classList.toggle('hidden', tab !== 'alerts');
    if (tab === 'book') connectBook(); else disconnectBook();
    if (tab === 'tape') connectTape(); else disconnectTape();
    if (tab === 'alerts') renderAlertsList();
  }
  document.querySelectorAll('.sb-tab').forEach(b =>
    b.addEventListener('click', () => setSidebarTab(b.dataset.tab)));

  // ---- Sidebar visibility toggle (responsive) ----
  // Defaults come from CSS media queries: visible on desktop/tablet,
  // hidden (overlay drawer) at ≤900px. The button flips the state.
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  function sidebarIsVisible() {
    return document.getElementById('right-sidebar').getBoundingClientRect().width > 0;
  }
  sidebarToggleBtn.addEventListener('click', () => {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const show = !sidebarIsVisible();
    if (narrow) {
      document.body.classList.toggle('sidebar-open', show);
      document.body.classList.remove('sidebar-hidden');
    } else {
      document.body.classList.toggle('sidebar-hidden', !show);
      document.body.classList.remove('sidebar-open');
    }
    sidebarToggleBtn.classList.toggle('active', show);
    if (show) {
      if (currentTab === 'book') connectBook();
      if (currentTab === 'tape') connectTape();
    } else {
      disconnectBook();
      disconnectTape();
    }
    requestAnimationFrame(() => { resizeMain(); adjustPaneHeights(); });
  });
  // keep drawer state sane when crossing the 900px breakpoint
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
    document.body.classList.remove('sidebar-open', 'sidebar-hidden');
    sidebarToggleBtn.classList.remove('active');
    requestAnimationFrame(() => { resizeMain(); adjustPaneHeights(); });
  });

  function disconnectBook() { bookWs?.close(); bookWs = null; }
  function disconnectTape() { tapeWs?.close(); tapeWs = null; }
  function connectBook() {
    disconnectBook();
    if (!sidebarIsVisible() || currentTab !== 'book') return;
    const symbol = state.symbol;
    document.getElementById('ob-mid').textContent = 'Connecting…';
    bookWs = new MarketStream(`/ws/${symbol.toLowerCase()}@depth20`, {
      onData: d => { if (symbol === state.symbol && d.bids?.length && d.asks?.length) renderBook(d.bids, d.asks); },
      onStatus: status => { if (status !== 'live') document.getElementById('ob-mid').textContent = status + ' · book'; },
    });
  }

  function renderBook(bids, asks) {
    const mid = (+bids[0][0] + +asks[0][0]) / 2;
    document.getElementById('ob-mid').textContent = fmtPrice(mid);
    const N = 20;
    const build = (levels, el, isAsk) => {
      let cum = 0;
      const rows = levels.slice(0, N).map(([p, q]) => { cum += +q; return { p: +p, q: +q, cum }; });
      const maxCum = cum || 1;
      if (isAsk) rows.reverse();
      el.innerHTML = rows.map(r => `
        <div class="ob-row">
          <span class="ob-bar ${isAsk ? 'ask' : 'bid'}" style="width:${r.cum / maxCum * 100}%"></span>
          <span class="ob-p ${isAsk ? 'down' : 'up'}">${fmtPrice(r.p)}</span>
          <span class="ob-q">${fmtQty(r.q)}</span>
          <span class="ob-t">${fmtQty(r.cum)}</span>
        </div>`).join('');
    };
    build(asks, document.getElementById('ob-asks'), true);
    build(bids, document.getElementById('ob-bids'), false);
  }

  function connectTape() {
    disconnectTape();
    if (!sidebarIsVisible() || currentTab !== 'tape') return;
    const symbol = state.symbol, rowsEl = document.getElementById('tape-rows'); rowsEl.innerHTML = '';
    let pending = [], frame;
    tapeWs = new MarketStream(`/ws/${symbol.toLowerCase()}@aggTrade`, {
      staleMs: 90000,
      onData: t => {
        if (symbol !== state.symbol || !positive(+t.p) || !positive(+t.q)) return;
        pending.push(t); pending = pending.slice(-80);
        if (!frame) frame = requestAnimationFrame(() => {
          frame = null; if (symbol !== state.symbol || currentTab !== 'tape') { pending = []; return; }
          const frag = document.createDocumentFragment();
          for (const t of pending.reverse()) {
            const quote = +t.p * +t.q, dollars = ['USDT', 'USDC', 'FDUSD'].includes(assetInfo(symbol).quoteAsset);
            const row = document.createElement('div'); row.className = 'tape-row' + (dollars && quote >= 100000 ? ' whale' : dollars && quote >= 25000 ? ' big' : '');
            row.innerHTML = `<span class="tp-time">${new Date(t.T).toLocaleTimeString('en-GB', { timeZone: 'UTC' })}</span><span class="tp-price ${t.m ? 'down' : 'up'}">${fmtPrice(+t.p)}</span><span class="tp-qty">${fmtCompact(quote)}</span>`; frag.append(row);
          }
          pending = []; rowsEl.prepend(frag); while (rowsEl.children.length > 80) rowsEl.lastChild.remove();
        });
      },
      onStatus: status => { document.getElementById('tape-status').textContent = `${status} · ${assetInfo(symbol).quoteAsset} notional · UTC`; },
    });
  }

  function fmtQty(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(4);
  }

  // =====================================================================
  //  POSITION SIZE CALCULATOR
  // =====================================================================
  const calcModal = document.getElementById('calc-modal');
  document.getElementById('open-calc').addEventListener('click', () => {
    calcModal.classList.remove('hidden');
    document.getElementById('intraday-menu').classList.remove('open');
    calcUpdate();
  });
  document.getElementById('calc-close').addEventListener('click', () => calcModal.classList.add('hidden'));
  calcModal.addEventListener('click', e => { if (e.target === calcModal) calcModal.classList.add('hidden'); });
  document.getElementById('calc-use-price').addEventListener('click', () => {
    const last = state.candles[state.candles.length - 1];
    if (!last) return;
    document.getElementById('calc-entry').value = last.close;
    if (!document.getElementById('calc-stop').value) {
      document.getElementById('calc-stop').value = (last.close * 0.99).toFixed(4);
    }
    calcUpdate();
  });
  ['calc-account', 'calc-risk', 'calc-entry', 'calc-stop', 'calc-lev'].forEach(id =>
    document.getElementById(id).addEventListener('input', calcUpdate));

  function calcUpdate() {
    const acct = +document.getElementById('calc-account').value;
    const riskPct = +document.getElementById('calc-risk').value;
    const entry = +document.getElementById('calc-entry').value;
    const stop = +document.getElementById('calc-stop').value;
    const lev = +document.getElementById('calc-lev').value;
    const valid = [acct, riskPct, entry, stop, lev].every(positive) && riskPct <= 100 && lev >= 1 && lev <= 125 && entry !== stop;
    const riskAmt = acct * riskPct / 100, dist = Math.abs(entry - stop);
    const step = state.market.stepSize || 0.00000001;
    const qty = valid ? Math.floor(riskAmt / dist / step) * step : 0, value = qty * entry;
    const { baseAsset, quoteAsset } = state.market;
    document.getElementById('calc-riskamt').textContent = valid ? fmtPrice(riskAmt) + ' ' + quoteAsset : '—';
    document.getElementById('calc-qty').textContent = qty ? priceFormat(qty) + ' ' + baseAsset : '—';
    document.getElementById('calc-value').textContent = qty ? fmtPrice(value) + ' ' + quoteAsset : '—';
    document.getElementById('calc-margin').textContent = qty ? fmtPrice(value / lev) + ' ' + quoteAsset : '—';
    document.getElementById('calc-feedback').textContent = !valid ? 'Enter positive values, different entry and stop, risk ≤100%, and leverage 1–125.' : value / lev > acct ? 'Warning: required margin exceeds account balance.' : 'Estimate excludes fees, slippage and liquidation. Leverage does not reduce stop-loss risk.';
    document.getElementById('calc-account-label').textContent = 'Account size (' + quoteAsset + ')';
  }

  function applyUrlParams() {
    const q = new URLSearchParams(location.search);
    const sym = q.get('symbol');
    const tf = q.get('tf');
    if (sym && symbolValid(sym.toUpperCase())) state.symbol = sym.toUpperCase();
    else if (sym) toast('Invalid market URL parameter ignored.', 'error');
    if (tf && Object.hasOwn(INTERVALS, tf)) state.interval = tf;
    else if (tf) toast('Unsupported timeframe ignored.', 'error');
    if (sym || tf) {
      document.getElementById('symbol-label').textContent = state.symbol;
      document.querySelectorAll('.tf-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tf === state.interval));
    }
  }

  // ---------- Settings persistence ----------
  function saveSettings() {
    try {
      writeStorage('chartpro-settings', {
        symbol: state.symbol,
        interval: state.interval,
        chartType: state.chartType,
        indicators: state.indicators,
        smc: state.smc,
        intraday: state.intraday,
        toolStyle: state.toolStyle, version: 2, params: state.params, colors: state.colors, smcOptions: state.smcOptions, vwapAnchor: state.vwapAnchor,
      });
    } catch (e) {}
  }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('chartpro-settings'));
      if (!s) return;
      if (symbolValid(s.symbol)) state.symbol = s.symbol;
      if (Object.hasOwn(INTERVALS, s.interval)) state.interval = s.interval;
      if (['candles','bars','line','area'].includes(s.chartType)) state.chartType = s.chartType;
      if (s.indicators && typeof s.indicators === 'object') state.indicators = Object.fromEntries(Object.entries(s.indicators).filter(([k,v]) => (Object.hasOwn(overlayDefs,k) || Object.hasOwn(paneDefs,k)) && typeof v === 'boolean'));
      if (s.smc && typeof s.smc === 'object') state.smc = Object.fromEntries(Object.entries(s.smc).filter(([k,v]) => ['structure','ob','fvg','liquidity','swings','pd'].includes(k) && typeof v === 'boolean'));
      if (s.intraday) {
        const it = { ...s.intraday };
        // migrate old combined "levels" toggle to the split PD / PW toggles
        if (it.levels) { it.pdlevels = true; it.pwlevels = true; }
        delete it.levels;
        state.intraday = { countdown: true, ...it };
      }
      if (s.toolStyle && /^#[a-f\d]{6}$/i.test(s.toolStyle.color) && positive(s.toolStyle.width) && s.toolStyle.width <= 4 && ['solid','dashed','dotted'].includes(s.toolStyle.style)) state.toolStyle = s.toolStyle;
      if (s.params && typeof s.params === 'object') state.params = validateParams(s.params);
      if (s.colors && typeof s.colors === 'object') state.colors = Object.fromEntries(Object.entries(s.colors).filter(([k,v]) => Object.hasOwn(overlayDefs,k) || Object.hasOwn(paneDefs,k)).filter(([,v]) => /^#[a-f\d]{6}$/i.test(v)));
      if (s.smcOptions && Number.isInteger(s.smcOptions.swingLen) && s.smcOptions.swingLen >= 2 && s.smcOptions.swingLen <= 50 && Number.isFinite(s.smcOptions.fvgMinPct) && s.smcOptions.fvgMinPct >= 0 && s.smcOptions.fvgMinPct <= 10) state.smcOptions = s.smcOptions;
      if (['session','loaded'].includes(s.vwapAnchor)) state.vwapAnchor = s.vwapAnchor;
      // reflect in UI
      document.getElementById('symbol-label').textContent = state.symbol;
      document.querySelectorAll('.tf-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tf === state.interval));
      document.querySelectorAll('.ct-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.ct === state.chartType));
      document.querySelectorAll('#indicators-menu input[data-ind]').forEach(cb => {
        cb.checked = !!state.indicators[cb.dataset.ind];
      });
      document.querySelectorAll('#smc-menu input[data-smc]').forEach(cb => {
        cb.checked = !!state.smc[cb.dataset.smc];
      });
      document.querySelectorAll('#intraday-menu input[data-intra]').forEach(cb => {
        cb.checked = !!state.intraday[cb.dataset.intra] || (cb.dataset.intra === 'cvd' && !!state.indicators.cvd);
      });
    } catch (e) {}
  }

  // ---------- Symbol switching ----------
  function switchSymbol(sym) {
    if (!symbolValid(sym) || sym === state.symbol) return;
    state.symbol = sym; state.market = assetInfo(sym);
    const url = new URL(location.href); url.searchParams.set('symbol', sym); url.searchParams.set('tf', state.interval); history.replaceState(null, '', url);
    state.selectedIdx = -1;
    lastTickPrice = null;
    loadDrawings();
    document.getElementById('symbol-label').textContent = sym;
    document.querySelectorAll('.wl-row').forEach(r =>
      r.classList.toggle('active', r.dataset.sym === sym));
    loadCandles();
    load24hStats();
    loadKeyLevels();
    if (currentTab === 'book') connectBook();
    if (currentTab === 'tape') connectTape();
    saveSettings();
    document.title = `${sym} — ChartPro`;
  }

  // ---------- Symbol search modal ----------
  let allSymbols = null;
  const modal = document.getElementById('symbol-modal');
  const searchInput = document.getElementById('symbol-search-input');
  const resultsEl = document.getElementById('symbol-results');

  async function openModal() {
    modal.classList.remove('hidden');
    searchInput.value = '';
    searchInput.focus();
    if (!allSymbols) {
      resultsEl.innerHTML = '<div class="sr-empty">Loading symbols…</div>';
      try {
        allSymbols = (await getMarkets()).map(s => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
      } catch (e) {
        allSymbols = WATCHLIST.map(([s]) => ({ symbol: s, base: s.replace('USDT', '') }));
      }
    }
    renderResults('');
  }
  function closeModal() { modal.classList.add('hidden'); }

  function renderResults(q) {
    if (!allSymbols) return;
    q = q.trim().toUpperCase();
    const list = allSymbols
      .filter(s => !q || s.symbol.includes(q) || s.base.includes(q))
      .slice(0, 50);
    if (!list.length) {
      resultsEl.innerHTML = '<div class="sr-empty">No spot pairs found.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    for (const s of list) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'sr-row';
      row.innerHTML = `<span class="sr-sym">${escapeHtml(s.base)}<span class="sr-name"> / ${escapeHtml(s.quote || 'USDT')}</span></span><span class="sr-name">${escapeHtml(s.symbol)}</span>`;
      row.addEventListener('click', () => { closeModal(); switchSymbol(s.symbol); });
      resultsEl.appendChild(row);
    }
  }

  document.getElementById('symbol-button').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  searchInput.addEventListener('input', () => renderResults(searchInput.value));

  // ---------- Toolbar wiring ----------
  document.querySelectorAll('.tf-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.interval = btn.dataset.tf;
      const url = new URL(location.href); url.searchParams.set('tf', state.interval); history.replaceState(null, '', url);
      loadCandles();
      saveSettings();
    }));

  document.querySelectorAll('.ct-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ct-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.chartType = btn.dataset.ct;
      createPriceSeries();
      redrawOverlay();
      saveSettings();
    }));

  const indMenu = document.getElementById('indicators-menu');
  const smcMenu = document.getElementById('smc-menu');
  function wireDropdown(btnId, menu) {
    const btn = document.getElementById(btnId);
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', menu.id);
    new MutationObserver(() => btn.setAttribute('aria-expanded', String(menu.classList.contains('open')))).observe(menu, { attributes: true, attributeFilter: ['class'] });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'));
      if (!wasOpen) {
        // menus are position:fixed (so the scrollable toolbar can't clip
        // them) — anchor below the button, kept inside the viewport
        const r = btn.getBoundingClientRect();
        menu.style.top = (r.bottom + 6) + 'px';
        menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 270)) + 'px';
        menu.classList.add('open');
      }
    });
  }
  const intraMenu = document.getElementById('intraday-menu');
  wireDropdown('indicators-button', indMenu);
  wireDropdown('smc-button', smcMenu);
  wireDropdown('intraday-button', intraMenu);
  document.addEventListener('click', e => {
    if (!indMenu.contains(e.target)) indMenu.classList.remove('open');
    if (!smcMenu.contains(e.target)) smcMenu.classList.remove('open');
    if (!intraMenu.contains(e.target)) intraMenu.classList.remove('open');
  });

  intraMenu.querySelectorAll('input[data-intra]').forEach(cb =>
    cb.addEventListener('change', () => {
      const key = cb.dataset.intra;
      if (key === 'cvd') {
        state.indicators.cvd = cb.checked;
        refreshIndicators();
      } else {
        state.intraday[key] = cb.checked;
        if ((key === 'pdlevels' || key === 'pwlevels') && cb.checked && !keyLevels) loadKeyLevels();
        redrawOverlay();
      }
      saveSettings();
    }));
  indMenu.querySelectorAll('input[data-ind]').forEach(cb =>
    cb.addEventListener('change', () => {
      state.indicators[cb.dataset.ind] = cb.checked;
      refreshIndicators();
      saveSettings();
    }));

  smcMenu.querySelectorAll('input[data-smc]').forEach(cb =>
    cb.addEventListener('change', () => {
      state.smc[cb.dataset.smc] = cb.checked;
      updateSmc();
      saveSettings();
    }));
  function setAllSmc(on) {
    smcMenu.querySelectorAll('input[data-smc]').forEach(cb => {
      cb.checked = on;
      state.smc[cb.dataset.smc] = on;
    });
    updateSmc();
    saveSettings();
  }
  document.getElementById('smc-all-on').addEventListener('click', () => setAllSmc(true));
  document.getElementById('smc-all-off').addEventListener('click', () => setAllSmc(false));

  // ---------- Status / formatting ----------
  function setConn(cls, text) {
    const el = document.getElementById('conn-status');
    el.className = cls;
    el.innerHTML = `<i class="fa-solid fa-circle"></i> ${text}`;
  }

  function fmtPrice(v) { return priceFormat(v); }
  function fmtCompact(v) { return compact(v); }

  // ---------- Resize handling ----------
  function resizeMain() {
    const r = mainEl.getBoundingClientRect();
    chart.resize(r.width, r.height);
    resizeOverlay(); positionPaneLabels();
  }
  window.addEventListener('resize', () => { resizeMain(); adjustPaneHeights(); });
  new ResizeObserver(() => resizeMain()).observe(mainEl);

  document.getElementById('tz-label').textContent =
    'Chart & tape: UTC · Sessions: local market time';


  function validateParams(params) {
    const out = {};
    for (const [key, values] of Object.entries(params)) {
      if (!Object.hasOwn(overlayDefs, key) && !Object.hasOwn(paneDefs, key)) continue;
      if (!Array.isArray(values) || !values.length || values.length > 4 || !values.every(v => positive(v) && v <= 500)) continue;
      if (key === 'macd' && values[0] >= values[1]) continue;
      if (key === 'psar') { if (values.length === 2 && values[0] <= values[1] && values[1] <= 1) out[key] = values; continue; }
      if (values.every((v, i) => (['bb','keltner','supertrend'].includes(key) && i === 1) || Number.isInteger(v))) out[key] = values;
    }
    return out;
  }
  document.getElementById('retry-data').onclick = () => { loadCandles(); load24hStats(); loadKeyLevels(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.loaded && Date.now() - lastMarketEvent > 30000) connectWs(); });
  window.addEventListener('pagehide', () => { selection.cancel(); statsTask.cancel(); levelsTask.cancel(); state.ws?.close(); state.wlWs?.close(); disconnectBook(); disconnectTape(); });
  window.addEventListener('pageshow', e => { if (e.persisted) { loadCandles(); connectWatchlistWs(); } });
  window.addEventListener('pointercancel', () => { dragging = null; if (brushing) saveDrawings(); brushing = false; updateOverlayPointer(); });

  // ---------- Init ----------
  loadSettings();
  applyUrlParams();
  createPriceSeries();
  buildWatchlist();
  loadDrawings();
  loadAlerts();
  loadCandles();
  load24hStats();
  loadKeyLevels();
  connectWatchlistWs();
  updateOverlayPointer();
  renderAlertsList();
  setInterval(load24hStats, 30000);
  document.title = `${state.symbol} — ChartPro`;


})();
