const E = require('../.test-build/engine.js');
const F = require('../.test-build/fees.js');
const assert = require('assert');
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-12, `${m}: ${a} vs ${b}`);

// 1) tiers -> fractional rates
let r = F.ratesFor(F.DEFAULT_FEE_CONFIG); near(r.maker, 0.001, 'regular maker'); near(r.taker, 0.001, 'regular taker');
r = F.ratesFor({ tier: 'vip3', bnb: false, custom: { maker: 0.1, taker: 0.1 } }); near(r.maker, 0.00042, 'vip3 maker'); near(r.taker, 0.0006, 'vip3 taker');
r = F.ratesFor({ tier: 'zero', bnb: false, custom: { maker: 0.1, taker: 0.1 } }); assert.deepStrictEqual(r, { maker: 0, taker: 0 });

// 2) BNB discount takes 25% off tiers, but is ignored for custom (you type the effective rate)
r = F.ratesFor({ tier: 'regular', bnb: true, custom: { maker: 0.1, taker: 0.1 } }); near(r.maker, 0.00075, 'bnb maker'); near(r.taker, 0.00075, 'bnb taker');
r = F.ratesFor({ tier: 'custom', bnb: true, custom: { maker: 0.02, taker: 0.05 } }); near(r.maker, 0.0002, 'custom maker'); near(r.taker, 0.0005, 'custom taker (no bnb)');

// 3) custom values are clamped to [0, MAX]
r = F.ratesFor({ tier: 'custom', bnb: false, custom: { maker: -5, taker: 999 } }); assert.strictEqual(r.maker, 0); near(r.taker, F.MAX_CUSTOM_PCT / 100, 'clamped max');
r = F.ratesFor({ tier: 'custom', bnb: false, custom: { maker: NaN, taker: Infinity } }); assert(Number.isFinite(r.maker) && Number.isFinite(r.taker));

// 4) unknown tier falls back to regular rather than crashing
r = F.ratesFor({ tier: 'platinum-ultra', bnb: false, custom: { maker: 0.1, taker: 0.1 } }); near(r.taker, 0.001, 'unknown tier');

// 5) parseFeeConfig sanitises hostile storage
for (const bad of [null, 5, 'x', [], {}, { tier: 'nope' }, { tier: 'vip2', bnb: 'yes', custom: 'x' }, { tier: 'custom', custom: { maker: 'a', taker: {} } }]) {
  const c = F.parseFeeConfig(bad);
  assert(c.tier === 'custom' || F.FEE_TIERS.some(t => t.id === c.tier), JSON.stringify(bad));
  assert.strictEqual(typeof c.bnb, 'boolean'); assert(Number.isFinite(c.custom.maker) && Number.isFinite(c.custom.taker));
  const rr = F.ratesFor(c); assert(rr.maker >= 0 && rr.taker >= 0 && rr.taker <= 0.02);
}
assert.strictEqual(F.parseFeeConfig({ tier: 'vip2', bnb: true, custom: { maker: 0.03, taker: 0.04 } }).tier, 'vip2');
assert.strictEqual(F.parseFeeConfig({ tier: 'vip2', bnb: 'yes' }).bnb, false, 'bnb must be strictly true');

// 6) formatting
assert.strictEqual(F.fmtRate(0.001), '0.1%'); assert.strictEqual(F.fmtRate(0.00075), '0.075%'); assert.strictEqual(F.fmtRate(0), '0%'); assert.strictEqual(F.fmtRate(0.00042), '0.042%');
assert.strictEqual(F.feeLabel({ tier: 'vip1', bnb: true, custom: {} }), 'VIP 1 + BNB'); assert.strictEqual(F.feeLabel({ tier: 'custom', bnb: true, custom: {} }), 'Custom');

// 7) engine charges the account's rates; changing them affects NEW fills only; maker vs taker differ
const mk = (asks, bids) => ({ price: { X: 100 }, bid: () => bids[0][0], ask: () => asks[0][0], depth: () => ({ asks, bids }) });
const flat = mk([[100, 1e6]], [[100, 1e6]]);
let a = new E.Account();
a.rates = F.ratesFor({ tier: 'vip3', bnb: false, custom: {} }); // 0.042% / 0.06%
a.submit(flat, { sym: 'X', side: 'BUY', type: 'MKT', qty: 10 });
near(a.fills[0].fee, 1000 * 0.0006, 'taker fee uses account rate');
a.rates = F.ratesFor({ tier: 'zero', bnb: false, custom: {} });
a.submit(flat, { sym: 'X', side: 'BUY', type: 'MKT', qty: 10 });
assert.strictEqual(a.fills[0].fee, 0); near(a.fills[1].fee, 0.6, 'old fill keeps its fee');
near(a.fees, 0.6, 'running total only counts charged fees');
// maker uses the maker rate
a = new E.Account(); a.rates = { maker: 0.0002, taker: 0.0009 };
a.submit(mk([[101, 5]], [[100, 5]]), { sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 99 });
a.match(mk([[98, 5]], [[97, 5]])); assert.strictEqual(a.fills[0].role, 'maker'); near(a.fills[0].fee, 98 * 0.0002, 'maker fee uses maker rate');
// buying power uses the account's taker rate: a 0% account can spend ~everything, a 2% account cannot
const big = mk([[100, 1e9]], [[100, 1e9]]); const all = E.START_CASH / 100;
a = new E.Account(); a.rates = { maker: 0, taker: 0 }; assert.strictEqual(a.submit(big, { sym: 'X', side: 'BUY', type: 'MKT', qty: all }), null);
a = new E.Account(); a.rates = { maker: 0.02, taker: 0.02 }; assert(/buying power/.test(a.submit(big, { sym: 'X', side: 'BUY', type: 'MKT', qty: all })));
// rates are NOT persisted in the snapshot (it's a setting, re-applied on load)
assert(!('rates' in a.snapshot()));
const rest = E.Account.restore(JSON.parse(JSON.stringify(new E.Account().snapshot())), new Set(['X'])).account;
assert.deepStrictEqual(rest.rates, E.FEE_RATE);

console.log('fee config tests passed');
