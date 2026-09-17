import { Indicators } from './indicators.js';
import { INTERVALS } from './core.js';
export class MetricCache {
  entries = new Map();
  get(symbol, tf, now = Date.now()) { const item = this.entries.get(`${symbol}:${tf}`); return item && item.expires > now ? item : null; }
  set(symbol, tf, candles, now = Date.now()) {
    const closed = candles.filter(c => c.time + INTERVALS[tf] <= now / 1000);
    const rsi = Indicators.rsi(closed,14).at(-1)?.value ?? null;
    const recent = closed.slice(-21), avg = recent.slice(0,-1).reduce((s,c) => s+c.volume,0) / Math.max(1,recent.length-1);
    const item = { rsi, spike: recent.length === 21 && avg > 0 ? recent.at(-1).volume/avg : null, asOf: closed.at(-1)?.time, expires: (Math.floor(now/(INTERVALS[tf]*1000))+1)*INTERVALS[tf]*1000+1500 };
    this.entries.set(`${symbol}:${tf}`,item); return item;
  }
  clear() { this.entries.clear(); }
}
export function heuristic(row, metrics) {
  if (!metrics) return { label:'PENDING', className:'sig-neutral', description:'Waiting for fresh closed-candle RSI on every timeframe.' };
  let score = row.chg > 5 ? 2 : row.chg > 1 ? 1 : row.chg < -5 ? -2 : row.chg < -1 ? -1 : 0;
  score += metrics.r60 < 30 ? 2 : metrics.r60 < 42 ? 1 : metrics.r60 > 70 ? -2 : metrics.r60 > 58 ? -1 : 0;
  score += metrics.r15 < 25 ? 1 : metrics.r15 > 75 ? -1 : 0;
  if (metrics.spike >= 2) score += row.chg >= 0 ? 1 : -1;
  return {label:score>=3?'BULLISH +':score>=1?'BULLISH':score<=-3?'BEARISH +':score<=-1?'BEARISH':'NEUTRAL',className:score>0?'sig-buy':score<0?'sig-sell':'sig-neutral',description:`Heuristic score ${score}: 24h momentum, RSI mean reversion, volume. Not a forecast or trade recommendation.`};
}
export function filterRows(rows, state, metric) {
  const filtered=rows.filter(r=>r.base.includes(state.search.toUpperCase())&&r.vol>=state.minVolume).filter(r=>{
    const m=metric(r.symbol);
    switch(state.preset){case'gainers':return r.chg>0;case'losers':return r.chg<0;case'volatile':return r.range>5;case'oversold':return m!=null&&m.r60<30;case'overbought':return m!=null&&m.r60>70;case'volspike':return m!=null&&m.spike>=2;default:return true;}
  });
  return filtered.sort((a,b)=>{
    const k=state.sortKey;if(k==='symbol')return state.sortDir*a.symbol.localeCompare(b.symbol);
    const av=k in a?a[k]:metric(a.symbol)?.[k],bv=k in b?b[k]:metric(b.symbol)?.[k];
    if(av==null)return bv==null?0:1;if(bv==null)return-1;return state.sortDir*(av-bv);
  });
}
