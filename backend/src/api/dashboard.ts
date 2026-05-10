import { tokenRepo, positionRepo, tradeRepo } from '../db/repo.js';
import { wallet } from '../wallet/index.js';
import type { TokenView, DashboardStats } from '../types/index.js';
import { getCachedSolPrice } from '../utils/solPrice.js';

export async function getDashboardStats(): Promise<DashboardStats> {
  const since24h = Date.now() - 24 * 3600 * 1000;
  const realized = positionRepo.pnlSince(since24h);
  const trades24h = tradeRepo.countSince(since24h);

  const positions = positionRepo.listOpen();
  const solPrice = await getCachedSolPrice();
  let unrealized = 0;
  for (const p of positions) {
    const t = tokenRepo.get(p.token_address);
    if (!t?.price_usd || !solPrice) continue;
    const valueUsd = t.price_usd * p.amount_ui;
    const valueSol = valueUsd / solPrice;
    unrealized += valueSol - p.sol_spent;
  }

  let solBalance = 0;
  let address = '';
  if (wallet.isUnlocked) {
    address = wallet.address;
    try { solBalance = await wallet.getSolBalance(); } catch { /* ignore */ }
  }

  return {
    pnl_24h_sol: realized.realized + unrealized,
    realized_pnl_24h_sol: realized.realized,
    unrealized_pnl_sol: unrealized,
    trades_24h: trades24h,
    active_tokens: tokenRepo.listActive().length,
    open_positions: positions.length,
    wallet_sol_balance: solBalance,
    wallet_address: address,
  };
}

export async function getTokenViews(): Promise<TokenView[]> {
  const tokens = tokenRepo.listActive();
  const positions = new Map(positionRepo.listOpen().map(p => [p.token_address, p]));
  const solPrice = await getCachedSolPrice();

  const views: TokenView[] = tokens.map((t) => {
    let pctFromHigh: number | null = null;
    if (t.high_24h && t.high_24h > 0 && t.price_usd) {
      pctFromHigh = ((t.price_usd - t.high_24h) / t.high_24h) * 100;
    }
    const pos = positions.get(t.address);
    let unrealized: number | null = null;
    if (pos && t.price_usd && solPrice) {
      const valueSol = (t.price_usd * pos.amount_ui) / solPrice;
      unrealized = valueSol - pos.sol_spent;
    }
    return {
      ...t,
      pct_from_high_24h: pctFromHigh,
      pct_change_24h: pctFromHigh,
      has_open_position: !!pos,
      position_amount_ui: pos?.amount_ui ?? null,
      unrealized_pnl_sol: unrealized,
      avg_entry_price_usd: pos?.avg_entry_price_usd ?? null,
      sol_spent: pos?.sol_spent ?? null,
      last_buy_price_usd: pos?.last_buy_price_usd ?? null,
    };
  });

  // 按跌幅排序：跌得最多的在最前（pct_from_high_24h 越小越靠前）
  // null 排到最后
  views.sort((a, b) => {
    const av = a.pct_from_high_24h;
    const bv = b.pct_from_high_24h;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  });

  return views;
}
