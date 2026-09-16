import { periodValid } from './core.js';
/* ============ Technical indicator calculations ============
   All functions take an array of candles:
   { time, open, high, low, close, volume }
   and return arrays of { time, value } (or richer objects). */

export const Indicators = (() => {

  function sma(candles, period, source = 'close') {
    periodValid(period);
    const out = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i][source];
      if (i >= period) sum -= candles[i - period][source];
      if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
    }
    return out;
  }

  function ema(candles, period, source = 'close') {
    periodValid(period);
    const out = [];
    const k = 2 / (period + 1);
    let prev;
    for (let i = 0; i < candles.length; i++) {
      const price = candles[i][source];
      if (i === period - 1) {
        // seed with SMA
        let s = 0;
        for (let j = 0; j < period; j++) s += candles[i - j][source];
        prev = s / period;
        out.push({ time: candles[i].time, value: prev });
      } else if (i >= period) {
        prev = price * k + prev * (1 - k);
        out.push({ time: candles[i].time, value: prev });
      }
    }
    return out;
  }

  function bollinger(candles, period = 20, mult = 2) {
    periodValid(period);
    const upper = [], middle = [], lower = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[i - j].close;
      const mean = sum / period;
      let variance = 0;
      for (let j = 0; j < period; j++) {
        const d = candles[i - j].close - mean;
        variance += d * d;
      }
      const sd = Math.sqrt(variance / period);
      const t = candles[i].time;
      middle.push({ time: t, value: mean });
      upper.push({ time: t, value: mean + mult * sd });
      lower.push({ time: t, value: mean - mult * sd });
    }
    return { upper, middle, lower };
  }

  /* VWAP: UTC session reset by default; anchor="loaded" uses loaded history */
  function vwap(candles, anchor = 'session') {
    const out = [];
    let cumPV = 0, cumV = 0, day = null;
    for (const c of candles) {
      const nextDay = Math.floor(c.time / 86400);
      if (anchor === 'session' && day !== nextDay) { cumPV = 0; cumV = 0; day = nextDay; }
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * c.volume;
      cumV += c.volume;
      out.push({ time: c.time, value: cumV > 0 ? cumPV / cumV : typical });
    }
    return out;
  }

  /* Wilder's RSI */
  function rsi(candles, period = 14) {
    periodValid(period);
    const out = [];
    if (candles.length <= period) return out;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    out.push({ time: candles[period].time, value: rsiVal(avgGain, avgLoss) });
    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push({ time: candles[i].time, value: rsiVal(avgGain, avgLoss) });
    }
    return out;
  }
  function rsiVal(g, l) {
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  }

  function macd(candles, fast = 12, slow = 26, signalP = 9) {
    [fast, slow, signalP].forEach(periodValid); if (fast >= slow) throw new RangeError('MACD fast period must be less than slow period');
    const fastE = ema(candles, fast);
    const slowE = ema(candles, slow);
    // align by time — slowE starts later
    const offset = fastE.length - slowE.length;
    const macdLine = [];
    for (let i = 0; i < slowE.length; i++) {
      macdLine.push({ time: slowE[i].time, value: fastE[i + offset].value - slowE[i].value });
    }
    // signal = EMA of macd line
    const signal = [];
    const k = 2 / (signalP + 1);
    let prev;
    for (let i = 0; i < macdLine.length; i++) {
      if (i === signalP - 1) {
        let s = 0;
        for (let j = 0; j < signalP; j++) s += macdLine[i - j].value;
        prev = s / signalP;
        signal.push({ time: macdLine[i].time, value: prev });
      } else if (i >= signalP) {
        prev = macdLine[i].value * k + prev * (1 - k);
        signal.push({ time: macdLine[i].time, value: prev });
      }
    }
    const histOffset = macdLine.length - signal.length;
    const histogram = signal.map((s, i) => {
      const m = macdLine[i + histOffset].value;
      const h = m - s.value;
      return {
        time: s.time,
        value: h,
        color: h >= 0 ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)'
      };
    });
    return { macdLine, signal, histogram };
  }

  function wma(candles, period, source = 'close') {
    periodValid(period);
    const out = [];
    const denom = period * (period + 1) / 2;
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[i - j][source] * (period - j);
      out.push({ time: candles[i].time, value: sum / denom });
    }
    return out;
  }

  /* Stochastic %K / %D */
  function stochastic(candles, kP = 14, kSmooth = 3, dP = 3) {
    [kP, kSmooth, dP].forEach(periodValid);
    const rawK = [];
    for (let i = kP - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < kP; j++) {
        hh = Math.max(hh, candles[i - j].high);
        ll = Math.min(ll, candles[i - j].low);
      }
      rawK.push({ time: candles[i].time, value: hh === ll ? 50 : (candles[i].close - ll) / (hh - ll) * 100 });
    }
    const k = smoothLine(rawK, kSmooth);
    const d = smoothLine(k, dP);
    return { k, d };
  }

  function smoothLine(line, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < line.length; i++) {
      sum += line[i].value;
      if (i >= period) sum -= line[i - period].value;
      if (i >= period - 1) out.push({ time: line[i].time, value: sum / period });
    }
    return out;
  }

  /* Stochastic RSI */
  function stochRsi(candles, rsiP = 14, stochP = 14, kSmooth = 3, dSmooth = 3) {
    [rsiP, stochP, kSmooth, dSmooth].forEach(periodValid);
    const r = rsi(candles, rsiP);
    const rawK = [];
    for (let i = stochP - 1; i < r.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < stochP; j++) {
        hh = Math.max(hh, r[i - j].value);
        ll = Math.min(ll, r[i - j].value);
      }
      rawK.push({ time: r[i].time, value: hh === ll ? 50 : (r[i].value - ll) / (hh - ll) * 100 });
    }
    const k = smoothLine(rawK, kSmooth);
    const d = smoothLine(k, dSmooth);
    return { k, d };
  }

  /* True range helper */
  function trueRanges(candles) {
    const tr = candles.length ? [candles[0].high - candles[0].low] : [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return tr;
  }

  /* Wilder-smoothed ATR */
  function atr(candles, period = 14) {
    periodValid(period);
    const tr = trueRanges(candles);
    const out = [];
    if (candles.length < period) return out;
    let a = 0;
    for (let i = 0; i < period; i++) a += tr[i];
    a /= period;
    out.push({ time: candles[period - 1].time, value: a });
    for (let i = period; i < candles.length; i++) {
      a = (a * (period - 1) + tr[i]) / period;
      out.push({ time: candles[i].time, value: a });
    }
    return out;
  }

  /* ADX with +DI / -DI */
  function adx(candles, period = 14) {
    periodValid(period);
    if (candles.length < period * 2) return { adxLine: [], plusDI: [], minusDI: [] };
    const tr = trueRanges(candles);
    const plusDM = [0], minusDM = [0];
    for (let i = 1; i < candles.length; i++) {
      const up = candles[i].high - candles[i - 1].high;
      const dn = candles[i - 1].low - candles[i].low;
      plusDM.push(up > dn && up > 0 ? up : 0);
      minusDM.push(dn > up && dn > 0 ? dn : 0);
    }
    let sTR = 0, sP = 0, sM = 0;
    for (let i = 1; i <= period; i++) { sTR += tr[i]; sP += plusDM[i]; sM += minusDM[i]; }
    const plusDI = [], minusDI = [], dx = [];
    for (let i = period; i < candles.length; i++) {
      if (i > period) {
        sTR = sTR - sTR / period + tr[i];
        sP = sP - sP / period + plusDM[i];
        sM = sM - sM / period + minusDM[i];
      }
      const pdi = sTR ? sP / sTR * 100 : 0;
      const mdi = sTR ? sM / sTR * 100 : 0;
      plusDI.push({ time: candles[i].time, value: pdi });
      minusDI.push({ time: candles[i].time, value: mdi });
      dx.push({ time: candles[i].time, value: (pdi + mdi) ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0 });
    }
    const adxLine = [];
    if (dx.length >= period) {
      let a = 0;
      for (let i = 0; i < period; i++) a += dx[i].value;
      a /= period;
      adxLine.push({ time: dx[period - 1].time, value: a });
      for (let i = period; i < dx.length; i++) {
        a = (a * (period - 1) + dx[i].value) / period;
        adxLine.push({ time: dx[i].time, value: a });
      }
    }
    return { adxLine, plusDI, minusDI };
  }

  /* Commodity Channel Index */
  function cci(candles, period = 20) {
    periodValid(period);
    const out = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      const tps = [];
      for (let j = 0; j < period; j++) {
        const c = candles[i - j];
        const tp = (c.high + c.low + c.close) / 3;
        tps.push(tp);
        sum += tp;
      }
      const mean = sum / period;
      let dev = 0;
      for (const tp of tps) dev += Math.abs(tp - mean);
      dev /= period;
      out.push({ time: candles[i].time, value: dev ? (tps[0] - mean) / (0.015 * dev) : 0 });
    }
    return out;
  }

  /* Money Flow Index */
  function mfi(candles, period = 14) {
    periodValid(period);
    const out = [];
    if (candles.length <= period) return out;
    const tp = candles.map(c => (c.high + c.low + c.close) / 3);
    for (let i = period; i < candles.length; i++) {
      let pos = 0, neg = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const flow = tp[j] * candles[j].volume;
        if (tp[j] > tp[j - 1]) pos += flow;
        else if (tp[j] < tp[j - 1]) neg += flow;
      }
      out.push({ time: candles[i].time, value: neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg) });
    }
    return out;
  }

  /* On-Balance Volume */
  function obv(candles) {
    const out = [];
    let v = 0;
    for (let i = 0; i < candles.length; i++) {
      if (i > 0) {
        if (candles[i].close > candles[i - 1].close) v += candles[i].volume;
        else if (candles[i].close < candles[i - 1].close) v -= candles[i].volume;
      }
      out.push({ time: candles[i].time, value: v });
    }
    return out;
  }

  /* Williams %R */
  function williamsR(candles, period = 14) {
    periodValid(period);
    const out = [];
    for (let i = period - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < period; j++) {
        hh = Math.max(hh, candles[i - j].high);
        ll = Math.min(ll, candles[i - j].low);
      }
      out.push({ time: candles[i].time, value: hh === ll ? -50 : (hh - candles[i].close) / (hh - ll) * -100 });
    }
    return out;
  }

  /* Ichimoku Cloud (standard 9/26/52) — spans shifted forward 26 bars */
  function ichimoku(candles, conv = 9, base = 26, spanB = 52, disp = 26) {
    [conv, base, spanB, disp].forEach(periodValid);
    const mid = (i, p) => {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < p; j++) {
        hh = Math.max(hh, candles[i - j].high);
        ll = Math.min(ll, candles[i - j].low);
      }
      return (hh + ll) / 2;
    };
    const tenkan = [], kijun = [], senkouA = [], senkouB = [], chikou = [];
    // interval in seconds for projecting future times
    const step = candles.length > 1 ? candles[1].time - candles[0].time : 60;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].time;
      if (i >= conv - 1) tenkan.push({ time: t, value: mid(i, conv) });
      if (i >= base - 1) kijun.push({ time: t, value: mid(i, base) });
      if (i >= base - 1 && i >= conv - 1) {
        senkouA.push({ time: t + disp * step, value: (mid(i, conv) + mid(i, base)) / 2 });
      }
      if (i >= spanB - 1) senkouB.push({ time: t + disp * step, value: mid(i, spanB) });
      if (i + disp < candles.length) chikou.push({ time: t, value: candles[i + disp].close });
    }
    return { tenkan, kijun, senkouA, senkouB, chikou };
  }

  /* Parabolic SAR */
  function psar(candles, step = 0.02, maxStep = 0.2) {
    const out = [];
    if (candles.length < 2) return out;
    let up = candles[1].close >= candles[0].close;
    let sar = up ? candles[0].low : candles[0].high;
    let ep = up ? candles[0].high : candles[0].low;
    let af = step;
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      sar = sar + af * (ep - sar);
      if (up) {
        sar = Math.min(sar, candles[i - 1].low, i > 1 ? candles[i - 2].low : candles[i - 1].low);
        if (c.low < sar) { up = false; sar = ep; ep = c.low; af = step; }
        else if (c.high > ep) { ep = c.high; af = Math.min(af + step, maxStep); }
      } else {
        sar = Math.max(sar, candles[i - 1].high, i > 1 ? candles[i - 2].high : candles[i - 1].high);
        if (c.high > sar) { up = true; sar = ep; ep = c.high; af = step; }
        else if (c.low < ep) { ep = c.low; af = Math.min(af + step, maxStep); }
      }
      out.push({ time: c.time, value: sar, color: up ? '#26a69a' : '#ef5350' });
    }
    return out;
  }

  /* SuperTrend */
  function supertrend(candles, period = 10, mult = 3) {
    periodValid(period);
    const a = atr(candles, period);
    if (!a.length) return [];
    const offset = candles.length - a.length;
    const out = [];
    let upper = 0, lower = 0, trendUp = true, st = 0;
    for (let i = 0; i < a.length; i++) {
      const c = candles[i + offset];
      const prev = candles[i + offset - 1] || c;
      const mid = (c.high + c.low) / 2;
      const bu = mid + mult * a[i].value;
      const bl = mid - mult * a[i].value;
      upper = (i === 0 || bu < upper || prev.close > upper) ? bu : upper;
      lower = (i === 0 || bl > lower || prev.close < lower) ? bl : lower;
      if (i === 0) { trendUp = c.close >= mid; }
      else if (trendUp && c.close < lower) trendUp = false;
      else if (!trendUp && c.close > upper) trendUp = true;
      st = trendUp ? lower : upper;
      out.push({ time: c.time, value: st, color: trendUp ? '#26a69a' : '#ef5350' });
    }
    return out;
  }

  /* Donchian Channels */
  function donchian(candles, period = 20) {
    periodValid(period);
    const upper = [], lower = [], middle = [];
    for (let i = period - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < period; j++) {
        hh = Math.max(hh, candles[i - j].high);
        ll = Math.min(ll, candles[i - j].low);
      }
      const t = candles[i].time;
      upper.push({ time: t, value: hh });
      lower.push({ time: t, value: ll });
      middle.push({ time: t, value: (hh + ll) / 2 });
    }
    return { upper, lower, middle };
  }

  /* Keltner Channels */
  function keltner(candles, period = 20, mult = 2) {
    periodValid(period);
    const mid = ema(candles, period);
    const a = atr(candles, period);
    if (!mid.length || !a.length) return { upper: [], middle: [], lower: [] };
    // align by time
    const aMap = new Map(a.map(x => [x.time, x.value]));
    const upper = [], lower = [], middle = [];
    for (const m of mid) {
      const av = aMap.get(m.time);
      if (av === undefined) continue;
      middle.push(m);
      upper.push({ time: m.time, value: m.value + mult * av });
      lower.push({ time: m.time, value: m.value - mult * av });
    }
    return { upper, middle, lower };
  }

  return {
    sma, ema, wma, bollinger, vwap, rsi, macd,
    stochastic, stochRsi, atr, adx, cci, mfi, obv,
    williamsR, ichimoku, psar, supertrend, donchian, keltner,
  };
})();
