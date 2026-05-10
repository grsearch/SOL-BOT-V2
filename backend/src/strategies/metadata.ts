import { tokenRepo } from '../db/repo.js';
import { birdeye } from '../services/birdeye/client.js';
import { helius } from '../services/helius/client.js';
import { logger } from '../utils/logger.js';
import type { Token } from '../types/index.js';

const HOLDERS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 用 Birdeye token_overview 返回的各时段历史价反推一个"近似 24h 高点"。
 *
 * Birdeye 的 history{2,6,24}hPrice 是各时段前那一刻的瞬时价。
 * 真实 24h 高点 ≥ max(history2hPrice, history6hPrice, history24hPrice, currentPrice)。
 * 这只是近似（中间还可能有更高的瞬间），但比"刚加监控时记的本地最高价"好得多。
 */
export function estimateHigh24hFromOverview(args: {
  currentPrice: number;
  history2hPrice?: number | null;
  history6hPrice?: number | null;
  history24hPrice?: number | null;
}): number {
  const candidates: number[] = [args.currentPrice];
  if (args.history2hPrice && args.history2hPrice > 0) candidates.push(args.history2hPrice);
  if (args.history6hPrice && args.history6hPrice > 0) candidates.push(args.history6hPrice);
  if (args.history24hPrice && args.history24hPrice > 0) candidates.push(args.history24hPrice);
  return Math.max(...candidates);
}

/**
 * 决定是否要从 Birdeye 拿一份新的 24h 高点估算。
 * - 若 high_24h 完全没记录 → 一定要拿
 * - 若 high_24h_at 已超 24h（stale） → 一定要拿
 * - 若 high_24h 等于或非常接近当前价（说明本地记录可能太短就触顶了）→ 也要拿
 */
function shouldFetchHigh(t: Token): boolean {
  if (!t.high_24h || !t.high_24h_at) return true;
  const ageMs = Date.now() - t.high_24h_at;
  if (ageMs > 24 * 3600 * 1000) return true;
  if (t.price_usd && t.price_usd > 0 && t.high_24h <= t.price_usd * 1.02) return true;
  return false;
}

/**
 * 刷新单个代币的链上元数据：FDV、LP、价格、24h vol、holders、age、24h 高点
 */
export async function refreshTokenMetadata(address: string): Promise<void> {
  const t = tokenRepo.get(address);
  if (!t) return;

  // 1. Birdeye overview
  const ov = await birdeye.getTokenOverview(address);
  if (ov) {
    const update: Partial<Token> = {
      symbol: ov.symbol ?? t.symbol,
      name: ov.name ?? t.name,
      decimals: ov.decimals ?? t.decimals,
      fdv_usd: ov.fdv ?? null,
      lp_usd: ov.liquidity ?? null,
      volume_24h_usd: ov.v24hUSD ?? null,
      holders: ov.holder ?? t.holders,
      price_usd: ov.price ?? t.price_usd,
      history_2h_price: ov.history2hPrice ?? null,
      history_6h_price: ov.history6hPrice ?? null,
      history_24h_price: ov.history24hPrice ?? null,
    };

    // 用 overview 历史价估算更靠谱的 24h 高点
    if (ov.price && shouldFetchHigh(t)) {
      const estHigh = estimateHigh24hFromOverview({
        currentPrice: ov.price,
        history2hPrice: ov.history2hPrice,
        history6hPrice: ov.history6hPrice,
        history24hPrice: ov.history24hPrice,
      });
      // 仅在估算出来的值显著高于当前价才覆盖
      if (estHigh > ov.price * 1.001) {
        update.high_24h = estHigh;
        update.high_24h_at = Date.now();
        logger.debug({ address, current: ov.price, est: estHigh }, '已用 overview 估算 24h 高点');
      }
    }

    tokenRepo.upsert({ address, ...update });
  }

  // 2. age
  if (!t.created_at_unix) {
    const ci = await birdeye.getTokenCreationInfo(address);
    if (ci) {
      const ageSec = Math.floor(Date.now() / 1000) - ci.createdAtUnix;
      tokenRepo.upsert({ address, created_at_unix: ci.createdAtUnix, age_seconds: ageSec });
    }
  } else {
    tokenRepo.upsert({ address, age_seconds: Math.floor(Date.now() / 1000) - t.created_at_unix });
  }

  // 3. holders
  if (!ov?.holder) {
    const lastRefresh = t.last_metadata_refresh_at ?? 0;
    if (Date.now() - lastRefresh > HOLDERS_REFRESH_INTERVAL_MS) {
      const h = await helius.getHoldersCount(address);
      if (h !== null) {
        tokenRepo.upsert({ address, holders: h });
      }
    }
  }

  tokenRepo.setLastMetadataRefreshAt(address, Date.now());
  logger.debug({ address, symbol: ov?.symbol }, '元数据已刷新');
}

/** 添加代币到监控列表（CA 自动补全 symbol/decimals 等） */
export async function addTokenToMonitor(address: string, addedBy: 'manual' | 'webhook', symbolHint?: string): Promise<void> {
  const existing = tokenRepo.get(address);
  if (existing && existing.monitor_active === 1) {
    logger.info({ address }, '代币已在监控');
    return;
  }
  const now = Date.now();
  const reactivate: Partial<{ last_alert_at: number | null; high_24h: number | null; high_24h_at: number | null }> = {};
  if (existing) {
    reactivate.last_alert_at = null;
    if (!existing.high_24h_at || now - existing.high_24h_at > 24 * 3600 * 1000) {
      reactivate.high_24h = null;
      reactivate.high_24h_at = null;
    }
  }

  tokenRepo.upsert({
    address,
    symbol: symbolHint ?? existing?.symbol ?? null,
    added_at: now,
    added_by: addedBy,
    monitor_active: 1,
    ...reactivate,
  });
  await refreshTokenMetadata(address);
}
