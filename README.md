# ChartPro — TradingView-style Crypto Charting Tool

A professional, TradingView-inspired charting terminal for cryptocurrency markets, built as a pure static website. Live data comes from Binance's public market-data API (no API key needed).

## Project Goals
- Phase 1 (current): full-featured crypto charting terminal
- Phase 2 (future): expand to other markets (stocks, forex, commodities)

## ✅ Currently Completed Features

### Charting
- **TradingView Lightweight Charts™** engine — candles, bars, line, area
- **1000 historical candles** per symbol/timeframe; timeframes 1m–1W
- **Real-time updates** via Binance WebSocket kline stream
- **Volume histogram** + crosshair-following OHLCV legend

### Indicators — 21 total
**Moving averages (overlays):** SMA 20/50/200, EMA 20/50/200, WMA 20
**Overlays:** Bollinger Bands (20,2), Keltner Channels (20,2), Donchian Channels (20), VWAP, Ichimoku Cloud (9,26,52), Parabolic SAR, SuperTrend (10,3)
**Oscillators (each in its own dynamic sub-pane with live value + × close button):**
RSI (14), MACD (12,26,9), Stochastic (14,3,3), Stochastic RSI, ATR (14), ADX/DMI (14), CCI (20), MFI (14), OBV, Williams %R (14)
- Any number of panes can be open at once; heights auto-adjust; all panes scroll/zoom-synced to the main chart
- All indicators recalculate on every live tick

### SMC — Smart Money Concepts auto-annotations (SMC button)
Automatically detected and drawn on the chart, recalculated on live ticks:
- **Market Structure** — BOS (Break of Structure) & CHoCH (Change of Character) lines
- **Order Blocks** — bullish/bearish OB zones, faded once mitigated
- **Fair Value Gaps (FVG)** — unfilled 3-candle imbalances
- **Liquidity** — Equal Highs / Equal Lows pools (EQH/EQL $$$, dashed)
- **Swing Points** — HH / HL / LH / LL labels on fractal pivots
- **Premium / Discount** — range shading with equilibrium (EQ) midline
- Enable-all / disable-all shortcuts; toggles persist across reloads

### Long / Short Position Tools
- Dedicated Long (green) and Short (red) tools in the left toolbar
- Two clicks (entry → target) auto-place the stop at R/R 2.0
- Shaded profit/stop zones with live **R/R ratio, target % and stop %** labels
- Entry, target and stop each draggable independently; whole position movable; persisted per symbol

### Tool Customization (settings bar)
- Appears when a tool is armed or a drawing is selected
- **8 color swatches, line width (1–4px), line style (solid/dashed/dotted)**
- Restyle existing drawings live; new drawings inherit the chosen style; delete button
- Style preferences persist in localStorage

### Drawing Tools — 9 tools + editing
- **Trend Line** (T), **Ray** (extends right), **Horizontal Line** (H), **Vertical Line**, **Rectangle** (R), **Fibonacci Retracement** (F, 7 levels with shading + price labels), **Brush** (freehand), **Text Note**, **Ruler/Measure** (M — % change, price Δ, bar count)
- **Select / drag / move** drawings in cursor mode (grab whole shape or endpoint handles)
- **Delete key** removes the selected drawing; trash button clears all; **Esc** cancels
- **Magnet mode** — snaps drawing points to nearest OHLC value
- **Keyboard shortcuts**: V cursor · T trendline · H hline · R rect · F fib · M ruler
- **Drawings persist per-symbol** in `localStorage` and survive reloads

### Persistence
- Drawings saved per symbol (`chartpro-drawings-<SYMBOL>`)
- Last symbol, timeframe, chart type, and active indicators restored on reload (`chartpro-settings`)

### Market Scanner (scanner.html)
- Live screener of **all Binance spot pairs** for USDT / FDUSD / BTC quotes, auto-refresh 10s
- Presets: All · Top Gainers · Top Losers · Most Volume · Most Volatile · RSI Oversold · RSI Overbought
- Columns: price, 24h % (with heat bar), 24h Δ/high/low, volatility, volume, trades, **multi-timeframe RSI(14) — 5m / 15m / 1h** (lazily batch-computed), **Vol ×** (last closed 5m volume vs 20-bar average), composite **BUY/SELL signal**
- **Volume Spike preset** — filters pairs whose last 5m volume is ≥2× their average
- Market breadth summary (advancers/decliners, avg change, total volume)
- Sortable columns, symbol filter, click a row → opens the chart at that symbol (`index.html?symbol=X&tf=1h`)

### Intraday Toolkit (⚡ Intraday menu + sidebar tabs)
- **Price Alerts** — bell tool: click a price to arm an alert line; fires with a sound + browser notification when crossed; managed in the Alerts sidebar tab; persisted
- **Session Boxes** — Asia / London / New York session high-low boxes on intraday TFs (1m–1h)
- **Key Levels** — auto PDH / PDL / PWH / PWL dashed lines from daily/weekly candles
- **Volume Profile** — 48-bin volume-at-price histogram with POC / VAH / VAL (70% value area)
- **CVD pane** — Cumulative Volume Delta from taker-buy volume
- **Candle countdown** — mm:ss to bar close in the status bar
- **Order Book tab** — live 20-level depth (bids/asks, mid price, cumulative bars) via WebSocket
- **Time & Sales tab** — streaming trade tape with big-trade (>$25k) and whale (>$100k) highlighting
- **Position Size Calculator** — account, risk %, entry/stop, leverage → qty, value, margin
- **Watchlist 5m spike flags** — ▲/▼ badge when a pair moves ≥1% within 5 minutes

### Trade Journal (journal.html)
- Log trades (symbol, side, entry/exit, qty, stop, target, notes) stored via the **RESTful Table API** (`trades` table)
- Stats: win rate, total PnL, average win/loss, open count
- Close open trades with one click (auto-computes PnL & outcome); delete entries

### Market Data UI
- **Symbol search modal** — all live Binance USDT spot pairs
- **Live watchlist** (12 major pairs) with price-flash animations
- **24h stats bar**: price, % change, high, low, volume
- Connection status; auto WebSocket reconnect; REST/WSS host failover (`data-api.binance.vision` ⇄ `api.binance.com`)

### Design
- Dark TradingView-like theme, Inter font, Font Awesome icons
- Responsive: watchlist hides < 900px, compact toolbar < 600px — verified on desktop & mobile

## 📂 Entry Points
| Path | Description |
|------|-------------|
| `index.html` | Chart terminal. Optional params: `?symbol=BTCUSDT&tf=1h` |
| `scanner.html` | Market scanner / screener |
| `journal.html` | Trade journal (optional `?symbol=` prefills the log form) |

## 🏗️ Architecture
```
index.html          — chart terminal layout (toolbar, tools, panes, watchlist, settings bar)
scanner.html        — market scanner page
css/style.css       — dark theme + responsive rules (shared)
css/scanner.css     — scanner-specific styles
js/indicators.js    — pure indicator math (19 algorithms, framework-free)
js/smc.js           — SMC detection engine (swings, structure, OB, FVG, liquidity, range)
js/main.js          — charts, Binance REST/WS, drawing engine, SMC renderer, persistence
js/scanner.js       — screener logic (tickers, filters, multi-TF RSI, vol spike, signals)
journal.html        — trade journal page
js/journal.js       — journal CRUD via Table API
css/journal.css     — journal styles
```

### Storage
- `localStorage` — drawings (per symbol), alerts, UI settings
- **Table API (`trades`)** — trade journal records (id, symbol, side, entry, exit, quantity, stop, target, status, pnl, notes, opened_at, closed_at)

### Data Sources (public, key-free, CORS-enabled)
- REST: `/api/v3/klines`, `/api/v3/ticker/24hr`, `/api/v3/exchangeInfo`
- WebSocket: `<symbol>@kline_<interval>`, combined `@miniTicker`, `@depth20`, `@aggTrade` streams
- No backend / no server database — state lives client-side (localStorage)

## 🚧 Features Not Yet Implemented
- Indicator parameter settings dialogs (periods are fixed defaults)
- SMC parameter tuning UI (swing length, FVG min size)
- Multi-chart layouts, chart screenshot/export
- Alerts on scanner rows; alert conditions other than price cross
- Journal: chart screenshots attached to trades, equity curve chart
- Other markets (stocks/forex) — needs an additional data provider

## 💡 Recommended Next Steps
1. Indicator & SMC settings UI (custom periods, colors, sensitivities)
2. Journal equity curve + per-setup tagging and filtering
3. Multi-chart layout (2×1, 2×2 grids)
4. Data-provider adapter layer for stocks/forex expansion

## Deployment
Static site — publish via the **Publish tab**.
