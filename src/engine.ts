import { OrderBook } from './order-book.js';
import { Account, checkRisk, markToMarket } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, Side } from './types.js';

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
    const fills = this.book(event.symbol).apply(event).filter(fill => fill.strategyId);
    if (fills.length) { this.fills.push(...fills); this.applyFills(fills); }
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }
  // 持仓估值价格：优先买卖中间价，盘口缺一腿时用可得一侧，盘口为空时回退到最近成交价。
  // performance 接口与下单风控共用此价格，保证估值口径一致。
  markPrice(symbol: string): number | null {
    const snapshot = this.book(symbol).snapshot(1);
    const bestBid = snapshot.bids[0]?.price ?? null;
    const bestAsk = snapshot.asks[0]?.price ?? null;
    if (bestBid !== null && bestAsk !== null) return +((bestBid + bestAsk) / 2).toFixed(6);
    if (bestBid !== null) return bestBid;
    if (bestAsk !== null) return bestAsk;
    return this.lastTradePrice(symbol);
  }
  private lastTradePrice(symbol: string): number | null {
    let price: number | null = null; let timestamp = '';
    for (const event of this.events) if (event.symbol === symbol && event.type === 'trade' && event.price != null && event.timestamp >= timestamp) { timestamp = event.timestamp; price = event.price; }
    for (const fill of this.fills) if (fill.symbol === symbol && fill.timestamp >= timestamp) { timestamp = fill.timestamp; price = fill.price; }
    return price;
  }
  revalue(account: Account): number { return markToMarket(account, symbol => this.markPrice(symbol)); }
  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string } {
    const analytics = this.analytics(input.symbol); const account = this.account(input.strategyId); this.revalue(account); const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0); const now = Date.now(); const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now }); const orderId = `SIM-${this.fills.length + 1}`; if (!risk.allowed) { this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code, equity: account.equity }); return { accepted: false, risk, fills: [], orderId }; } account.ordersInWindow.push(now); const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' }; const fills = this.book(input.symbol).execute(order, new Date().toISOString()); this.fills.push(...fills); this.applyFills(fills); if (order.remaining > 0 && input.orderType === 'market') this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { remaining: order.remaining }); return { accepted: true, risk, fills, orderId };
  }
  cancel(strategyId: string, orderId: string): boolean { const account = this.account(strategyId); account.cancelInWindow.push(Date.now()); for (const book of this.books.values()) if (book.cancel(orderId)) return true; return false; }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, costBasis: {}, realizedPnl: 0, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }
  performance(strategyId: string) {
    const account = this.account(strategyId); this.revalue(account); const fills = this.fills.filter(fill => fill.strategyId === strategyId); const grossCashFlow = fills.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0); const fees = fills.reduce((sum, fill) => sum + fill.fee, 0);
    const exposure = Object.entries(account.position).filter(([, quantity]) => quantity !== 0).map(([symbol, quantity]) => { const averageCost = (account.costBasis[symbol] ?? 0) / quantity; const price = this.markPrice(symbol) ?? averageCost; return { symbol, quantity, averageCost: +averageCost.toFixed(4), markPrice: +price.toFixed(4), marketValue: +(quantity * price).toFixed(2), unrealizedPnl: +(quantity * (price - averageCost)).toFixed(2) }; });
    const unrealizedPnl = exposure.reduce((sum, item) => sum + item.unrealizedPnl, 0); const realizedPnl = account.realizedPnl; const drawdown = account.peakEquity > 0 ? (account.peakEquity - account.equity) / account.peakEquity : 0;
    return { strategyId, account, metrics: { fillCount: fills.length, tradedNotional: +fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0).toFixed(2), grossCashFlow: +grossCashFlow.toFixed(2), fees: +fees.toFixed(2), realizedPnl: +realizedPnl.toFixed(2), unrealizedPnl: +unrealizedPnl.toFixed(2), netPnl: +(realizedPnl + unrealizedPnl - fees).toFixed(2), equity: account.equity, drawdown: +drawdown.toFixed(4), maxDrawdown: account.maxDrawdown, exposure } };
  }
  private applyFills(fills: Fill[]): void {
    const touched = new Set<string>();
    for (const fill of fills) {
      if (!fill.strategyId) continue;
      const account = this.account(fill.strategyId); touched.add(fill.strategyId);
      const position = account.position[fill.symbol] ?? 0; const basis = account.costBasis[fill.symbol] ?? 0;
      if (fill.side === 'buy') {
        account.position[fill.symbol] = position + fill.quantity;
        account.costBasis[fill.symbol] = +(basis + fill.price * fill.quantity).toFixed(6);
        account.cash = +(account.cash - (fill.price * fill.quantity + fill.fee)).toFixed(6);
      } else {
        const averageCost = position > 0 ? basis / position : 0; const closing = Math.min(fill.quantity, Math.max(position, 0));
        account.realizedPnl = +(account.realizedPnl + closing * (fill.price - averageCost)).toFixed(6);
        account.position[fill.symbol] = position - fill.quantity;
        account.costBasis[fill.symbol] = +(basis - averageCost * closing).toFixed(6);
        account.cash = +(account.cash + fill.price * fill.quantity - fill.fee).toFixed(6);
      }
      if (Math.abs(account.position[fill.symbol]) < 1e-9) { account.position[fill.symbol] = 0; account.costBasis[fill.symbol] = 0; }
    }
    for (const strategyId of touched) this.revalue(this.account(strategyId));
  }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}
