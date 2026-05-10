import { getDb } from './migrate.js';
import type { Token, Position, Trade } from '../types/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============ tokens ============

// 允许通过 upsert 写入的字段白名单（防 SQL 注入：键名直接拼到 SET 子句里）
const TOKEN_UPDATABLE_FIELDS = new Set<keyof Token>([
  'symbol', 'name', 'decimals',
  'fdv_usd', 'lp_usd', 'holders', 'age_seconds', 'created_at_unix',
  'price_usd', 'price_sol', 'high_24h', 'high_24h_at', 'volume_24h_usd',
  'history_2h_price', 'history_6h_price', 'history_24h_price',
  'x_mentions_60m', 'x_engagement_avg', 'x_heat_score', 'x_last_query_at',
  'monitor_active', 'added_at', 'added_by',
  'last_alert_at', 'last_metadata_refresh_at',
]);

export const tokenRepo = {
  upsert(t: Partial<Token> & { address: string }): void {
    const db = getDb();
    const existing = db.prepare('SELECT address FROM tokens WHERE address = ?').get(t.address);
    if (existing) {
      // 仅更新提供的字段（白名单校验，防 SQL 注入）
      const fields: string[] = [];
      const values: any[] = [];
      for (const [k, v] of Object.entries(t)) {
        if (k === 'address') continue;
        if (v === undefined) continue;
        if (!TOKEN_UPDATABLE_FIELDS.has(k as keyof Token)) continue;
        fields.push(`${k} = ?`);
        values.push(v);
      }
      if (fields.length === 0) return;
      values.push(t.address);
      db.prepare(`UPDATE tokens SET ${fields.join(', ')} WHERE address = ?`).run(...values);
    } else {
      db.prepare(`
        INSERT INTO tokens (address, symbol, name, decimals, monitor_active, added_at, added_by, x_mentions_60m, x_engagement_avg, x_heat_score)
        VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0, 0)
      `).run(t.address, t.symbol ?? null, t.name ?? null, t.decimals ?? null, t.added_at ?? Date.now(), t.added_by ?? 'manual');
      // 然后再 update 其他字段
      this.upsert(t);
    }
  },

  get(address: string): Token | undefined {
    return getDb().prepare('SELECT * FROM tokens WHERE address = ?').get(address) as Token | undefined;
  },

  listActive(): Token[] {
    return getDb().prepare('SELECT * FROM tokens WHERE monitor_active = 1 ORDER BY added_at DESC').all() as Token[];
  },

  listAll(): Token[] {
    return getDb().prepare('SELECT * FROM tokens ORDER BY added_at DESC').all() as Token[];
  },

  setActive(address: string, active: boolean): void {
    getDb().prepare('UPDATE tokens SET monitor_active = ? WHERE address = ?').run(active ? 1 : 0, address);
  },

  updatePrice(address: string, priceUsd: number, priceSol: number | null, ts: number): void {
    const db = getDb();
    const tx = db.transaction(() => {
      // 价格快照写入历史
      db.prepare('INSERT OR IGNORE INTO price_history (token_address, ts, price_usd) VALUES (?, ?, ?)')
        .run(address, Math.floor(ts / 1000), priceUsd);
      // 更新当前价
      db.prepare('UPDATE tokens SET price_usd = ?, price_sol = ? WHERE address = ?')
        .run(priceUsd, priceSol, address);
      // 维护 24h 高点（要么没记录、要么 24h 之前的旧高点、要么被超越）
      const row = db.prepare('SELECT high_24h, high_24h_at FROM tokens WHERE address = ?').get(address) as
        | { high_24h: number | null; high_24h_at: number | null }
        | undefined;
      const cutoff = ts - 24 * 3600 * 1000;
      const stale = !row?.high_24h_at || row.high_24h_at < cutoff;
      if (stale) {
        // 重新从 price_history 算 24h 真实高点（取最大价以及对应的时间戳）
        const hi = db.prepare(`
          SELECT price_usd as max_p, ts FROM price_history
          WHERE token_address = ? AND ts >= ?
          ORDER BY price_usd DESC LIMIT 1
        `).get(address, Math.floor(cutoff / 1000)) as { max_p: number | null; ts: number | null } | undefined;
        const histHigh = hi?.max_p ?? 0;
        const histHighAt = hi?.ts ? hi.ts * 1000 : ts;
        // 当前 tick 价 vs 历史高点
        if (priceUsd >= histHigh) {
          db.prepare('UPDATE tokens SET high_24h = ?, high_24h_at = ? WHERE address = ?')
            .run(priceUsd, ts, address);
        } else {
          db.prepare('UPDATE tokens SET high_24h = ?, high_24h_at = ? WHERE address = ?')
            .run(histHigh, histHighAt, address);
        }
      } else if (priceUsd > (row.high_24h ?? 0)) {
        db.prepare('UPDATE tokens SET high_24h = ?, high_24h_at = ? WHERE address = ?')
          .run(priceUsd, ts, address);
      }
    });
    tx();
  },

  setLastAlertAt(address: string, ts: number): void {
    getDb().prepare('UPDATE tokens SET last_alert_at = ? WHERE address = ?').run(ts, address);
  },

  setLastMetadataRefreshAt(address: string, ts: number): void {
    getDb().prepare('UPDATE tokens SET last_metadata_refresh_at = ? WHERE address = ?').run(ts, address);
  },

  pruneOldPriceHistory(daysToKeep = 7): number {
    const cutoff = Math.floor((Date.now() - daysToKeep * 86400 * 1000) / 1000);
    return getDb().prepare('DELETE FROM price_history WHERE ts < ?').run(cutoff).changes;
  },
};

// ============ positions ============

export const positionRepo = {
  getOpenByToken(tokenAddress: string): Position | undefined {
    return getDb()
      .prepare('SELECT * FROM positions WHERE token_address = ? AND is_open = 1')
      .get(tokenAddress) as Position | undefined;
  },

  listOpen(): Position[] {
    return getDb().prepare('SELECT * FROM positions WHERE is_open = 1').all() as Position[];
  },

  /** 买入后更新或创建持仓 */
  applyBuy(args: {
    token_address: string;
    amount_raw_added: string;
    amount_ui_added: number;
    sol_spent: number;
    price_usd: number;
    price_sol: number;
    ts: number;
  }): Position {
    const db = getDb();
    const existing = this.getOpenByToken(args.token_address);
    if (existing) {
      const newAmountUi = existing.amount_ui + args.amount_ui_added;
      const newAmountRaw = (BigInt(existing.amount_raw) + BigInt(args.amount_raw_added)).toString();
      const newSolSpent = existing.sol_spent + args.sol_spent;
      const newAvgPriceSol = newSolSpent / newAmountUi;
      const newAvgPriceUsd = (existing.avg_entry_price_usd * existing.amount_ui + args.price_usd * args.amount_ui_added) / newAmountUi;
      const newBuyCount = (existing.buy_count ?? 0) + 1;
      db.prepare(`
        UPDATE positions
        SET amount_raw = ?, amount_ui = ?, avg_entry_price_usd = ?, avg_entry_price_sol = ?,
            sol_spent = ?, last_buy_price_usd = ?, buy_count = ?
        WHERE id = ?
      `).run(newAmountRaw, newAmountUi, newAvgPriceUsd, newAvgPriceSol,
        newSolSpent, args.price_usd, newBuyCount, existing.id);
      return this.getOpenByToken(args.token_address)!;
    }
    db.prepare(`
      INSERT INTO positions
        (token_address, amount_raw, amount_ui, avg_entry_price_usd, avg_entry_price_sol,
         sol_spent, realized_pnl_sol, is_open, opened_at, auto_take_profit_active,
         last_buy_price_usd, buy_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, 1, ?, 1)
    `).run(
      args.token_address,
      args.amount_raw_added,
      args.amount_ui_added,
      args.price_usd,
      args.price_sol,
      args.sol_spent,
      args.ts,
      args.price_usd,
    );
    return this.getOpenByToken(args.token_address)!;
  },

  /** 卖出 - 返回 { position, realized }（本次实现的 SOL 盈亏） */
  applySell(args: {
    token_address: string;
    amount_raw_sold: string;
    amount_ui_sold: number;
    sol_received: number;
    ts: number;
  }): { position: Position | undefined; realized: number } {
    const db = getDb();
    const p = this.getOpenByToken(args.token_address);
    if (!p) return { position: undefined, realized: 0 };
    const remainingUi = p.amount_ui - args.amount_ui_sold;
    const remainingRaw = (BigInt(p.amount_raw) - BigInt(args.amount_raw_sold)).toString();
    // 已实现盈亏：按比例的成本 vs 收到的 SOL
    const sellRatio = p.amount_ui > 0 ? (args.amount_ui_sold / p.amount_ui) : 1;
    const costPortion = p.sol_spent * sellRatio;
    const realized = args.sol_received - costPortion;
    if (remainingUi <= 1e-9 || BigInt(remainingRaw) <= 0n) {
      db.prepare(`
        UPDATE positions SET amount_raw = '0', amount_ui = 0, realized_pnl_sol = realized_pnl_sol + ?, is_open = 0, closed_at = ?
        WHERE id = ?
      `).run(realized, args.ts, p.id);
    } else {
      const remainingSolSpent = p.sol_spent - costPortion;
      db.prepare(`
        UPDATE positions SET amount_raw = ?, amount_ui = ?, sol_spent = ?, realized_pnl_sol = realized_pnl_sol + ?
        WHERE id = ?
      `).run(remainingRaw, remainingUi, remainingSolSpent, realized, p.id);
    }
    return { position: this.getOpenByToken(args.token_address), realized };
  },

  /** 仅在仓位仍开仓时设置 auto_take_profit；防止脏写 */
  setAutoTakeProfit(positionId: number, active: boolean): void {
    getDb().prepare('UPDATE positions SET auto_take_profit_active = ? WHERE id = ? AND is_open = 1')
      .run(active ? 1 : 0, positionId);
  },

  pnlSince(sinceMs: number): { realized: number } {
    // 已实现 = 24h 内所有 sell 成功交易的 realized_pnl_sol 之和
    const r = getDb().prepare(`
      SELECT COALESCE(SUM(realized_pnl_sol), 0) as realized FROM trades
      WHERE side = 'sell' AND status = 'success' AND realized_pnl_sol IS NOT NULL
        AND created_at >= ?
    `).get(sinceMs) as { realized: number };
    return { realized: r.realized || 0 };
  },
};

// ============ trades ============

export const tradeRepo = {
  insertPending(t: Omit<Trade, 'id' | 'tx_signature' | 'confirmed_at' | 'error_msg'> & {
    tx_signature?: string | null;
  }): number {
    const r = getDb().prepare(`
      INSERT INTO trades
        (token_address, side, trigger, in_mint, out_mint, in_amount_raw, out_amount_raw,
         in_amount_ui, out_amount_ui, price_usd_at_trade, sol_price_usd_at_trade,
         tx_signature, status, slippage_bps, priority_fee_lamports, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      t.token_address, t.side, t.trigger, t.in_mint, t.out_mint,
      t.in_amount_raw, t.out_amount_raw, t.in_amount_ui, t.out_amount_ui,
      t.price_usd_at_trade, t.sol_price_usd_at_trade,
      t.tx_signature ?? null, t.status, t.slippage_bps, t.priority_fee_lamports, t.created_at,
    );
    return r.lastInsertRowid as number;
  },

  markSuccess(id: number, sig: string, confirmedAt: number, opts?: { outAmountRaw?: string; outAmountUi?: number; realizedPnlSol?: number | null }): void {
    const db = getDb();
    const fields: string[] = ['status = ?', 'tx_signature = ?', 'confirmed_at = ?'];
    const values: any[] = ['success', sig, confirmedAt];
    if (opts?.outAmountRaw !== undefined) {
      fields.push('out_amount_raw = ?');
      values.push(opts.outAmountRaw);
    }
    if (opts?.outAmountUi !== undefined) {
      fields.push('out_amount_ui = ?');
      values.push(opts.outAmountUi);
    }
    if (opts?.realizedPnlSol !== undefined && opts.realizedPnlSol !== null) {
      fields.push('realized_pnl_sol = ?');
      values.push(opts.realizedPnlSol);
    }
    values.push(id);
    db.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  markFailed(id: number, err: string, sig?: string | null): void {
    getDb().prepare('UPDATE trades SET status = ?, error_msg = ?, tx_signature = COALESCE(?, tx_signature) WHERE id = ?')
      .run('failed', err, sig ?? null, id);
  },

  list(limit = 100): Trade[] {
    return getDb().prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit) as Trade[];
  },

  countSince(sinceMs: number): number {
    const r = getDb().prepare('SELECT COUNT(*) as c FROM trades WHERE created_at >= ?').get(sinceMs) as { c: number };
    return r.c;
  },
};

// ============ alerts ============

export const alertRepo = {
  insert(tokenAddress: string, type: string, payload: any, success = true): number {
    const r = getDb().prepare(`
      INSERT INTO alerts (token_address, type, payload_json, sent_at, success)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenAddress, type, JSON.stringify(payload), Date.now(), success ? 1 : 0);
    return r.lastInsertRowid as number;
  },
};

export { SOL_MINT };
