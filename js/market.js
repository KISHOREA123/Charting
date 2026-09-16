import { assetInfo, symbolValid, normalizeCandles, INTERVALS } from './core.js';
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const WSS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
let host = 0, lastRequest = 0, cooldown = 0, metadata;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A single scheduling lane limits request bursts across all page consumers.
let lane = Promise.resolve();
export async function apiFetch(path, { signal } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reservation = lane.then(async () => { await sleep(Math.max(0, lastRequest + 170 - Date.now(), cooldown - Date.now())); signal?.throwIfAborted(); lastRequest = Date.now(); });
    lane = reservation.catch(() => {}); await reservation;
    const timeout = AbortSignal.timeout(12000);
    try {
      const res = await fetch(HOSTS[host] + path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.status === 429 || res.status === 418) {
        cooldown = Date.now() + Math.min(120000, Math.max(10000, Number(res.headers.get('Retry-After') || 30) * 1000));
        throw Object.assign(new Error('Exchange rate limit. Requests paused; retry shortly.'), { noRetry: true });
      }
      if (!res.ok) throw Object.assign(new Error(res.status === 451 ? 'Market data unavailable in this region.' : `Market data request failed (${res.status})`), { noRetry: res.status >= 400 && res.status < 500 && res.status !== 451 });
      return await res.json();
    } catch (e) {
      if (signal?.aborted || e.noRetry || attempt === 2) throw e;
      host = (host + 1) % HOSTS.length;
      await sleep(350 * 2 ** attempt);
    }
  }
}
export async function getMarkets(options) {
  if (!metadata) metadata = apiFetch('/api/v3/exchangeInfo?permissions=SPOT', options).then(d => {
    if (!Array.isArray(d.symbols)) throw new Error('Invalid exchange metadata');
    return d.symbols.filter(s => s.status === 'TRADING' && symbolValid(s.symbol)).map(s => ({ ...assetInfo(s.symbol), ...s, tickSize: Number(s.filters?.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || 0.00000001), stepSize: Number(s.filters?.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 0.00000001) }));
  }).catch(e => { metadata = null; throw e; });
  return metadata;
}
export async function getCandles(symbol, interval, { signal, startTime, limit = 1000 } = {}) {
  if (!symbolValid(symbol) || !(interval in INTERVALS)) throw new Error('Unsupported market or timeframe');
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startTime != null) q.set('startTime', String(startTime * 1000));
  return normalizeCandles(await apiFetch('/api/v3/klines?' + q, { signal }));
}
/** Owned WebSocket with guarded timers, heartbeat freshness and finite backoff. */
export class MarketStream {
  constructor(path, { onData, onOpen = () => {}, onStatus = () => {}, staleMs = 30000 } = {}) {
    Object.assign(this, { path, onData, onOpen, onStatus, staleMs, attempts: 0, stopped: false, lastEvent: 0, host: 0 });
    this.connect();
    this.health = setInterval(() => {
      if (!this.stopped && this.socket?.readyState === 1 && Date.now() - this.lastEvent > staleMs) { onStatus('stale'); this.socket.close(); }
    }, 5000);
  }
  connect() {
    if (this.stopped) return;
    this.onStatus('connecting');
    const ws = this.socket = new WebSocket(WSS[this.host] + this.path);
    const current = () => !this.stopped && ws === this.socket;
    const deadline = setTimeout(() => { if (current() && ws.readyState !== 1) ws.close(); }, 12000);
    ws.onopen = () => { if (!current()) return; clearTimeout(deadline); this.lastEvent = Date.now(); this.attempts = 0; this.onOpen(); };
    ws.onmessage = e => {
      if (!current()) return;
      try { const data = JSON.parse(e.data); this.lastEvent = Date.now(); this.onData(data); this.onStatus('live'); }
      catch (error) { console.warn('Market event rejected:', error.message); }
    };
    ws.onclose = () => {
      clearTimeout(deadline); if (!current()) return;
      this.onStatus('offline'); this.host = (this.host + 1) % WSS.length;
      this.timer = setTimeout(() => { if (current()) this.connect(); }, Math.min(30000, 1000 * 2 ** this.attempts++) + Math.random() * 500);
    };
    ws.onerror = () => ws.close();
  }
  close() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.health); this.socket?.close(); }
}
