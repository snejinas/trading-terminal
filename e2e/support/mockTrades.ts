/**
 * The mock exchange's trades (BTCUSDT only), defined in closed form so tests can work out exact footprints.
 *  - ids 1..TRADE_HISTORY are history: 20 trades a minute, the newest 3 s before the current minute starts
 *    (so id i happened (TRADE_HISTORY - i + 1) x 3 s before it);
 *  - ids TRADE_HISTORY+1 .. +LIVE_TRADES arrive on the stream once, all at the frozen "now" (inside the current minute);
 *    the first REST_OVERLAP of them are also in the newest REST page (a client must not count them twice).
 * Price steps of 0.5 around the base price, sizes 0.01 .. 0.05, every third trade has a seller aggressor.
 */
export const TRADE_HISTORY = 3000;
export const LIVE_TRADES = 12;
export const TRADE_SPACING_MS = 3000;
/** The REST snapshot is taken a moment after the stream starts: its newest page also holds this many trades the stream already delivered. */
export const REST_OVERLAP = 4;

export interface MockTrade {
  id: number;
  t: number;
  p: number;
  q: number;
  m: boolean; // buyer is the maker: the seller was the aggressor
}

export function tradeAt(i: number, curMinute: number, startedAt: number, base: number): MockTrade {
  return {
    id: i,
    t: i <= TRADE_HISTORY ? curMinute - (TRADE_HISTORY - i + 1) * TRADE_SPACING_MS : startedAt,
    p: base + (((i * 7) % 21) - 10) * 0.5,
    q: 0.01 * ((i % 5) + 1),
    m: i % 3 === 0,
  };
}

export const allTrades = (curMinute: number, startedAt: number, base: number): MockTrade[] =>
  Array.from({ length: TRADE_HISTORY + LIVE_TRADES }, (_, k) => tradeAt(k + 1, curMinute, startedAt, base));
