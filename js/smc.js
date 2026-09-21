/* ============ SMC (Smart Money Concepts) detection engine ============
   Pure functions over candle arrays: { time, open, high, low, close, volume }
   Detects: swing points, market structure (BOS/CHoCH), order blocks,
   fair value gaps, equal highs/lows (liquidity), premium/discount range. */

export const SMC = (() => {

  /* ---- Swing highs/lows (fractal pivots with `len` bars each side) ---- */
  function swings(candles, len = 5) {
    const highs = [], lows = [];
    for (let i = len; i < candles.length - len; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= len; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high < candles[i + j].high) isH = false;
        if (candles[i].low >= candles[i - j].low || candles[i].low > candles[i + j].low) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push({ idx: i, time: candles[i].time, price: candles[i].high });
      if (isL) lows.push({ idx: i, time: candles[i].time, price: candles[i].low });
    }
    return { highs, lows };
  }

  /* ---- Market structure: BOS (continuation) & CHoCH (reversal) ----
     Walks candles; when close breaks the latest confirmed swing high/low,
     emits an event. Trend flips on CHoCH. */
  function structure(candles, sw, len = 5) {
    const events = []; // { type:'BOS'|'CHoCH', dir:'bull'|'bear', level, fromTime, breakTime }
    const pivots = [
      ...sw.highs.map(h => ({ ...h, kind: 'H' })),
      ...sw.lows.map(l => ({ ...l, kind: 'L' })),
    ].sort((a, b) => a.idx - b.idx);
    if (!pivots.length) return events;

    let trend = 0; // 0 unknown, 1 bull, -1 bear
    let lastHigh = null, lastLow = null;

    let p = 0;
    for (let i = 0; i < candles.length; i++) {
      // register pivots confirmed by bar i (pivot needs len bars after it)
      while (p < pivots.length && pivots[p].idx + len <= i) {
        if (pivots[p].kind === 'H') lastHigh = pivots[p];
        else lastLow = pivots[p];
        p++;
      }
      const c = candles[i];
      if (lastHigh && c.close > lastHigh.price) {
        const type = trend === -1 ? 'CHoCH' : 'BOS';
        events.push({ type, dir: 'bull', level: lastHigh.price, fromTime: lastHigh.time, fromIdx: lastHigh.idx, breakTime: c.time, breakIdx: i });
        trend = 1;
        lastHigh = null;
      }
      if (lastLow && c.close < lastLow.price) {
        const type = trend === 1 ? 'CHoCH' : 'BOS';
        events.push({ type, dir: 'bear', level: lastLow.price, fromTime: lastLow.time, fromIdx: lastLow.idx, breakTime: c.time, breakIdx: i });
        trend = -1;
        lastLow = null;
      }
    }
    return events;
  }

  /* ---- Order Blocks ----
     Last opposite candle before a structure-breaking impulse.
     Bullish OB = last down candle before a bullish BOS/CHoCH move.
     Zone extends right until price closes through it (mitigated). */
  function orderBlocks(candles, events, maxBlocks = 8) {
    const blocks = [];
    for (const ev of events) {
      // search backwards from break bar for the last opposite candle
      let obIdx = -1;
      for (let i = ev.breakIdx; i >= Math.max(0, ev.breakIdx - 20); i--) {
        const c = candles[i];
        if (ev.dir === 'bull' && c.close < c.open) { obIdx = i; break; }
        if (ev.dir === 'bear' && c.close > c.open) { obIdx = i; break; }
      }
      if (obIdx < 0) continue;
      const ob = candles[obIdx];
      const top = Math.max(ob.open, ob.close, ev.dir === 'bull' ? ob.high : -Infinity);
      const bottom = Math.min(ob.open, ob.close, ev.dir === 'bear' ? ob.low : Infinity);
      // find mitigation (close through the far side)
      let endIdx = candles.length - 1, mitigated = false;
      for (let i = ev.breakIdx + 1; i < candles.length; i++) {
        if (ev.dir === 'bull' && candles[i].close < bottom) { endIdx = i; mitigated = true; break; }
        if (ev.dir === 'bear' && candles[i].close > top) { endIdx = i; mitigated = true; break; }
      }
      blocks.push({
        dir: ev.dir, top, bottom,
        startTime: ob.time, endTime: candles[endIdx].time,
        startIdx: obIdx, mitigated,
      });
    }
    // dedupe overlapping blocks (keep latest), limit count, prefer unmitigated
    const seen = [];
    const out = [];
    for (let i = blocks.length - 1; i >= 0 && out.length < maxBlocks; i--) {
      const b = blocks[i];
      if (seen.some(s => s.dir === b.dir && Math.abs(s.startIdx - b.startIdx) < 3)) continue;
      seen.push(b);
      out.push(b);
    }
    return out.reverse();
  }

  /* ---- Fair Value Gaps (3-candle imbalance) ----
     Bull FVG: candle[i-2].high < candle[i].low  (gap up)
     Bear FVG: candle[i-2].low  > candle[i].high (gap down)
     Zone shrinks/closes as price fills it. */
  function fvg(candles, minSizePct = 0.05, maxGaps = 15) {
    const gaps = [];
    for (let i = 2; i < candles.length; i++) {
      const a = candles[i - 2], c = candles[i];
      const mid = candles[i - 1];
      if (a.high < c.low) {
        const size = (c.low - a.high) / a.high * 100;
        if (size >= minSizePct) gaps.push({ dir: 'bull', top: c.low, bottom: a.high, startTime: mid.time, startIdx: i - 1 });
      } else if (a.low > c.high) {
        const size = (a.low - c.high) / c.high * 100;
        if (size >= minSizePct) gaps.push({ dir: 'bear', top: a.low, bottom: c.high, startTime: mid.time, startIdx: i - 1 });
      }
    }
    // track fill status
    const out = [];
    for (const g of gaps) {
      let endIdx = candles.length - 1, filled = false;
      for (let i = g.startIdx + 2; i < candles.length; i++) {
        if (g.dir === 'bull' && candles[i].low <= g.bottom) { endIdx = i; filled = true; break; }
        if (g.dir === 'bear' && candles[i].high >= g.top) { endIdx = i; filled = true; break; }
      }
      if (!filled) out.push({ ...g, endTime: candles[endIdx].time, filled });
    }
    return out.slice(-maxGaps);
  }

  /* ---- Equal highs / equal lows (liquidity pools) ----
     Two+ swing highs within tolerance -> EQH; swing lows -> EQL. */
  function liquidity(candles, sw, tolPct = 0.1, maxPools = 8) {
    const pools = [];
    const tol = p => p * tolPct / 100;
    const grab = (pts, kind) => {
      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = i + 1; j < pts.length && j <= i + 3; j++) {
          if (Math.abs(pts[i].price - pts[j].price) <= tol(pts[i].price)) {
            // check not already swept (price beyond level after j)
            const level = kind === 'EQH' ? Math.max(pts[i].price, pts[j].price) : Math.min(pts[i].price, pts[j].price);
            let swept = false;
            for (let k = pts[j].idx + 1; k < candles.length; k++) {
              if (kind === 'EQH' && candles[k].high > level * (1 + tolPct / 100)) { swept = true; break; }
              if (kind === 'EQL' && candles[k].low < level * (1 - tolPct / 100)) { swept = true; break; }
            }
            if (!swept) pools.push({ kind, level, startTime: pts[i].time, endTime: candles[candles.length - 1].time });
            i = j; // skip
            break;
          }
        }
      }
    };
    grab(sw.highs, 'EQH');
    grab(sw.lows, 'EQL');
    return pools.slice(-maxPools);
  }

  /* ---- Premium / Discount range from last major swing leg ---- */
  function premiumDiscount(candles, sw) {
    if (!sw.highs.length || !sw.lows.length) return null;
    // use highest high & lowest low of the last N swings
    const lastHighs = sw.highs.slice(-4);
    const lastLows = sw.lows.slice(-4);
    const hi = lastHighs.reduce((m, p) => p.price > m.price ? p : m);
    const lo = lastLows.reduce((m, p) => p.price < m.price ? p : m);
    const startTime = Math.min(hi.time, lo.time);
    return {
      high: hi.price, low: lo.price,
      eq: (hi.price + lo.price) / 2,
      startTime,
      endTime: candles[candles.length - 1].time,
    };
  }

  /* ---- Run everything ---- */
  function analyze(candles, opts = {}) {
    if (candles.length < 30) return null;
    const sw = swings(candles, opts.swingLen || 5);
    const events = structure(candles, sw, opts.swingLen || 5);
    return {
      swings: { highs: sw.highs.slice(-20), lows: sw.lows.slice(-20) },
      structure: events.slice(-8),
      orderBlocks: orderBlocks(candles, events),
      fvg: fvg(candles, opts.fvgMinPct ?? 0.05),
      liquidity: liquidity(candles, sw),
      range: premiumDiscount(candles, sw),
    };
  }

  return { analyze, swings, structure, orderBlocks, fvg, liquidity, premiumDiscount };
})();
