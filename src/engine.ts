import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, Side } from './types.js';
import { drawdownRatio, marketRef, resolveMarkPrice } from './valuation.js';

export type PositionValuation = {
  symbol: string;
  quantity: number;
  averageCost: number;
  markPrice: number | null;
  markSource: string;
  marketValue: number;
  unrealizedPnl: number;
};

const INITIAL_CASH = 1_000_000;

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();
  private orderSequence = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence); this.book(event.symbol).apply(event);
    // 行情变化后重算全部持仓盯市，保证重复查询 performance / 下单风控拿到的是同一最新估值
    for (const account of this.accounts.values()) this.refreshValuation(account);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }
  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string } {
    const analytics = this.analytics(input.symbol); const account = this.account(input.strategyId);
    // 风控前先按最新行情盯市，使最大回撤判断反映当前未实现损益
    this.refreshValuation(account);
    const now = Date.now();
    const orderId = `SIM-${++this.orderSequence}`;
    const reject = (risk: ReturnType<typeof checkRisk>) => {
      this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code });
      return { accepted: false, risk, fills: [], orderId };
    };
    let price = input.price;
    if (price === undefined) {
      // 市价单只取对手盘最优价；盘口缺边时传 0，由风控以 NO_MARKET_PRICE 拒绝
      price = input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0;
    }
    const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now });
    if (!risk.allowed) return reject(risk);
    account.ordersInWindow.push(now);
    const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' };
    const fills = this.book(input.symbol).execute(order, new Date().toISOString());
    this.fills.push(...fills);
    this.applyFills(account, fills);
    if (order.remaining > 0 && input.orderType === 'market') this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { remaining: order.remaining });
    return { accepted: true, risk, fills, orderId };
  }
  cancel(strategyId: string, orderId: string): boolean { const account = this.account(strategyId); account.cancelInWindow.push(Date.now()); for (const book of this.books.values()) if (book.cancel(orderId)) return true; return false; }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: INITIAL_CASH, equity: INITIAL_CASH, position: {}, lots: {}, realizedPnl: 0, totalFees: 0, ordersInWindow: [], cancelInWindow: [], peakEquity: INITIAL_CASH, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }

  /**
   * 按当前行情对账户全部持仓盯市，刷新 equity / peakEquity。
   * 幂等：重复调用只依赖当前盘口，不产生任何现金流、成交或已实现损益变动。
   * 返回各持仓估值明细，performance 接口直接复用，保证与风控同价同源。
   */
  refreshValuation(account: Account): { positions: PositionValuation[]; equity: number; drawdownRatio: number } {
    const positions: PositionValuation[] = [];
    let marketValue = 0;
    for (const [symbol, quantity] of Object.entries(account.position)) {
      if (quantity === 0) continue;
      const ref = marketRef(this.book(symbol));
      const lot = account.lots[symbol];
      const mark = resolveMarkPrice({ ...ref, costBasis: lot?.averageCost });
      const markPrice = mark.price;
      const value = markPrice !== null ? markPrice * quantity : 0;
      marketValue += value;
      positions.push({
        symbol,
        quantity,
        averageCost: lot?.averageCost ?? 0,
        markPrice,
        markSource: mark.source,
        marketValue: +value.toFixed(4),
        unrealizedPnl: markPrice !== null && lot ? +((markPrice - lot.averageCost) * quantity).toFixed(4) : 0,
      });
    }
    account.equity = +(account.cash + marketValue).toFixed(6);
    // 权益创新高时抬升峰值；回落时峰值不动 —— 回撤判定的标准做法，且对重复查询幂等
    account.peakEquity = Math.max(account.peakEquity, account.equity);
    return { positions, equity: account.equity, drawdownRatio: drawdownRatio(account.peakEquity, account.equity) };
  }

  performance(strategyId: string) {
    const account = this.account(strategyId);
    const valuation = this.refreshValuation(account);
    const byStrategy = this.fills.filter(fill => fill.strategyId === strategyId);
    // 现金流口径：买入付钱（含费）为负，卖出收钱（扣费）为正；成交记录保留逐笔可追溯
    const grossCashFlow = byStrategy.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0);
    const fees = byStrategy.reduce((sum, fill) => sum + fill.fee, 0);
    // 手续费对买卖双方均为现金流出：净现金流 = 总现金流 - 手续费
    const netCashFlow = grossCashFlow - fees;
    const unrealizedPnl = valuation.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      strategyId,
      cash: +account.cash.toFixed(4),
      equity: +account.equity.toFixed(4),
      peakEquity: +account.peakEquity.toFixed(4),
      realizedPnl: +account.realizedPnl.toFixed(4),
      unrealizedPnl: +unrealizedPnl.toFixed(4),
      totalFees: +account.totalFees.toFixed(4),
      grossCashFlow: +grossCashFlow.toFixed(4),
      netCashFlow: +netCashFlow.toFixed(4),
      netPnl: +(account.realizedPnl + unrealizedPnl - fees).toFixed(4),
      drawdownRatio: +valuation.drawdownRatio.toFixed(6),
      maxDrawdown: account.maxDrawdown,
      drawdownBreached: valuation.drawdownRatio > account.maxDrawdown,
      metrics: {
        fillCount: byStrategy.length,
        tradedNotional: +byStrategy.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2),
        grossCashFlow: +grossCashFlow.toFixed(2),
        fees: +fees.toFixed(2),
        netPnl: +(account.realizedPnl + unrealizedPnl - fees).toFixed(2),
      },
      positions: valuation.positions,
      exposure: valuation.positions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
      fills: byStrategy,
    };
  }

  private applyFills(account: Account, fills: Fill[]): void {
    for (const fill of fills) {
      account.totalFees += fill.fee;
      const lot = account.lots[fill.symbol] ?? { quantity: 0, averageCost: 0 };
      if (fill.side === 'buy') {
        // 加仓：按成交量加权更新平均成本（手续费不计入成本，费用单列）
        const newQuantity = lot.quantity + fill.quantity;
        lot.averageCost = (lot.averageCost * lot.quantity + fill.price * fill.quantity) / newQuantity;
        lot.quantity = newQuantity;
        account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + fill.quantity;
        account.cash -= fill.price * fill.quantity + fill.fee;
      } else {
        // 平仓（本沙盒只允许多头平仓）：按平均成本结转已实现损益
        const closing = Math.min(fill.quantity, lot.quantity);
        account.realizedPnl += (fill.price - lot.averageCost) * closing;
        lot.quantity -= closing;
        if (lot.quantity <= 0) lot.quantity = 0;
        const netPosition = (account.position[fill.symbol] ?? 0) - fill.quantity;
        if (netPosition === 0) {
          delete account.position[fill.symbol];
          delete account.lots[fill.symbol];
        } else {
          account.position[fill.symbol] = netPosition;
          account.lots[fill.symbol] = lot;
        }
        account.cash += fill.price * fill.quantity - fill.fee;
        continue;
      }
      account.lots[fill.symbol] = lot;
    }
    // 成交后立即按最新盘口盯市，权益 = 现金 + 持仓市值
    this.refreshValuation(account);
  }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}
