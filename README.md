# 市场微观结构分析服务

纯后端 Node.js + TypeScript 服务，用于订单簿事件接入、历史行情重放、市场微观结构指标分析、策略沙盒、风险校验和撮合仿真。

## 能力范围

- 订单簿快照、逐笔成交、新单、撤单、行情事件接入
- 按交易日与时间顺序重放市场状态，支持单步、倍速运行
- 盘口深度、价差、订单失衡、冲击成本、成交概率、滑点、流动性指标
- 策略沙盒限价单/市价单模拟，保留资金、持仓、成交与审计轨迹
- 资金、持仓、下单频率、撤单率、价格偏离、最大回撤风险规则
- 价格优先/时间优先的基础撮合与部分成交
- 策略收益、风险暴露、最大回撤、成交率与异常交易事件
- 持仓按盘口中间价逐日盯市（单腿盘口回退单腿价、空盘口回退最近成交价），绩效接口与下单风控共用同一估值

## 启动

```bash
npm install
npm run dev
```

服务默认运行在 `http://127.0.0.1:6190`。

## 关键接口

```text
GET  /api/health
GET  /api/instruments
POST /api/market-data/events
GET  /api/orderbook/:symbol
POST /api/replay/sessions
GET  /api/replay/sessions/:id
POST /api/replay/sessions/:id/step
POST /api/replay/sessions/:id/run
GET  /api/analytics/:symbol
POST /api/sandbox/orders
POST /api/sandbox/cancel
GET  /api/sandbox/strategies/:strategyId/performance
GET  /api/sandbox/strategies/:strategyId/events
GET  /api/anomalies
GET  /api/metrics
```

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。
