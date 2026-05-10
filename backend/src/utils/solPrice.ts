import { birdeye } from '../services/birdeye/client.js';
import { SOL_MINT } from '../db/repo.js';

/**
 * SOL 价格缓存（30 秒）。
 * dashboard.ts 和 jupiter/executor.ts 都用同一份缓存，避免重复调 Birdeye。
 */
let cache: { price: number | null; ts: number } = { price: null, ts: 0 };
const TTL_MS = 30_000;

export async function getCachedSolPrice(): Promise<number | null> {
  if (Date.now() - cache.ts < TTL_MS && cache.price !== null) {
    return cache.price;
  }
  try {
    const p = await birdeye.getPrice(SOL_MINT);
    cache = { price: p, ts: Date.now() };
    return p;
  } catch {
    return cache.price;   // 失败时返回旧值，胜过 null
  }
}
