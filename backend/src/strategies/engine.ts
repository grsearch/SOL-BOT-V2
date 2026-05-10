import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { priceStream, type PriceTick } from '../services/birdeye/wsPrice.js';
import { tokenRepo, positionRepo, alertRepo } from '../db/repo.js';
import { buyToken, sellToken } from '../services/jupiter/executor.js';
import { refreshTokenMetadata, estimateHigh24hFromOverview } from './metadata.js';
import { birdeye } from '../services/birdeye/client.js';
import { rsi } from '../utils/rsi.js';
import type { Token } from '../types/index.js';

// 单个币的 RSI 缓存（避免每个 price tick 都重新拉 OHLCV）
interface RsiCache {
  rsi7: number | null;
  fetchedAt: number;
}

// ★ 优化：RSI(7) 在 15m K 线上变化不快，5 分钟刷新一次完全够用
const RSI_CACHE_TTL_MS = 5 * 60_000;
const AUTO_BUY_COOLDOWN_MS = 60_000;
// WS 价格兜底：超过这个时间没收到 tick 就用 REST 拉一次
// （Birdeye WS 对很多 SOL 链上小币没价格推送，必须有 REST 兜底）
const WS_STALE_THRESHOLD_MS = 2 * 60_000;
// sweep 分批：把所有活跃币分散到多个 sweep 周期里跑，避免瞬时 burst
const SWEEP_BATCH_DIVISOR = 5;       // 每次 sweep 只跑 1/5 的币，5 轮覆盖全部
const META_BATCH_DIVISOR = 5;        // 元数据刷新同理

class StrategyEngine {
  private monitorTimer: NodeJS.Timeout | null = null;
  private metadataTimer: NodeJS.Timeout | null = null;
  private pricePruneTimer: NodeJS.Timeout | null = null;
  private autoStrategyTimer: NodeJS.Timeout | null = null;

  private isProcessingPrice = new Set<string>();
  private isAutoBuying = new Set<string>();
  private rsiCache = new Map<string, RsiCache>();
  private autoBuyBackoff = new Map<string, number>();

  // 错峰索引（每次 sweep 只跑一部分币）
  private sweepIndex = 0;
  private metaSweepIndex = 0;

  // ★ WS 兜底：每个币最近一次收到 WS tick 的时间
  private lastWsTickAt = new Map<string, number>();

  start(): void {
    // 1. 价格 WebSocket
    priceStream.on('price', (tick) => this.onPriceTick(tick));
    priceStream.on('open', () => {
      const active = tokenRepo.listActive();
      for (const t of active) priceStream.subscribe(t.address);
      logger.info({ count: active.length }, '已重新订阅价格');
    });
    priceStream.start();

    for (const t of tokenRepo.listActive()) {
      priceStream.subscribe(t.address);
    }

    // 2. FDV/LP 巡检（5 分钟）
    this.monitorTimer = setInterval(
      () => this.runMonitorCheck().catch(e => logger.error({ err: e }, '巡检失败')),
      config.MONITOR_CHECK_INTERVAL_MS,
    );

    // 3. 元数据刷新（每 2 分钟跑一批，5 批覆盖全部 = 每币 10 分钟刷一次）
    this.metadataTimer = setInterval(
      () => this.runMetadataRefresh().catch(e => logger.error({ err: e }, '元数据刷新失败')),
      2 * 60 * 1000,
    );

    // 4. 自动策略评估（每 60 秒，预拉 RSI 给所有活跃币种用）
    this.autoStrategyTimer = setInterval(
      () => this.runAutoStrategySweep().catch(e => logger.error({ err: e }, '自动策略 sweep 失败')),
      config.AUTO_STRATEGY_INTERVAL_MS,
    );

    // 5. 价格历史清理
    this.pricePruneTimer = setInterval(() => {
      const removed = tokenRepo.pruneOldPriceHistory(7);
      logger.info({ removed }, '清理旧价格历史');
    }, 24 * 60 * 60 * 1000);

    setTimeout(() => this.runMetadataRefresh().catch(() => {}), 5_000);
    setTimeout(() => this.runAutoStrategySweep().catch(() => {}), 15_000);

    logger.info('策略引擎已启动');
  }

  stop(): void {
    priceStream.stop();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.metadataTimer) clearInterval(this.metadataTimer);
    if (this.autoStrategyTimer) clearInterval(this.autoStrategyTimer);
    if (this.pricePruneTimer) clearInterval(this.pricePruneTimer);
  }

  subscribeToken(address: string): void {
    priceStream.subscribe(address);
  }

  unsubscribeToken(address: string): void {
    priceStream.unsubscribe(address);
    this.rsiCache.delete(address);
    this.autoBuyBackoff.delete(address);
    this.lastWsTickAt.delete(address);
  }

  // ============== 价格 tick ==============
  private async onPriceTick(tick: PriceTick): Promise<void> {
    const t0 = tokenRepo.get(tick.address);
    if (!t0 || t0.monitor_active === 0) return;

    // 记录最近一次 WS 推送时间（兜底机制用）
    this.lastWsTickAt.set(tick.address, Date.now());
    tokenRepo.updatePrice(tick.address, tick.priceUsd, null, tick.ts);

    if (this.isProcessingPrice.has(tick.address)) return;
    this.isProcessingPrice.add(tick.address);
    try {
      const t = tokenRepo.get(tick.address);
      if (!t || t.monitor_active === 0) return;
      // 用最新价做止盈/止损（卖出）评估；买入由 sweep 处理
      await this.evaluateTakeProfit(t, tick.priceUsd);
      await this.evaluateRsiSell(t, tick.priceUsd);
    } catch (e: any) {
      logger.error({ err: e?.message, addr: tick.address }, '价格策略处理失败');
    } finally {
      this.isProcessingPrice.delete(tick.address);
    }
  }

  // ============== 卖出策略 ==============

  /** 100% 止盈：当前价 ≥ 平均买入价 × (1 + TAKE_PROFIT_GAIN_PCT/100) */
  private async evaluateTakeProfit(t: Token, currentPrice: number): Promise<void> {
    const pos = positionRepo.getOpenByToken(t.address);
    if (!pos || pos.is_open === 0 || pos.auto_take_profit_active === 0) return;
    if (!pos.avg_entry_price_usd || pos.avg_entry_price_usd <= 0) return;

    const target = pos.avg_entry_price_usd * (1 + config.TAKE_PROFIT_GAIN_PCT / 100);
    if (currentPrice < target) return;

    logger.info({ token: t.symbol, entry: pos.avg_entry_price_usd, current: currentPrice }, '触发自动止盈');
    try {
      positionRepo.setAutoTakeProfit(pos.id, false);
      const r = await sellToken({ tokenAddress: t.address, trigger: 'auto_take_profit' });
      alertRepo.insert(t.address, 'take_profit', { entry: pos.avg_entry_price_usd, exit: currentPrice, sig: r.signature });
    } catch (e: any) {
      logger.error({ err: e.message, addr: t.address }, '自动止盈卖出失败');
      positionRepo.setAutoTakeProfit(pos.id, true);
    }
  }

  /** RSI(7) 15m > RSI_SELL_THRESHOLD（默认 80）→ 立即全仓卖 */
  private async evaluateRsiSell(t: Token, currentPrice: number): Promise<void> {
    const pos = positionRepo.getOpenByToken(t.address);
    if (!pos || pos.is_open === 0) return;

    const rsi7 = await this.getRsi7Cached(t.address);
    if (rsi7 == null) return;
    if (rsi7 <= config.RSI_SELL_THRESHOLD) return;

    logger.info({ token: t.symbol, rsi7, current: currentPrice }, '触发 RSI 卖出（>阈值）');
    try {
      // 关掉自动止盈避免抢单
      positionRepo.setAutoTakeProfit(pos.id, false);
      const r = await sellToken({ tokenAddress: t.address, trigger: 'auto_rsi_sell' });
      alertRepo.insert(t.address, 'rsi_sell', { rsi7, current: currentPrice, sig: r.signature });
    } catch (e: any) {
      logger.error({ err: e.message, addr: t.address }, 'RSI 卖出失败');
      positionRepo.setAutoTakeProfit(pos.id, true);
    }
  }

  // ============== 买入策略（在 sweep 里跑，不在每个 tick） ==============

  /**
   * 自动逢低买入评估：
   *
   * - 没持仓时：24h 跌幅 ≥ AUTO_DIP_BUY_DROP_24H_PCT 且 RSI(7) < AUTO_DIP_BUY_RSI_THRESHOLD → 首次买入 1 SOL
   * - 已持仓时：相对最近一次买入价又跌 ≥ AUTO_DIP_DCA_DROP_PCT 且 RSI(7) < AUTO_DIP_BUY_RSI_THRESHOLD → DCA 补仓 1 SOL
   *   且累计买入次数 < AUTO_DIP_MAX_BUYS
   *
   * "24h 跌幅"取 max(本地 high_24h, history_24h_price) 作为参考高点。
   */
  private async evaluateAutoDipBuy(t: Token): Promise<void> {
    if (!config.AUTO_DIP_BUY_ENABLED) return;
    if (this.isAutoBuying.has(t.address)) return;

    // 退避
    const backoffUntil = this.autoBuyBackoff.get(t.address) ?? 0;
    if (Date.now() < backoffUntil) return;

    const currentPrice = t.price_usd;
    if (!currentPrice || currentPrice <= 0) return;

    const pos = positionRepo.getOpenByToken(t.address);

    if (!pos) {
      // 首次开仓判定：24h 跌幅
      // 参考高点：取 high_24h 和 history_24h_price 的最大值
      const refHigh = Math.max(
        t.high_24h ?? 0,
        t.history_24h_price ?? 0,
        // 也用 overview 估算
        estimateHigh24hFromOverview({
          currentPrice,
          history2hPrice: t.history_2h_price,
          history6hPrice: t.history_6h_price,
          history24hPrice: t.history_24h_price,
        }),
      );
      if (!refHigh || refHigh <= 0) return;
      const dropPct = ((refHigh - currentPrice) / refHigh) * 100;
      if (dropPct < config.AUTO_DIP_BUY_DROP_24H_PCT) return;

      // RSI(7) 检查
      const rsi7 = await this.getRsi7Cached(t.address);
      if (rsi7 == null) return;
      if (rsi7 >= config.AUTO_DIP_BUY_RSI_THRESHOLD) return;

      // 触发首次买入
      logger.info({
        token: t.symbol, refHigh, currentPrice, dropPct: dropPct.toFixed(1) + '%', rsi7,
      }, '触发自动逢低买入（首次）');
      this.isAutoBuying.add(t.address);
      try {
        const r = await buyToken({
          tokenAddress: t.address,
          solAmount: config.AUTO_DIP_BUY_SOL,
          trigger: 'auto_dip_buy',
        });
        alertRepo.insert(t.address, 'auto_dip_buy', { refHigh, currentPrice, dropPct, rsi7, sig: r.signature });
      } catch (e: any) {
        logger.error({ err: e.message, addr: t.address }, '自动首次买入失败');
        this.autoBuyBackoff.set(t.address, Date.now() + AUTO_BUY_COOLDOWN_MS);
      } finally {
        this.isAutoBuying.delete(t.address);
      }
      return;
    }

    // 已持仓 → DCA 判定
    if ((pos.buy_count ?? 0) >= config.AUTO_DIP_MAX_BUYS) return;
    const lastBuyPrice = pos.last_buy_price_usd ?? pos.avg_entry_price_usd;
    if (!lastBuyPrice || lastBuyPrice <= 0) return;
    const dcaDropPct = ((lastBuyPrice - currentPrice) / lastBuyPrice) * 100;
    if (dcaDropPct < config.AUTO_DIP_DCA_DROP_PCT) return;

    const rsi7 = await this.getRsi7Cached(t.address);
    if (rsi7 == null) return;
    if (rsi7 >= config.AUTO_DIP_BUY_RSI_THRESHOLD) return;

    logger.info({
      token: t.symbol, lastBuyPrice, currentPrice, dcaDropPct: dcaDropPct.toFixed(1) + '%', rsi7,
      buyCount: pos.buy_count,
    }, '触发自动 DCA 补仓');
    this.isAutoBuying.add(t.address);
    try {
      const r = await buyToken({
        tokenAddress: t.address,
        solAmount: config.AUTO_DIP_DCA_SOL,
        trigger: 'auto_dip_buy_dca',
      });
      alertRepo.insert(t.address, 'auto_dip_buy_dca', { lastBuyPrice, currentPrice, dcaDropPct, rsi7, sig: r.signature });
      // 补仓后要重新打开 auto_take_profit（如果之前关了）
      const fresh = positionRepo.getOpenByToken(t.address);
      if (fresh) positionRepo.setAutoTakeProfit(fresh.id, true);
    } catch (e: any) {
      logger.error({ err: e.message, addr: t.address }, '自动 DCA 失败');
      this.autoBuyBackoff.set(t.address, Date.now() + AUTO_BUY_COOLDOWN_MS);
    } finally {
      this.isAutoBuying.delete(t.address);
    }
  }

  // ============== 自动策略 sweep ==============
  /**
   * 错峰分批：每次只跑总币数的 1/SWEEP_BATCH_DIVISOR，分散 OHLCV 请求峰值。
   *
   * 行为：
   * 1. 对本批次的币：刷 RSI（更新缓存）+ 评估自动买入
   * 2. 对本批次的所有币：检查 WS 是否长时间没推送，如有则 REST 拉一次价格兜底
   *    （Birdeye WS 对很多 SOL 链上小币不推送，必须 REST 兜底，否则止盈/RSI 卖出全部失效）
   */
  private async runAutoStrategySweep(): Promise<void> {
    const tokens = tokenRepo.listActive();
    if (tokens.length === 0) return;

    // 分 N 批，每次只跑一批
    const batchSize = Math.max(1, Math.ceil(tokens.length / SWEEP_BATCH_DIVISOR));
    const start = (this.sweepIndex * batchSize) % tokens.length;
    const batch = tokens.slice(start, start + batchSize);
    this.sweepIndex = (this.sweepIndex + 1) % SWEEP_BATCH_DIVISOR;

    for (const t of batch) {
      try {
        await this.refreshRsi7(t.address);
        await this.evaluateAutoDipBuy(t);
      } catch (e: any) {
        logger.warn({ err: e.message, addr: t.address }, 'sweep 单币失败');
      }
    }

    // WS 兜底：所有币都检查（不只本批次），保证止盈/RSI 卖出能用到鲜活价
    await this.refreshStalePricesFromRest(tokens);
  }

  /**
   * 对长时间没收到 WS tick 的币，主动用 REST 拉一次价格更新 DB。
   * birdeye.getPrice 是轻量调用（cu 比 OHLCV 低很多），且仅对 stale 币才调。
   */
  private async refreshStalePricesFromRest(tokens: Token[]): Promise<void> {
    const now = Date.now();
    const stale: Token[] = [];
    for (const t of tokens) {
      const lastTick = this.lastWsTickAt.get(t.address) ?? 0;
      if (now - lastTick > WS_STALE_THRESHOLD_MS) {
        stale.push(t);
      }
    }
    if (stale.length === 0) return;

    logger.debug({ count: stale.length }, 'WS stale，REST 兜底拉价格');
    for (const t of stale) {
      try {
        const price = await birdeye.getPrice(t.address);
        if (price && price > 0) {
          tokenRepo.updatePrice(t.address, price, null, now);
          // 把它当成"虚拟 tick"触发止盈/RSI 卖出评估
          // 注意：不更新 lastWsTickAt（仅 WS 才更新），下次 sweep 还会兜底
          if (this.isProcessingPrice.has(t.address)) continue;
          this.isProcessingPrice.add(t.address);
          try {
            const fresh = tokenRepo.get(t.address);
            if (fresh && fresh.monitor_active === 1) {
              await this.evaluateTakeProfit(fresh, price);
              await this.evaluateRsiSell(fresh, price);
            }
          } finally {
            this.isProcessingPrice.delete(t.address);
          }
        }
      } catch (e: any) {
        logger.warn({ err: e.message, addr: t.address }, 'REST 兜底拉价格失败');
      }
    }
  }

  // ============== RSI 拉取/缓存 ==============
  private async getRsi7Cached(address: string): Promise<number | null> {
    const cached = this.rsiCache.get(address);
    if (cached && Date.now() - cached.fetchedAt < RSI_CACHE_TTL_MS) {
      return cached.rsi7;
    }
    return await this.refreshRsi7(address);
  }

  private async refreshRsi7(address: string): Promise<number | null> {
    // RSI(7) 需要至少 8 根 K 线，多拉一些缓冲
    const candles = await birdeye.getOhlcv(address, { type: '15m', limit: 30 });
    if (candles.length < 8) {
      this.rsiCache.set(address, { rsi7: null, fetchedAt: Date.now() });
      return null;
    }
    const closes = candles.map((c) => c.c).filter((p) => p > 0);
    if (closes.length < 8) {
      this.rsiCache.set(address, { rsi7: null, fetchedAt: Date.now() });
      return null;
    }
    const value = rsi(closes, 7);
    this.rsiCache.set(address, { rsi7: value, fetchedAt: Date.now() });
    return value;
  }

  // ============== FDV/LP 巡检 ==============
  private autoRemoveBackoff = new Map<string, number>();
  private static readonly AUTO_REMOVE_BACKOFF_MS = 10 * 60 * 1000;

  private async runMonitorCheck(): Promise<void> {
    const tokens = tokenRepo.listActive();
    const now = Date.now();
    for (const t of tokens) {
      const fdv = t.fdv_usd;
      const lp = t.lp_usd;
      const fdvOk = fdv == null || fdv === 0 || fdv >= config.FDV_MIN_USD;
      const lpOk = lp == null || lp === 0 || lp >= config.LP_MIN_USD;
      if (fdvOk && lpOk) continue;

      const backoffUntil = this.autoRemoveBackoff.get(t.address) ?? 0;
      if (now < backoffUntil) continue;

      logger.warn({ token: t.symbol, fdv: t.fdv_usd, lp: t.lp_usd }, '触发自动移除');

      const pos = positionRepo.getOpenByToken(t.address);
      if (pos && pos.amount_ui > 0) {
        try {
          await sellToken({ tokenAddress: t.address, trigger: 'auto_remove_sell' });
        } catch (e: any) {
          logger.error({ err: e.message, token: t.symbol }, '自动移除前卖出失败，暂不移除');
          this.autoRemoveBackoff.set(t.address, now + StrategyEngine.AUTO_REMOVE_BACKOFF_MS);
          continue;
        }
      }

      tokenRepo.setActive(t.address, false);
      this.unsubscribeToken(t.address);
      this.autoRemoveBackoff.delete(t.address);
      alertRepo.insert(t.address, 'auto_remove', { reason: 'fdv_or_lp_low', fdv: t.fdv_usd, lp: t.lp_usd });
    }
  }

  // ============== 元数据刷新（错峰分批） ==============
  private async runMetadataRefresh(): Promise<void> {
    const tokens = tokenRepo.listActive();
    if (tokens.length === 0) return;

    const batchSize = Math.max(1, Math.ceil(tokens.length / META_BATCH_DIVISOR));
    const start = (this.metaSweepIndex * batchSize) % tokens.length;
    const batch = tokens.slice(start, start + batchSize);
    this.metaSweepIndex = (this.metaSweepIndex + 1) % META_BATCH_DIVISOR;

    for (const t of batch) {
      try {
        await refreshTokenMetadata(t.address);
      } catch (e: any) {
        logger.warn({ err: e.message, addr: t.address }, '元数据刷新单币失败');
      }
    }
  }
}

export const strategyEngine = new StrategyEngine();
