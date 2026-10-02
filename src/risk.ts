import { OrderType, Side, RiskDecision } from './types.js';

export type Account = { strategyId: string; cash: number; equity: number; position: Record<string, number>; costBasis: Record<string, number>; realizedPnl: number; ordersInWindow: number[]; cancelInWindow: number[]; peakEquity: number; maxDrawdown: number };
export type RiskContext = { symbol: string; side: Side; orderType: OrderType; price: number; quantity: number; bestBid: number | null; bestAsk: number | null; account: Account; now: number };

// 按当前估值价格重估账户：权益 = 现金 + 持仓市值。
// 估值价格缺失时回退到持仓成本，保证盘口不完整时结果稳定。
// 下单风控与绩效接口共用同一实现，确保估值口径一致。
export function markToMarket(account: Account, priceOf: (symbol: string) => number | null): number {
  let marketValue = 0;
  for (const [symbol, quantity] of Object.entries(account.position)) {
    if (!quantity) continue;
    const mark = priceOf(symbol);
    const fallback = quantity ? (account.costBasis[symbol] ?? 0) / quantity : 0;
    marketValue += quantity * (mark ?? fallback);
  }
  account.equity = +(account.cash + marketValue).toFixed(2);
  account.peakEquity = Math.max(account.peakEquity, account.equity);
  return account.equity;
}

export function checkRisk(context: RiskContext): RiskDecision {
  const { price, quantity, account, side, bestBid, bestAsk, now } = context;
  const notional = price * quantity;
  account.ordersInWindow = account.ordersInWindow.filter(time => now - time < 60_000);
  account.cancelInWindow = account.cancelInWindow.filter(time => now - time < 60_000);
  if (notional > 50_000) return { allowed: false, rule: 'capital', code: 'ORDER_NOTIONAL_LIMIT', message: '单笔模拟订单金额超过 50,000' };
  if (account.cash < notional && side === 'buy') return { allowed: false, rule: 'capital', code: 'INSUFFICIENT_CASH', message: '可用资金不足' };
  const position = account.position[context.symbol] ?? 0;
  if (side === 'sell' && position < quantity) return { allowed: false, rule: 'position', code: 'INSUFFICIENT_POSITION', message: '持仓不足，禁止卖出' };
  if (account.ordersInWindow.length >= 30) return { allowed: false, rule: 'frequency', code: 'ORDER_RATE_LIMIT', message: '60 秒内下单次数超过限制' };
  const reference = side === 'buy' ? bestAsk ?? price : bestBid ?? price;
  if (reference > 0 && Math.abs(price - reference) / reference > 0.02) return { allowed: false, rule: 'price_deviation', code: 'PRICE_DEVIATION', message: '订单价格偏离当前盘口超过 2%' };
  if (account.peakEquity > 0 && (account.peakEquity - account.equity) / account.peakEquity > account.maxDrawdown) return { allowed: false, rule: 'drawdown', code: 'MAX_DRAWDOWN', message: '策略已达到最大回撤限制' };
  return { allowed: true };
}
