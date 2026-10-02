import { OrderType, Side, RiskDecision } from './types.js';
import { drawdownRatio } from './valuation.js';

export type PositionLot = { quantity: number; averageCost: number };
export type Account = {
  strategyId: string;
  cash: number;
  /** 最新盯市权益 = 现金 + 持仓市值，由 engine 按当前行情刷新后传入 */
  equity: number;
  position: Record<string, number>;
  /** 持仓成本台账，与 position 同步维护，用于平仓已实现损益与无价盘口回退估值 */
  lots: Record<string, PositionLot>;
  /** 累计已实现损益（不含手续费，手续费单列，保证现金流可追溯） */
  realizedPnl: number;
  totalFees: number;
  ordersInWindow: number[];
  cancelInWindow: number[];
  peakEquity: number;
  maxDrawdown: number;
};
export type RiskContext = {
  symbol: string;
  side: Side;
  orderType: OrderType;
  price: number;
  quantity: number;
  bestBid: number | null;
  bestAsk: number | null;
  account: Account;
  now: number;
};

export function checkRisk(context: RiskContext): RiskDecision {
  const { price, quantity, account, side, bestBid, bestAsk, now } = context;
  if (!(quantity > 0)) return { allowed: false, rule: 'capital', code: 'INVALID_QUANTITY', message: '订单数量必须为正数' };
  // 市价单在对手盘缺失时无法取得有效估值价，直接拒绝，避免按 0 价成交
  if (!(price > 0)) return { allowed: false, rule: 'price_deviation', code: 'NO_MARKET_PRICE', message: '当前盘口缺少有效报价，无法确定订单价格' };
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
  // account.equity 已由 engine 在风控前按最新行情盯市刷新，回撤判断与 performance 接口同口径
  if (drawdownRatio(account.peakEquity, account.equity) > account.maxDrawdown) {
    return { allowed: false, rule: 'drawdown', code: 'MAX_DRAWDOWN', message: '策略已达到最大回撤限制' };
  }
  return { allowed: true };
}
