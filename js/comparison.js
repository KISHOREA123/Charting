import { createChart, CandlestickSeries } from 'lightweight-charts';
import { getMarkets, getCandles, MarketStream } from './market.js';
import { mergeCandles, candleValid, precisionFor, INTERVALS } from './core.js';
let closeActive;
export function openComparison(symbol, interval) {
  closeActive?.();
  const section=document.createElement('section');section.id='comparison-panel';section.setAttribute('aria-label','Comparison chart');
  const header=document.createElement('header'),title=document.createElement('b'),close=document.createElement('button');title.textContent=`${symbol} · ${interval} · comparison`;close.className='icon-btn';close.textContent='×';close.setAttribute('aria-label','Close comparison');header.append(title,close);
  const status=document.createElement('p');status.className='feed-caption';status.textContent='Loading comparison…';const mount=document.createElement('div');mount.className='comparison-chart';section.append(header,status,mount);document.getElementById('right-sidebar').before(section);
  const chart=createChart(mount,{layout:{background:{color:'#131722'},textColor:'#cbd5e1',attributionLogo:true},grid:{vertLines:{color:'#202a3a'},horzLines:{color:'#202a3a'}},timeScale:{timeVisible:true}});
  const series=chart.addSeries(CandlestickSeries,{upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',borderVisible:false});
  const controller=new AbortController();let stream,candles=[],syncing=false,buffer=[],stopped=false;
  const observer=new ResizeObserver(()=>chart.resize(mount.clientWidth,mount.clientHeight));observer.observe(mount);
  closeActive=()=>{stopped=true;controller.abort();stream?.close();observer.disconnect();chart.remove();section.remove();};close.onclick=()=>{closeActive?.();closeActive=null;};
  const load=async(initial=false)=>{
    if(syncing||stopped)return;syncing=true;
    try{const fresh=await getCandles(symbol,interval,{signal:controller.signal});if(stopped)return;candles=mergeCandles(fresh,buffer.filter(c=>c.time>=(fresh.at(-1)?.time||0)));buffer=[];series.setData(candles);if(initial)chart.timeScale().fitContent();status.textContent='Live comparison · Binance spot';}
    catch(error){if(!stopped){status.textContent=error.message;stream?.socket?.close();}}
    finally{syncing=false;}
  };
  (async()=>{try{
    const market=(await getMarkets()).find(m=>m.symbol===symbol);if(stopped)return;if(!market)throw new Error('Unsupported market. Close this panel and choose another.');
    series.applyOptions({priceFormat:{type:'price',minMove:market.tickSize,precision:precisionFor(market.tickSize)}});await load(true);if(stopped)return;
    stream=new MarketStream(`/ws/${symbol.toLowerCase()}@kline_${interval}`,{onOpen:()=>load(),onStatus:s=>{if(s!=='live')status.textContent=s+' · comparison';},onData:m=>{
      if(!m.k||m.k.s!==symbol||m.k.i!==interval||stopped)return;const k=m.k,c={time:+k.t/1000,open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v,tb:+k.V};if(!candleValid(c))return;
      if(syncing){buffer.push(c);buffer=buffer.slice(-100);return;}if(c.time<(candles.at(-1)?.time||0))return;
      if(c.time>(candles.at(-1)?.time||c.time)+INTERVALS[interval]){buffer.push(c);load();return;}
      candles=mergeCandles(candles,[c]);series.setData(candles);status.textContent='Live comparison · Binance spot';
    }});
  }catch(error){if(!stopped)status.textContent=error.message;}})();
}
