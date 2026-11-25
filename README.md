# Trading Terminal (paper)

[![CI](https://github.com/snejinas/trading-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/snejinas/trading-terminal/actions/workflows/ci.yml)

A browser trading terminal with **live Binance market data** and a **local paper-trading account**.
Orders are simulated in your browser; nothing is ever sent to an exchange and no API key is used.

> Paper trading only. Not financial advice. Prices come from Binance's public market-data API.
> If Binance can't be reached the terminal falls back to a simulated random-walk feed.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
```

Other scripts: `npm run typecheck`, `npm test`.

## What it does

- **Live data** (Binance public endpoints, no key): 1m–1D candles with volume, best bid/ask, top-10 order book depth
  for BTC, ETH, SOL, BNB, XRP, DOGE vs USDT. Simulated fallback feed for offline use.
- **Chart**: candlesticks with a time axis, crosshair/OHLC readout, timeframes (1m, 5m, 15m, 1h, 4h, 1D),
  wheel zoom at the cursor, drag/pinch/keyboard pan, automatic loading of older history, live updates,
  and **volume bars** under the candles (own scale fitted to the visible window, volume in the crosshair
  readout, `Vol` button to hide them; remembered), and **moving averages** (up to three SMA/EMA lines on the
  close, default SMA 20, SMA 50 and an off EMA 200; the `MA` button sets type, period 1–500 and visibility,
  remembered). A legend shows each value at the candle under the cursor, or at the newest visible candle.
  **Bollinger Bands** (`BB` button, off by default): SMA ± N standard deviations (population) of the close,
  period 1–500 and 0.1–10 deviations, drawn as a shaded band with a dashed middle line and an upper/middle/lower legend.
  **Stochastic RSI** (`StochRSI` button, off by default): where Wilder's RSI sits between its own lowest and highest value
  over a lookback, with %K and %D smoothing; defaults 14, 14, 3, 3. It has its own pane between the price chart and
  the volume bars, fixed 0–100 scale with the 20/80 levels, values in the pane label and the crosshair axis.
  **Volume profile** (`VP` button, off by default): traded volume by price level over the candles in view, as bars
  growing leftwards from the price axis behind the candles. Each candle's volume is spread evenly over its
  high–low range. Marks the point of control (busiest level, `POC`) and the value area (`VAH`/`VAL`, default 70%
  of the volume around it); levels (10–200) and value-area percentage (50–95) are settings, remembered. It always
  describes what is on screen, so it changes as you scroll and zoom.
  **Fibonacci retracement** (`Fib` button): choose *Draw retracement*, then click the start and the end of a move
  (Esc cancels). Levels 0, 0.236, 0.382, 0.5, 0.618, 0.786 and 1 are drawn from the earlier point to the right edge,
  with optional extensions (1.272, 1.618, 2.618). Anchors are snapped to candles and stored as time + price, so they
  stay put through zoom, scroll and timeframe changes; drag an anchor to adjust it, delete from the popover.
  Up to 20 per symbol, remembered per symbol.
  **Liquidation heatmap** (`Liq` button, off by default): an *estimate* of where leveraged positions would be
  liquidated, shaded underneath the candles. Binance does not publish this, so it is modelled: each candle opens
  new positions (sized from open-interest growth when Binance's futures data is reachable, otherwise from traded
  volume), split over 5x–100x leverage and long/short, each with a liquidation price at its entry ∓ margin; a level
  stays on the map until price trades through it. Colours are relative to the hottest cell in view.
- **Paper account** ($100k): market and limit orders, positions, working orders, fills, P&L.
- **Realistic fills**: market and marketable-limit orders *walk the order book* level by level and fill at the
  volume-weighted price. Your own fills deplete the book and it recovers over time (5 s half-life).
  Market orders larger than the visible book are rejected.
- **Fees**: maker/taker with Binance-style tiers, a BNB discount, or custom rates (tier numbers are approximate).
- **Slippage warning** before you submit, from the same book sweep the fill engine uses; severe orders need a
  second confirming click (or `!` on the command line).
- **Persistence**: the account and settings are saved in `localStorage`; export/import the account as JSON.
- **Command line**: `buy|sell SYM QTY [LIMIT] [!]`, `flat SYM`, `cancel ID|all`, `chart SYM [TF]`, `tf TF`,
  `export`, `import`, `pause`, `resume`, `reset`, `clear`, `help`.

## Layout

```
src/app/page.tsx                    the page (renders the terminal)
src/components/terminal/            the UI (one big client component: ticket, blotter, chart, order book)
src/lib/trading/
  engine.ts                         market/account model: Account, sweep(), fees, impact overlay, simulated feed
  binance.ts                        Binance REST + WebSocket feed (history, depth, live candles)
  timeframes.ts                     timeframes, candle aggregation/folding, time formatting
  chartview.ts                      chart zoom/scroll math
  indicators.ts                     SMA/EMA, Bollinger Bands, Stochastic RSI (and the RSI it is built on) and their settings
  volumeprofile.ts                  visible-range volume profile: levels, point of control, value area
  fib.ts                            Fibonacci levels, time/price anchors, hit-testing, per-symbol storage
  liquidations.ts                   estimated liquidation heatmap model (position inflow, levels, consumption, grid)
  slippage.ts                       pre-trade slippage analysis
  fees.ts                           fee tiers and settings
  backup.ts / storage.ts            account export/import and browser persistence
tests/                              unit tests (plain Node scripts, run by `npm test`)
e2e/                                Playwright browser tests + the mocked Binance (`npm run e2e`)
```

## Tests

`npm test` compiles `src/lib/trading` and runs the suites in `tests/`: fills and fees, book depletion and
recovery, persistence validation, backup import hardening, slippage (including "estimate equals actual fill"),
timeframes, the volume profile, Fibonacci levels and time/index mapping, the liquidation model (against a naive reference), moving averages, Bollinger Bands, RSI and Stochastic RSI (against naive references, plus a hand-checked textbook example, warm-up, bad data, settings), candle volume (including higher-timeframe volume built from the cumulative 1m stream), and
history paging against a fake exchange.

### Browser tests (Playwright)

```bash
npm run e2e:install   # once: downloads Chromium for Playwright
npm run e2e           # builds the app, starts it on :3100, runs everything in e2e/
```

The specs drive the real UI against a **mocked Binance** (REST and WebSocket are intercepted, see
`e2e/support/mockBinance.ts`), so they are deterministic and need no network. The mock's clock is frozen,
its order book is flat and every minute trades the same volume, which lets the tests assert exact numbers.

| spec | covers |
| --- | --- |
| `chart-interaction` | wheel/drag/pinch/keyboard zoom and scroll, older-history paging, staying anchored to live candles |
| `chart-timeframes` | timeframe buttons and commands, per-symbol caching, loading and failure states, simulated feed |
| `chart-volumeprofile` | every level against an independent calculation, POC and value area, settings, scroll/zoom, hover, no-volume feeds |
| `chart-liquidation` | heatmap from volume and from open interest, exact levels and consumption times, fallback, fetch frequency |
| `chart-fibonacci` | placing with two clicks, exact levels, anchoring through zoom/timeframes, dragging, persistence per symbol, limits |
| `chart-stochrsi` | exact %K/%D against an independent calculation, pane layout with volume, the four inputs, persistence, popovers |
| `chart-bollinger` | band values (exact, on a ramp history), legend, period/multiplier input, persistence, short history |
| `chart-indicators` | moving-average values (exact, on a ramp history), legend, popover, persistence, short history |
| `chart-volume` | volume pane scale, bar proportions measured from canvas pixels, toggle, higher-timeframe volume |
| `order-ticket` | slippage estimates and warnings, two-step confirmation, `!` on the command line, depletion |
| `fee-tier` | tier / BNB / custom fee popover and the fees it charges |
| `account-persistence` | reload, cross-tab sync, corrupt and blocked storage, `reset` |
| `account-backup` | export, import with confirmation, rejection of bad files |

`npm run e2e -- e2e/order-ticket.spec.ts` runs one file; `npm run typecheck:e2e` type-checks the tests.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests: one job type-checks the app and
the tests and runs the unit tests, the other installs Chromium and runs `npm run e2e` (the HTML report is
uploaded as an artifact, kept for 7 days). Both use Node 22 and `npm ci`.
Set `E2E_PORT` to use another port. In CI the server is always started fresh; locally an already
running one on that port is reused.

## Known limitations

- Fills are instant: no latency, queue position or partial fills of resting orders.
- Depth is limited to the top 10 levels; a market order bigger than that is rejected rather than estimated.
- Fees are charged in USDT (even with the BNB discount toggle) and there is no volume-based tier logic.
- Higher-timeframe candles are kept live by folding the 1m stream (volume is added as increments). A brief gap
  can leave a candle's high/low or volume slightly off until the next reconnect resync, and loading a timeframe
  between two stream messages can count a fraction of a second of volume twice.
- Moving averages use the candles loaded so far; an EMA seeded near the start of a short history is less
  accurate than one with plenty of warm-up, and an average longer than the history shows `—`.
- The liquidation heatmap is a model, not exchange data: the long/short split is assumed even, leverage tiers and
  maintenance margin (0.5%) are fixed typical values, isolated margin only, and positions closed voluntarily are not
  removed. Open-interest history comes from Binance's futures API (public, last ~500 periods, may be geo-blocked);
  without it, or for candles older than it covers, the volume-based estimate is used / contributes nothing.
- Volume is in base-asset units (e.g. BTC); the simulated feed's volume is synthetic.
- Account data lives only in one browser's `localStorage` (use Export for backups).

## Provenance

Extracted from `snejinas/lifeinception3` (branch `ccr-9dde7727-3qdzwq`) with its commit history, so this
project could live in its own repository. Volume bars were finished here after the extraction.
