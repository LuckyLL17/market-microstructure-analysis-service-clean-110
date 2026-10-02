import { BookOrder, Fill, MarketEvent, PriceLevel, Side } from './types.js';

export class OrderBook {
  private readonly bids = new Map<number, BookOrder[]>();
  private readonly asks = new Map<number, BookOrder[]>();
  private lastTimestamp = '';
  private lastSequence = 0;
  private tradeCount = 0;
  private tradedQuantity = 0;
  private _lastTradePrice: number | null = null;

  get lastTradePrice(): number | null { return this._lastTradePrice; }

  constructor(public readonly symbol: string) {}

  apply(event: MarketEvent): void {
    this.lastTimestamp = event.timestamp;
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    if (event.type === 'snapshot') {
      this.bids.clear(); this.asks.clear();
      for (const level of event.bids ?? []) this.seedLevel('buy', level, event.sequence);
      for (const level of event.asks ?? []) this.seedLevel('sell', level, event.sequence);
    } else if (event.type === 'quote') {
      // 行情报价：只携带某一边时，仅替换该一边盘口（买卖双方盘口不完整也要稳定）
      if (event.bids) { this.bids.clear(); for (const level of event.bids) this.seedLevel('buy', level, event.sequence); }
      if (event.asks) { this.asks.clear(); for (const level of event.asks) this.seedLevel('sell', level, event.sequence); }
    } else if (event.type === 'new_order' && event.orderId && event.side && event.price && event.quantity) {
      this.execute({ id: event.orderId, side: event.side, price: event.price, quantity: event.quantity, remaining: event.quantity, sequence: event.sequence, type: 'limit' }, event.timestamp);
    } else if (event.type === 'cancel_order' && event.orderId) {
      this.cancel(event.orderId);
    } else if (event.type === 'trade' && event.price && event.quantity) {
      this._lastTradePrice = event.price;
      this.consume(event.aggressorSide ?? 'buy', event.quantity);
      this.tradeCount += 1; this.tradedQuantity += event.quantity;
    }
  }

  add(order: BookOrder): void {
    const levels = order.side === 'buy' ? this.bids : this.asks;
    const queue = levels.get(order.price) ?? [];
    queue.push(order); levels.set(order.price, queue);
  }

  cancel(orderId: string): boolean {
    for (const levels of [this.bids, this.asks]) {
      for (const [price, queue] of levels) {
        const index = queue.findIndex(order => order.id === orderId);
        if (index >= 0) { queue.splice(index, 1); if (!queue.length) levels.delete(price); return true; }
      }
    }
    return false;
  }

  execute(order: BookOrder, timestamp: string): Fill[] {
    const fills: Fill[] = [];
    let remaining = order.remaining;
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    const prices = [...opposite.keys()].sort((a, b) => order.side === 'buy' ? a - b : b - a);
    for (const price of prices) {
      if (order.type !== undefined && order.type === 'limit' && (order.side === 'buy' ? price > order.price : price < order.price)) break;
      const queue = opposite.get(price) ?? [];
      while (queue.length && remaining > 0) {
        const resting = queue[0];
        const quantity = Math.min(remaining, resting.remaining);
        resting.remaining -= quantity; remaining -= quantity;
        fills.push({ orderId: order.id, symbol: this.symbol, side: order.side, price, quantity, timestamp, liquidity: 'taker', fee: +(price * quantity * 0.00025).toFixed(4), strategyId: order.owner });
        if (resting.remaining <= 0) queue.shift();
      }
      if (!queue.length) opposite.delete(price);
      if (remaining <= 0) break;
    }
    order.remaining = remaining;
    if (remaining > 0 && order.type === 'limit') this.add(order);
    if (fills.length) this._lastTradePrice = fills[fills.length - 1].price;
    return fills;
  }

  consume(aggressor: Side, quantity: number): void {
    const levels = aggressor === 'buy' ? this.asks : this.bids;
    let remaining = quantity;
    const prices = [...levels.keys()].sort((a, b) => aggressor === 'buy' ? a - b : b - a);
    for (const price of prices) {
      const queue = levels.get(price) ?? [];
      while (queue.length && remaining > 0) { const item = queue[0]; const used = Math.min(remaining, item.remaining); item.remaining -= used; remaining -= used; if (item.remaining <= 0) queue.shift(); }
      if (!queue.length) levels.delete(price); if (remaining <= 0) break;
    }
  }

  snapshot(depth = 10): { bids: PriceLevel[]; asks: PriceLevel[]; sequence: number; timestamp: string } {
    return { bids: this.levels(this.bids, 'buy', depth), asks: this.levels(this.asks, 'sell', depth), sequence: this.lastSequence, timestamp: this.lastTimestamp };
  }

  private seedLevel(side: Side, level: PriceLevel, sequence: number): void { this.add({ id: `seed-${side}-${level.price}`, side, price: level.price, quantity: level.quantity, remaining: level.quantity, sequence }); }
  private levels(map: Map<number, BookOrder[]>, side: Side, depth: number): PriceLevel[] { return [...map.entries()].sort((a, b) => side === 'buy' ? b[0] - a[0] : a[0] - b[0]).slice(0, depth).map(([price, orders]) => ({ price, quantity: +orders.reduce((sum, item) => sum + item.remaining, 0).toFixed(4) })); }
  getStats() { return { tradeCount: this.tradeCount, tradedQuantity: this.tradedQuantity, lastTradePrice: this._lastTradePrice, sequence: this.lastSequence, timestamp: this.lastTimestamp }; }
  queueAhead(side: Side, price: number): number { const queue = (side === 'buy' ? this.bids : this.asks).get(price) ?? []; return queue.reduce((sum, item) => sum + item.remaining, 0); }
}
