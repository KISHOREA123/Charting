import Decimal from 'decimal.js';
import { symbolValid, positive, assetInfo } from './core.js';
const D = value => new Decimal(value);
const optionalPrice = value => value == null || value === '' ? null : Number(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validateTrade(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid trade record.');
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!symbolValid(symbol)) throw new Error('Enter a valid market symbol (for example BTCUSDT).');
  if (!['LONG', 'SHORT'].includes(input.side)) throw new Error('Select LONG or SHORT.');
  const entry = Number(input.entry), quantity = Number(input.quantity), stop = optionalPrice(input.stop), target = optionalPrice(input.target);
  if (![entry, quantity].every(v => positive(v) && v <= 1e15)) throw new Error('Entry and quantity must be positive finite numbers, at most 10¹⁵.');
  if ([stop, target].some(v => v != null && !positive(v))) throw new Error('Stop and target must be positive or blank.');
  if (stop != null && (input.side === 'LONG' ? stop >= entry : stop <= entry)) throw new Error('Stop must be below entry for LONG, above entry for SHORT.');
  if (target != null && (input.side === 'LONG' ? target <= entry : target >= entry)) throw new Error('Target must be above entry for LONG, below entry for SHORT.');
  const fees = Number(input.fees ?? 0), funding = Number(input.funding ?? 0);
  if (!Number.isFinite(fees) || fees < 0 || !Number.isFinite(funding) || Math.abs(funding) > 1e15 || fees > 1e15) throw new Error('Fees must be nonnegative. Funding must be finite (negative for credit).');
  if (!validDate(input.opened_at)) throw new Error('Enter a valid opening date.');
  const quoteAsset = String(input.quoteAsset || assetInfo(symbol).quoteAsset).toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(quoteAsset)) throw new Error('Enter a valid quote currency.');
  const exits = input.exits || [];
  if (!Array.isArray(exits) || exits.length > 500) throw new Error('Invalid exit records (maximum 500).');
  const normalized = exits.map(e => {
    if (!e || !positive(Number(e.price)) || !positive(Number(e.quantity)) || !Number.isFinite(Number(e.fees ?? 0)) || Number(e.fees ?? 0) < 0 || !validDate(e.at) || Date.parse(e.at) < Date.parse(input.opened_at)) throw new Error('Exit price/quantity must be positive, fees nonnegative, and exit time after opening.');
    return { price: Number(e.price), quantity: Number(e.quantity), fees: Number(e.fees ?? 0), at: new Date(e.at).toISOString() };
  }).sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
  const exited = normalized.reduce((sum,e) => sum.plus(e.quantity), D(0));
  if (exited.gt(quantity)) throw new Error('Total exit quantity exceeds the position size.');
  const attachment = input.attachment || '';
  if (typeof attachment !== 'string' || attachment.length > 3e6 || attachment && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(attachment)) throw new Error('Attachment must be PNG, JPEG or WebP under 2 MB.');
  const id = input.id || crypto.randomUUID();
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid trade identifier.');
  if (String(input.notes || '').length > 10000 || String(input.setup || '').length > 80) throw new Error('Notes or setup tag are too long.');
  return { version: 2, id, revision: Number.isInteger(input.revision) ? input.revision : 0, symbol, side: input.side, quoteAsset, entry, quantity, stop, target, fees, funding, exits: normalized, opened_at: new Date(input.opened_at).toISOString(), notes: String(input.notes || ''), setup: String(input.setup || '').trim(), attachment };
}
export function tradeResult(t) {
  const closedQty = t.exits.reduce((s,e) => s.plus(e.quantity), D(0));
  const remaining = D(t.quantity).minus(closedQty);
  const gross = t.exits.reduce((s,e) => s.plus(D(e.price).minus(t.entry).times(t.side === 'LONG' ? 1 : -1).times(e.quantity)), D(0));
  const allocatedCosts = D(t.fees).plus(t.funding).times(closedQty).div(t.quantity);
  const exitFees = t.exits.reduce((s,e) => s.plus(e.fees), D(0));
  const net = gross.minus(allocatedCosts).minus(exitFees);
  const status = closedQty.isZero() ? 'OPEN' : remaining.gt(0) ? 'PARTIAL' : net.gt(0) ? 'WIN' : net.lt(0) ? 'LOSS' : 'BREAKEVEN';
  const risk = t.stop != null ? D(t.entry).minus(t.stop).abs().times(t.quantity) : null;
  return { remaining: remaining.toNumber(), closedQty: closedQty.toNumber(), gross: gross.toNumber(), net: net.toNumber(), status, r: risk && !risk.isZero() ? net.div(risk).toNumber() : null, closed: remaining.isZero() };
}
export function journalStats(trades) {
  const results = trades.map(tradeResult), closed = results.filter(r => r.closed), wins = closed.filter(r => r.net > 0), losses = closed.filter(r => r.net < 0);
  const sum = list => list.reduce((s,r) => s.plus(r.net), D(0)).toNumber();
  const winSum = sum(wins), lossSum = Math.abs(sum(losses));
  const events = trades.flatMap(t => t.exits.map(e => ({ time: Date.parse(e.at), pnl: D(e.price).minus(t.entry).times(t.side === 'LONG' ? 1 : -1).times(e.quantity).minus(e.fees).minus(D(t.fees).plus(t.funding).times(e.quantity).div(t.quantity)).toNumber() }))).sort((a,b) => a.time - b.time);
  let cumulative = D(0), peak = D(0), drawdown = D(0);
  const equity = events.map(e => { cumulative = cumulative.plus(e.pnl); peak = Decimal.max(peak,cumulative); drawdown = Decimal.max(drawdown,peak.minus(cumulative)); return { time:e.time, value:cumulative.toNumber() }; });
  return { total:trades.length, open:results.filter(r=>!r.closed).length, winrate:closed.length?wins.length/closed.length*100:null, net:sum(results), avgWin:wins.length?winSum/wins.length:0, avgLoss:losses.length?-lossSum/losses.length:0, expectancy:closed.length?sum(closed)/closed.length:null, profitFactor:lossSum?winSum/lossSum:winSum?Infinity:null, drawdown:drawdown.toNumber(), equity };
}
export function importTrades(value) {
  const rows = Array.isArray(value) ? value : value?.trades || value?.data;
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Expected a trade list with at most 10,000 records.');
  const seen = new Set();
  return rows.map(row => {
    const t = validateTrade({ ...row, stop:row.stop || null, target:row.target || null, exits:row.exits || (Number(row.exit)>0?[{price:Number(row.exit),quantity:Number(row.quantity),fees:0,at:row.closed_at || row.opened_at}]:[]) });
    if (seen.has(t.id)) throw new Error('Duplicate IDs in import.'); seen.add(t.id); return t;
  });
}
