# Trading Terminal (paper)

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
  readout, `Vol` button to hide them; remembered).
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
  slippage.ts                       pre-trade slippage analysis
  fees.ts                           fee tiers and settings
  backup.ts / storage.ts            account export/import and browser persistence
tests/                              unit tests (plain Node scripts, run by `npm test`)
```

## Tests

`npm test` compiles `src/lib/trading` and runs the suites in `tests/`: fills and fees, book depletion and
recovery, persistence validation, backup import hardening, slippage (including "estimate equals actual fill"),
timeframes, candle volume (including higher-timeframe volume built from the cumulative 1m stream), and
history paging against a fake exchange.
The browser-level behaviour (chart interaction, order ticket) was checked with Playwright against a mocked
Binance but those scripts are not part of this repo yet.

## Known limitations

- Fills are instant: no latency, queue position or partial fills of resting orders.
- Depth is limited to the top 10 levels; a market order bigger than that is rejected rather than estimated.
- Fees are charged in USDT (even with the BNB discount toggle) and there is no volume-based tier logic.
- Higher-timeframe candles are kept live by folding the 1m stream (volume is added as increments). A brief gap
  can leave a candle's high/low or volume slightly off until the next reconnect resync, and loading a timeframe
  between two stream messages can count a fraction of a second of volume twice.
- Volume is in base-asset units (e.g. BTC); the simulated feed's volume is synthetic.
- Account data lives only in one browser's `localStorage` (use Export for backups).

## Provenance

Extracted from `snejinas/lifeinception3` (branch `ccr-9dde7727-3qdzwq`) with its commit history, so this
project could live in its own repository. Volume bars were finished here after the extraction.
