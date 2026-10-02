import assert from 'node:assert/strict';
import { MarketEngine } from '../src/engine.js';

// 持仓估值 ↔ performance 接口 ↔ 下单风控 联动验证
// 运行：npm test

const DAY = '2026-10-02';
const T0 = new Date('2026-10-02T09:30:00.000Z').getTime();
let tick = 0;
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function snapshot(engine: MarketEngine, symbol: string, bids: Array<[number, number]>, asks: Array<[number, number]>) {
  tick += 1;
  const accepted = engine.ingest({
    id: `T-${symbol}-${tick}`, symbol, tradingDay: DAY, timestamp: at(tick), sequence: tick, type: 'snapshot',
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
  });
  assert.equal(accepted.accepted, true, `snapshot ${symbol}#${tick} accepted`);
}

function midOf(engine: MarketEngine, symbol: string): number {
  const snap = engine.book(symbol).snapshot(1);
  return +(((snap.bids[0]?.price ?? 0) + (snap.asks[0]?.price ?? 0)) / 2).toFixed(6);
}

const close = (actual: number, expected: number, label: string, tolerance = 0.05) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ≈${expected}, got ${actual}`);

// ---------------------------------------------------------------------------
// 场景 1：买入并持有 → 行情下跌 → performance 反映回撤 → 下一单触发最大回撤限制
// ---------------------------------------------------------------------------
{
  const engine = new MarketEngine();
  snapshot(engine, 'BETA', [[100.0, 100_000]], [[100.1, 100_000]]);

  for (let i = 0; i < 20; i++) {
    const result = engine.submitOrder({ strategyId: 'DD', symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 499 });
    assert.equal(result.accepted, true, `buy #${i} accepted`);
  }
  const afterBuy = engine.performance('DD');
  assert.equal(afterBuy.account.position['BETA'], 9_980);
  close(afterBuy.metrics.equity, afterBuy.account.cash + 9_980 * midOf(engine, 'BETA'), 'equity right after buys = cash + 持仓市值', 0.001);
  assert.ok(afterBuy.metrics.equity > 999_000, '买入后权益仅损失费用与半价差（旧实现会按全额支出计亏）');
  assert.ok(afterBuy.metrics.drawdown < 0.001, 'no meaningful drawdown before market moves');

  // 行情下跌约 16%
  snapshot(engine, 'BETA', [[84.0, 100_000]], [[84.1, 100_000]]);

  const crashed = engine.performance('DD');
  const mark = midOf(engine, 'BETA');
  assert.equal(crashed.metrics.exposure[0].markPrice, mark, 'performance 使用与盘口一致的估值价');
  close(crashed.metrics.equity, crashed.account.cash + 9_980 * mark, 'equity = cash + 持仓市值');
  close(crashed.metrics.unrealizedPnl, 9_980 * (mark - 100.1), '未实现损益随行情下跌更新');
  assert.ok(crashed.metrics.drawdown > 0.15, `回撤 ${crashed.metrics.drawdown} 超过 15% 上限`);

  // 下一笔订单必须被最大回撤规则拦截，且风控看到的权益与接口一致
  const blocked = engine.submitOrder({ strategyId: 'DD', symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 1 });
  assert.equal(blocked.accepted, false, 'drawdown 状态下拒绝新订单');
  assert.equal(blocked.risk.rule, 'drawdown');
  assert.equal(blocked.risk.code, 'MAX_DRAWDOWN');
  const rejection = engine.anomalies.find(a => a.type === 'risk_rejection' && (a.detail as { strategyId?: string }).strategyId === 'DD');
  assert.ok(rejection, '风控拒绝留痕');
  close((rejection!.detail as { equity: number }).equity, crashed.metrics.equity, '风控与接口使用同一权益估值', 0.001);

  // 重复查询结果稳定
  assert.deepEqual(engine.performance('DD').metrics, engine.performance('DD').metrics, '重复查询结果一致');

  // 反向上涨：持仓收益可见，回撤解除，订单恢复放行
  snapshot(engine, 'BETA', [[120.0, 100_000]], [[120.1, 100_000]]);
  const rallied = engine.performance('DD');
  assert.ok(rallied.metrics.unrealizedPnl > 0, '上涨后未实现收益为正');
  close(rallied.metrics.equity, rallied.account.cash + 9_980 * midOf(engine, 'BETA'), '上涨后权益按新市值更新');
  close(rallied.metrics.netPnl, rallied.metrics.equity - 1_000_000, 'netPnl 与权益变动一致');
  const resumed = engine.submitOrder({ strategyId: 'DD', symbol: 'BETA', side: 'buy', orderType: 'market', quantity: 1 });
  assert.equal(resumed.accepted, true, '权益修复后订单恢复放行');
  console.log('✓ 场景 1：下跌触发回撤限制 / 上涨反映持仓收益 / 接口与风控估值一致');
}

// ---------------------------------------------------------------------------
// 场景 2：盘口不完整（单腿 / 空盘口）时估值稳定
// ---------------------------------------------------------------------------
{
  const engine = new MarketEngine();
  snapshot(engine, 'GAMMA', [[50.0, 1_000]], [[50.1, 1_000]]);
  const buy = engine.submitOrder({ strategyId: 'INC', symbol: 'GAMMA', side: 'buy', orderType: 'market', quantity: 100 });
  assert.equal(buy.accepted, true);

  snapshot(engine, 'GAMMA', [[49.0, 500]], []); // 只剩买盘
  let perf = engine.performance('INC');
  assert.equal(perf.metrics.exposure[0].markPrice, 49.0, '仅买盘时用 bestBid 估值');
  close(perf.metrics.unrealizedPnl, 100 * (49.0 - 50.1), '仅买盘时未实现损益');
  assert.ok(Number.isFinite(perf.metrics.equity));

  snapshot(engine, 'GAMMA', [], [[51.0, 500]]); // 只剩卖盘
  perf = engine.performance('INC');
  assert.equal(perf.metrics.exposure[0].markPrice, 51.0, '仅卖盘时用 bestAsk 估值');
  close(perf.metrics.unrealizedPnl, 100 * (51.0 - 50.1), '仅卖盘时未实现损益');

  snapshot(engine, 'GAMMA', [], []); // 空盘口 → 回退最近成交价（本策略成交价 50.1）
  perf = engine.performance('INC');
  assert.equal(perf.metrics.exposure[0].markPrice, 50.1, '空盘口回退最近成交价');
  close(perf.metrics.unrealizedPnl, 0, '回退成交价时未实现损益为 0');
  assert.ok(Number.isFinite(perf.metrics.equity) && Number.isFinite(perf.metrics.drawdown), '空盘口下指标有限');
  console.log('✓ 场景 2：单腿/空盘口下估值价格回退链稳定（mid → 单腿 → 最近成交 → 成本）');
}

// ---------------------------------------------------------------------------
// 场景 3：平仓后已实现损益落账，现金流可追溯
// ---------------------------------------------------------------------------
{
  const engine = new MarketEngine();
  snapshot(engine, 'ECHO', [[200.0, 1_000]], [[200.1, 1_000]]);
  engine.submitOrder({ strategyId: 'CLOSE', symbol: 'ECHO', side: 'buy', orderType: 'market', quantity: 100 });
  snapshot(engine, 'ECHO', [[210.0, 1_000]], [[210.1, 1_000]]);
  const sell = engine.submitOrder({ strategyId: 'CLOSE', symbol: 'ECHO', side: 'sell', orderType: 'market', quantity: 100 });
  assert.equal(sell.accepted, true);

  const perf = engine.performance('CLOSE');
  assert.equal(perf.account.position['ECHO'] ?? 0, 0, '平仓后持仓为 0');
  assert.equal(perf.metrics.exposure.length, 0, '平仓后无风险敞口');
  close(perf.metrics.realizedPnl, 100 * (210.0 - 200.1), '已实现损益 = 990');
  close(perf.metrics.unrealizedPnl, 0, '平仓后未实现损益为 0');
  close(perf.metrics.grossCashFlow, -100 * 200.1 + 100 * 210.0, '现金流 = 卖出回款 - 买入支出');
  close(perf.metrics.equity, perf.account.cash, '平仓后权益 = 现金');
  close(perf.metrics.netPnl, perf.metrics.equity - 1_000_000, 'netPnl = 权益变动');
  close(perf.metrics.netPnl, perf.metrics.realizedPnl - perf.metrics.fees, 'netPnl = 已实现 - 费用');
  const fills = engine.fills.filter(f => f.strategyId === 'CLOSE');
  assert.equal(fills.length, 2, '成交记录完整（买+卖）');
  console.log('✓ 场景 3：平仓落账，现金流 / 已实现损益 / 成交记录可追溯');
}

// ---------------------------------------------------------------------------
// 场景 4：连续行情逐档更新估值，重复查询幂等
// ---------------------------------------------------------------------------
{
  const engine = new MarketEngine();
  snapshot(engine, 'DELTA', [[10.0, 10_000]], [[10.01, 10_000]]);
  engine.submitOrder({ strategyId: 'TREND', symbol: 'DELTA', side: 'buy', orderType: 'market', quantity: 1_000 });

  let previousEquity = Number.POSITIVE_INFINITY;
  for (const bid of [9.9, 9.8, 9.7, 9.6, 9.5]) {
    snapshot(engine, 'DELTA', [[bid, 10_000]], [[bid + 0.01, 10_000]]);
    const perf = engine.performance('TREND');
    close(perf.metrics.equity, perf.account.cash + 1_000 * midOf(engine, 'DELTA'), `连续行情 equity@${bid}`);
    assert.ok(perf.metrics.equity < previousEquity, '权益随行情逐档下行');
    previousEquity = perf.metrics.equity;
    assert.deepEqual(engine.performance('TREND').metrics, perf.metrics, '同一行情下重复查询稳定');
  }
  console.log('✓ 场景 4：连续行情逐档更新未实现损益，重复查询幂等');
}

// ---------------------------------------------------------------------------
// 场景 5：挂单被对手方/行情流击穿时，maker 成交同步持仓与账户
// ---------------------------------------------------------------------------
{
  const engine = new MarketEngine();
  snapshot(engine, 'FOXTROT', [[99.9, 500]], [[100.1, 500]]);

  const resting = engine.submitOrder({ strategyId: 'MAKER', symbol: 'FOXTROT', side: 'buy', orderType: 'limit', price: 100.0, quantity: 300 });
  assert.equal(resting.accepted, true);
  assert.equal(resting.fills.length, 0, '限价单未交叉，挂出等待');

  engine.submitOrder({ strategyId: 'TAKER', symbol: 'FOXTROT', side: 'buy', orderType: 'market', quantity: 100 });
  const sell = engine.submitOrder({ strategyId: 'TAKER', symbol: 'FOXTROT', side: 'sell', orderType: 'market', quantity: 100 });
  assert.equal(sell.fills.some(f => f.liquidity === 'maker' && f.strategyId === 'MAKER' && f.quantity === 100), true, '对手方击穿产生 maker 成交');
  close(engine.account('MAKER').position['FOXTROT'], 100, 'maker 持仓同步');
  close(engine.account('TAKER').realizedPnl, 100 * (100.0 - 100.1), 'taker 平仓已实现损益');

  // 行情流（非沙盒订单）击穿剩余挂单
  tick += 1;
  engine.ingest({ id: `T-FOXTROT-${tick}`, symbol: 'FOXTROT', tradingDay: DAY, timestamp: at(tick), sequence: tick, type: 'new_order', orderId: 'MKT-1', side: 'sell', price: 99.9, quantity: 200 });
  close(engine.account('MAKER').position['FOXTROT'], 300, '行情流击穿后 maker 持仓同步');
  const makerPerf = engine.performance('MAKER');
  assert.equal(makerPerf.metrics.fillCount, 2, 'maker 成交记录可追溯');
  close(makerPerf.metrics.grossCashFlow, -(100 * 100.0 + 200 * 100.0), 'maker 现金流可追溯');
  assert.equal(engine.fills.every(f => f.strategyId), true, '沙盒成交日志只含策略成交');
  console.log('✓ 场景 5：挂单被击穿时 maker 成交同步持仓、现金与成交记录');
}

console.log('\n全部联动验证通过');
