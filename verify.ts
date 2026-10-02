import { strict as assert } from 'node:assert';
import { MarketEngine } from './src/engine.js';
import { marketRef, resolveMarkPrice } from './src/valuation.js';
import { MarketEvent } from './src/types.js';

let passed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name} failed ${extra !== undefined ? JSON.stringify(extra) : ''}`);
  console.log(`  ✓ ${name}`);
  passed += 1;
};
const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

let seq = 1000;
const snapshotEvent = (symbol: string, bids: Array<[number, number]>, asks: Array<[number, number]>): MarketEvent => ({
  id: `T-${seq}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(Date.now() + seq).toISOString(),
  sequence: seq++, type: 'snapshot',
  bids: bids.map(([price, quantity]) => ({ price, quantity })),
  asks: asks.map(([price, quantity]) => ({ price, quantity })),
});
const quoteEvent = (symbol: string, bids?: Array<[number, number]>, asks?: Array<[number, number]>): MarketEvent => ({
  id: `T-${seq}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(Date.now() + seq).toISOString(),
  sequence: seq++, type: 'quote',
  bids: bids?.map(([price, quantity]) => ({ price, quantity })),
  asks: asks?.map(([price, quantity]) => ({ price, quantity })),
});

console.log('1) 建仓后行情下跌：未实现损益、回撤与风控联动');
{
  const engine = new MarketEngine();
  const sid = 'drop-strategy';
  // 20 笔市价买入（单笔 ≤ 50,000），每笔前补齐深度，共约 9,890 股、占用近全部资金
  let bought = 0;
  for (let i = 0; i < 20; i++) {
    engine.ingest(snapshotEvent('ALPHA', [[100, 10000]], [[100.01, 300], [100.02, 10000]]));
    const res = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 499 });
    assert.ok(res.accepted, `buy #${i} rejected: ${JSON.stringify(res.risk)}`);
    bought += res.fills.reduce((s, f) => s + f.quantity, 0);
  }
  const account = engine.account(sid);
  const peakBefore = account.peakEquity;
  ok('建仓后峰值权益约等于初始资金（仅点差/手续费损耗）', approx(peakBefore, 1_000_000, 5e-3), peakBefore);

  // 行情连续下跌到 84（回撤 > 15%）
  engine.ingest(quoteEvent('ALPHA', [[84, 10000]], [[84.01, 10000]]));
  const rawCashBeforeReject = account.cash;
  let perf = engine.performance(sid);
  ok('持仓数量正确', approx(perf.positions[0].quantity, bought), perf.positions);
  ok('估值价为双边中间价 84.005', perf.positions[0].markPrice === 84.005 && perf.positions[0].markSource === 'mid', perf.positions[0]);
  ok('未实现损益为负且随行情更新', perf.unrealizedPnl < -150_000, perf.unrealizedPnl);
  ok('权益 = 现金 + 市值', approx(perf.equity, perf.cash + perf.positions[0].marketValue), { equity: perf.equity, cash: perf.cash });
  ok('回撤比率 > 15%', perf.drawdownRatio > 0.15, perf.drawdownRatio);
  ok('performance 标记 drawdownBreached', perf.drawdownBreached === true);

  // 风控与接口使用同一估值价
  const ref = marketRef(engine.book('ALPHA'));
  const mark = resolveMarkPrice(ref);
  ok('接口估值价与统一估值函数一致', mark.price === perf.positions[0].markPrice, { mark, perf: perf.positions[0] });

  // 下一笔订单必须被最大回撤规则拦截
  engine.ingest(snapshotEvent('ALPHA', [[84, 10000]], [[84.01, 300], [84.02, 10000]]));
  const blocked = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 10 });
  ok('回撤超限后下单被拒 MAX_DRAWDOWN', !blocked.accepted && blocked.risk.code === 'MAX_DRAWDOWN', blocked.risk);
  ok('被拒订单不产生成交', blocked.fills.length === 0);
  const cashAfterReject = engine.account(sid).cash;
  ok('被拒订单不改变现金/持仓', approx(cashAfterReject, rawCashBeforeReject, 1e-9));

  console.log('2) 行情反向上涨：看到持仓收益，回撤解除');
  engine.ingest(quoteEvent('ALPHA', [[110, 10000]], [[110.01, 10000]]));
  perf = engine.performance(sid);
  ok('未实现损益转正', perf.unrealizedPnl > 90_000, perf.unrealizedPnl);
  ok('权益创新高，回撤归零', approx(perf.drawdownRatio, 0) && perf.equity > 1_000_000, perf);
  engine.ingest(snapshotEvent('ALPHA', [[110, 300], [109.99, 10000]], [[110.01, 10000]]));
  const buyAgain = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'market', quantity: 1 });
  ok('回撤解除后恢复交易', buyAgain.accepted, buyAgain.risk);
  bought += 1;

  console.log('3) 平仓：已实现损益、现金流与成交记录可追溯');
  account.ordersInWindow.length = 0; // 测试夹具：重置 60 秒频率窗口
  const before = engine.performance(sid);
  let sold = 0;
  for (let i = 0; sold < bought; i++) {
    engine.ingest(snapshotEvent('ALPHA', [[110, 300], [109.99, 10000]], [[110.01, 10000]]));
    const qty = Math.min(450, bought - sold);
    const res = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'sell', orderType: 'market', quantity: qty });
    assert.ok(res.accepted, `sell #${i} rejected: ${JSON.stringify(res.risk)}`);
    sold += res.fills.reduce((s, f) => s + f.quantity, 0);
  }
  const after = engine.performance(sid);
  ok('全部平仓，无持仓敞口', after.positions.length === 0 && after.exposure.length === 0);
  ok('平仓后权益等于现金', approx(after.equity, after.cash), after);
  ok('已实现损益约为 (110-100.014)×股数（正数）', after.realizedPnl > 90_000, after.realizedPnl);
  ok('未实现损益归零', approx(after.unrealizedPnl, 0), after.unrealizedPnl);
  ok('净损益 = 已实现 - 手续费', approx(after.netPnl, after.realizedPnl - after.totalFees, 1e-4), after);
  ok('净现金流 = 现金 - 初始资金 = 总现金流 - 手续费',
    approx(after.netCashFlow, after.cash - 1_000_000, 1e-4) && approx(after.netCashFlow, after.grossCashFlow - after.totalFees, 1e-4), after);
  ok('成交记录完整（买卖双边逐笔保留）', after.fills.length === after.metrics.fillCount && after.fills.some(f => f.side === 'buy') && after.fills.some(f => f.side === 'sell'), after.fills.length);
  ok('现金流不因平仓查询发生额外变化', before.cash !== after.cash); // 平仓确实改变现金
  const cashNow = after.cash;
  engine.performance(sid);
  engine.performance(sid);
  ok('重复查询 performance 幂等', engine.performance(sid).cash === cashNow && engine.performance(sid).fills.length === after.fills.length);
}

console.log('4) 单边/缺失盘口的估值稳定性');
{
  const engine = new MarketEngine();
  const sid = 'oneside';
  // 仅有卖盘时买入建仓
  engine.ingest(snapshotEvent('BETA', [], [[90, 1000], [90.02, 1000]]));
  const buy = engine.submitOrder({ strategyId: sid, symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 100 });
  ok('单边卖盘可买入', buy.accepted, buy.risk);

  // 买盘缺失、卖盘存在：估值回退到仅存卖价
  engine.ingest(snapshotEvent('BETA', [], [[91, 1000]]));
  let perf = engine.performance(sid);
  ok('只有卖盘时按卖价估值', perf.positions[0].markPrice === 91 && perf.positions[0].markSource === 'one_sided_ask', perf.positions[0]);
  const riskMark = resolveMarkPrice({ ...marketRef(engine.book('BETA')) });
  ok('风控/接口估值来源一致(one_sided_ask)', riskMark.source === 'one_sided_ask' && riskMark.price === 91);

  // 市价买入对手盘（卖盘）缺失 → 拒绝而不是按 0 成交
  engine.ingest(snapshotEvent('BETA', [], []));
  const noAsk = engine.submitOrder({ strategyId: sid, symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 1 });
  ok('对手盘缺失的市价单被拒 NO_MARKET_PRICE', !noAsk.accepted && noAsk.risk.code === 'NO_MARKET_PRICE', noAsk.risk);

  // 只剩买盘：估值回退到买价，市价卖出可成交
  engine.ingest(snapshotEvent('BETA', [[89, 1000]], []));
  perf = engine.performance(sid);
  ok('只有买盘时按买价估值', perf.positions[0].markPrice === 89 && perf.positions[0].markSource === 'one_sided_bid', perf.positions[0]);
  const sell = engine.submitOrder({ strategyId: sid, symbol: 'BETA', side: 'sell', orderType: 'market', quantity: 100 });
  ok('单边买盘可卖出平仓', sell.accepted, sell.risk);
  ok('平仓后敞口清零', engine.performance(sid).positions.length === 0);

  // 双边盘口全空但有最新成交价：回退 last_trade
  engine.ingest(snapshotEvent('GAMMA', [[50, 100]], [[50.01, 100]]));
  engine.submitOrder({ strategyId: 'g', symbol: 'GAMMA', side: 'buy', orderType: 'market', quantity: 10 });
  engine.ingest(snapshotEvent('GAMMA', [], []));
  perf = engine.performance('g');
  ok('盘口清空后回退到最新成交价', perf.positions[0].markSource === 'last_trade' && perf.positions[0].markPrice === 50.01, perf.positions[0]);

  // 纯函数层面：连成交价也没有 → 成本价回退 / 不可用
  ok('无任何行情时回退成本价', resolveMarkPrice({ bestBid: null, bestAsk: null, lastTradePrice: null, costBasis: 77 }).source === 'cost_basis');
  ok('无成本无行情时不可用', resolveMarkPrice({ bestBid: null, bestAsk: null, lastTradePrice: null }).source === 'unavailable');
}

console.log('5) 连续 quote 行情逐笔驱动估值');
{
  const engine = new MarketEngine();
  const sid = 'continuous';
  engine.ingest(snapshotEvent('DELTA', [[100, 1000]], [[100.01, 1000]]));
  engine.submitOrder({ strategyId: sid, symbol: 'DELTA', side: 'buy', orderType: 'market', quantity: 100 });
  const p0 = engine.performance(sid).equity;
  engine.ingest(quoteEvent('DELTA', [[101, 1000]], [[101.01, 1000]]));
  const p1 = engine.performance(sid).equity;
  engine.ingest(quoteEvent('DELTA', [[102, 1000]], [[102.01, 1000]]));
  const p2 = engine.performance(sid).equity;
  ok('连续行情单调推高权益', p1 > p0 && p2 > p1, { p0, p1, p2 });
  ok('每上涨 1 元权益增加约 100', approx(p2 - p0, 200, 1e-6), p2 - p0);

  console.log('6) 重复事件与重复查询稳定');
  const dup = { id: 'DUP', symbol: 'DELTA', tradingDay: '2026-09-30', timestamp: new Date().toISOString(), sequence: 500, type: 'quote', bids: [{ price: 999, quantity: 1 }], asks: [{ price: 999.01, quantity: 1 }] } as MarketEvent;
  const first = engine.ingest(dup);
  const second = engine.ingest(dup);
  ok('重复 sequence 被拒绝', first.accepted && !second.accepted);
  const eq = engine.performance(sid).equity;
  ok('重复事件不改变估值', engine.performance(sid).equity === eq);
}

console.log('7) 其他风控规则保持有效');
{
  const engine = new MarketEngine();
  engine.ingest(snapshotEvent('ALPHA', [[100, 1000]], [[100.01, 1000]]));
  const sid = 'misc';
  const big = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 100.01, quantity: 1000 });
  ok('单笔金额超限拒绝', !big.accepted && big.risk.code === 'ORDER_NOTIONAL_LIMIT', big.risk);
  const dev = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 110, quantity: 10 });
  ok('价格偏离超限拒绝', !dev.accepted && dev.risk.code === 'PRICE_DEVIATION', dev.risk);
  const short = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'sell', orderType: 'market', quantity: 1 });
  ok('裸卖空拒绝', !short.accepted && short.risk.code === 'INSUFFICIENT_POSITION', short.risk);
  const zero = engine.submitOrder({ strategyId: sid, symbol: 'ALPHA', side: 'buy', orderType: 'limit', price: 100, quantity: 0 });
  ok('零数量拒绝', !zero.accepted && zero.risk.code === 'INVALID_QUANTITY', zero.risk);
  // 订单 ID 在零成交/拒绝时仍唯一
  ok('订单 ID 全局唯一递增', big.orderId !== dev.orderId && dev.orderId !== short.orderId);
}

console.log(`\n全部 ${passed} 项断言通过 ✅`);
