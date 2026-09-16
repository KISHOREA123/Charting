/** Shared validation, formatting, persistence and concurrency primitives. */
export const INTERVALS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 });
export const symbolValid = s => typeof s === 'string' && /^[A-Z0-9]{3,24}$/.test(s);
export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const positive = v => finite(v) && v > 0;
export const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
export function readStorage(key, fallback, validate = () => true) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value != null && validate(value) ? value : fallback; }
  catch { return fallback; }
}
export function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { globalThis.dispatchEvent?.(new CustomEvent('storage-error')); return false; }
}
export function priceFormat(v, precision) {
  const value = Number(v);
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', precision == null
    ? { maximumSignificantDigits: 8 }
    : { minimumFractionDigits: Math.min(precision, 8), maximumFractionDigits: Math.min(precision, 12) }).format(value);
}
export function compact(v) {
  return finite(Number(v)) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : '—';
}
export function assetInfo(symbol) {
  const quoteAsset = ['FDUSD', 'USDT', 'USDC', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY'].find(q => symbol.endsWith(q)) || 'QUOTE';
  return { symbol, quoteAsset, baseAsset: symbol.endsWith(quoteAsset) ? symbol.slice(0, -quoteAsset.length) : symbol };
}
export function precisionFor(tick) {
  if (!positive(Number(tick))) return 8;
  const s = Number(tick).toFixed(12).replace(/0+$/, '');
  return s.includes('.') ? s.split('.')[1].length : 0;
}
export function normalizeCandles(raw) {
  if (!Array.isArray(raw)) throw new Error('Invalid candle response');
  return mergeCandles([], raw.map(k => ({ time: Number(k[0]) / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], tb: +k[9], closed: Number(k[6]) < Date.now() })));
}
export function candleValid(c) {
  return c && positive(c.time) && Number.isInteger(c.time) && ['open', 'high', 'low', 'close'].every(k => positive(c[k])) && finite(c.volume) && c.volume >= 0 && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close) && (!('tb' in c) || (finite(c.tb) && c.tb >= 0 && c.tb <= c.volume));
}
export function mergeCandles(previous, incoming, limit = 3000) {
  const byTime = new Map(previous.map(c => [c.time, c]));
  for (const c of incoming) { if (!candleValid(c)) throw new Error('Invalid market candle'); byTime.set(c.time, c); }
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
}
export class LatestTask {
  id = 0;
  controller;
  begin() { this.controller?.abort(); this.controller = new AbortController(); const id = ++this.id; return { signal: this.controller.signal, current: () => id === this.id && !this.controller.signal.aborted }; }
  cancel() { this.id++; this.controller?.abort(); }
}
export class History {
  constructor(value = [], limit = 50) { this.limit = limit; this.reset(value); }
  reset(value) { this.entries = [JSON.stringify(value)]; this.index = 0; }
  push(value) { const json = JSON.stringify(value); if (json === this.entries[this.index]) return; this.entries.splice(this.index + 1); this.entries.push(json); if (this.entries.length > this.limit) this.entries.shift(); this.index = this.entries.length - 1; }
  undo() { if (this.index > 0) this.index--; return JSON.parse(this.entries[this.index]); }
  redo() { if (this.index < this.entries.length - 1) this.index++; return JSON.parse(this.entries[this.index]); }
}
export function drawingsValid(items) {
  const counts = { hline: 1, vline: 1, text: 1, trendline: 2, ray: 2, rect: 2, fib: 2, ruler: 2, long: 3, short: 3, brush: 1 };
  return Array.isArray(items) && items.length <= 300 && items.every(d => d && d.type in counts && Array.isArray(d.points) && d.points.length >= counts[d.type] && d.points.length <= 5000 && d.points.every(p => positive(p.time) && positive(p.price)) && (!d.color || /^#[a-f\d]{6}$/i.test(d.color)) && (!d.width || (positive(d.width) && d.width <= 4)) && (!d.style || ['solid', 'dashed', 'dotted'].includes(d.style)) && (!d.text || (typeof d.text === 'string' && d.text.length <= 1000)));
}
export function alertsValid(items) {
  return Array.isArray(items) && items.length <= 200 && items.every(a => a && symbolValid(a.symbol) && positive(a.price) && ['string', 'number'].includes(typeof a.id) && typeof a.triggered === 'boolean');
}
export function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csv(rows) {
  return rows.map(row => row.map(v => { let s = String(v ?? ''); if (/^[=+@\-\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }).join(',')).join('\r\n');
}
export function periodValid(p) { if (!Number.isInteger(p) || p < 1 || p > 500) throw new RangeError('Period must be an integer from 1 to 500'); return p; }
