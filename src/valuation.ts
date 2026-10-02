import { OrderBook } from './order-book.js';

export type MarketRef = {
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
};

export type MarkInput = MarketRef & {
  /** 无价盘口时回退使用的持仓成本（保持权益稳定，避免按 0 估值瞬间打穿回撤） */
  costBasis?: number;
};

export type MarkResult = {
  /** 估值价 */
  price: number | null;
  /** 价格来源，便于接口与风控核对二者使用的是同一价格 */
  source: 'mid' | 'last_trade' | 'one_sided_ask' | 'one_sided_bid' | 'cost_basis' | 'unavailable';
};

/**
 * 统一的持仓估值价选择，performance 接口与下单风控必须共用本函数：
 * 1. 双边盘口：中间价
 * 2. 单边盘口：用仅剩一侧的报价（买入价/卖出价）
 * 3. 无盘口但有最新成交价：最新成交价
 * 4. 都没有：回退到传入的成本价；成本也没有时返回 null
 */
export function resolveMarkPrice(input: MarkInput): MarkResult {
  const { bestBid, bestAsk, lastTradePrice } = input;
  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    return { price: (bestBid + bestAsk) / 2, source: 'mid' };
  }
  if (bestAsk !== null && bestAsk > 0) return { price: bestAsk, source: 'one_sided_ask' };
  if (bestBid !== null && bestBid > 0) return { price: bestBid, source: 'one_sided_bid' };
  if (lastTradePrice !== null && lastTradePrice > 0) return { price: lastTradePrice, source: 'last_trade' };
  if (input.costBasis !== undefined && input.costBasis > 0) return { price: input.costBasis, source: 'cost_basis' };
  return { price: null, source: 'unavailable' };
}

export function marketRef(book: OrderBook): MarketRef {
  const snapshot = book.snapshot(1);
  return {
    bestBid: snapshot.bids[0]?.price ?? null,
    bestAsk: snapshot.asks[0]?.price ?? null,
    lastTradePrice: book.lastTradePrice,
  };
}

/** 当前权益相对峰值的回撤比例（峰值缺失或非正时为 0），风控与接口共用同一口径 */
export function drawdownRatio(peakEquity: number, equity: number): number {
  if (!(peakEquity > 0)) return 0;
  return Math.max(0, (peakEquity - equity) / peakEquity);
}
