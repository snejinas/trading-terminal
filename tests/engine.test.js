const E=require('../.test-build/engine.js'); const assert=require('assert');
const mk=(asks,bids)=>({price:{X:100},bid:()=>bids[0][0],ask:()=>asks[0][0],depth:()=>({asks,bids})});
const book=mk([[100.1,1],[100.2,2],[100.5,10]],[[100,1],[99.9,2],[99.5,10]]);
// 1) market buy 2.5 walks 100.1x1, 100.2x1.5
let a=new E.Account(); assert.strictEqual(a.submit(book,{sym:'X',side:'BUY',type:'MKT',qty:2.5}),null);
let f=a.fills[0]; assert.strictEqual(f.levels,2); assert(Math.abs(f.price-(100.1+1.5*100.2)/2.5)<1e-9,f.price); assert(Math.abs(f.slip-(f.price-100.1))<1e-9);
assert(Math.abs(a.cash-(E.START_CASH-(100.1+150.3)*(1+E.FEE_RATE.taker)))<1e-6);
// 2) market order bigger than visible book is rejected, nothing filled
a=new E.Account(); let err=a.submit(book,{sym:'X',side:'BUY',type:'MKT',qty:50}); assert(/visible liquidity/.test(err)); assert.strictEqual(a.fills.length,0); assert.strictEqual(a.cash,E.START_CASH);
// 3) marketable limit: buy 5 @ limit 100.2 -> fills 3 (2 levels), rests 2
a=new E.Account(); assert.strictEqual(a.submit(book,{sym:'X',side:'BUY',type:'LMT',qty:5,limit:100.2}),null);
assert.strictEqual(a.fills.length,1); assert.strictEqual(a.fills[0].qty,3); assert.strictEqual(a.orders.length,1); assert.strictEqual(a.orders[0].qty,2);
// 4) resting order later fills fully when book refreshes, at level prices (price improvement)
const b2=mk([[99.0,5]],[[98.9,5]]); a.match(b2); assert.strictEqual(a.orders.length,0); assert.strictEqual(a.fills[0].qty,2); assert.strictEqual(a.fills[0].price,99.0);
assert.strictEqual(a.positions.X.qty,5);
// 5) sell walks bids; realized pnl uses VWAP
const s=a.submit(book,{sym:'X',side:'SELL',type:'MKT',qty:3}); assert.strictEqual(s,null);
f=a.fills[0]; assert(Math.abs(f.price-(100*1+99.9*2)/3)<1e-9); assert.strictEqual(f.levels,2);
// 6) no depth (sim feed): top-of-book, unlimited size
const sim={price:{X:100},bid:()=>99.99,ask:()=>100.01}; a=new E.Account(); assert.strictEqual(a.submit(sim,{sym:'X',side:'BUY',type:'MKT',qty:100}),null); assert.strictEqual(a.fills[0].price,100.01);
// 7) buying power check uses swept cost
a=new E.Account(); err=a.submit(mk([[100.1,1],[60000,1000]],[[100,1]]),{sym:'X',side:'BUY',type:'MKT',qty:10}); assert(/buying power/.test(err),err);
console.log('engine tests passed');
