export interface Token {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  fdv_usd: number | null;
  lp_usd: number | null;
  holders: number | null;
  age_seconds: number | null;
  created_at_unix: number | null;
  price_usd: number | null;
  price_sol: number | null;
  high_24h: number | null;
  high_24h_at: number | null;
  volume_24h_usd: number | null;
  history_2h_price: number | null;
  history_6h_price: number | null;
  history_24h_price: number | null;
  // X mentions（已废弃，但 schema 保留兼容）
  x_mentions_60m: number;
  x_engagement_avg: number;
  x_heat_score: number;
  x_last_query_at: number | null;
  monitor_active: number;
  added_at: number;
  added_by: string | null;
  last_alert_at: number | null;
  last_metadata_refresh_at: number | null;
}

export interface Position {
  id: number;
  token_address: string;
  amount_raw: string;
  amount_ui: number;
  avg_entry_price_usd: number;
  avg_entry_price_sol: number;
  sol_spent: number;
  realized_pnl_sol: number;
  is_open: number;
  opened_at: number;
  closed_at: number | null;
  auto_take_profit_active: number;
  last_buy_price_usd: number | null;   // DCA 判定基准
  buy_count: number;                   // 含 DCA 的累计买入次数
}

export type TradeTrigger =
  | 'manual'
  | 'auto_take_profit'
  | 'auto_remove_sell'
  | 'auto_dip_buy'
  | 'auto_dip_buy_dca'
  | 'auto_rsi_sell';

export interface Trade {
  id: number;
  token_address: string;
  side: 'buy' | 'sell';
  trigger: TradeTrigger;
  in_mint: string;
  out_mint: string;
  in_amount_raw: string;
  out_amount_raw: string;
  in_amount_ui: number;
  out_amount_ui: number;
  price_usd_at_trade: number | null;
  sol_price_usd_at_trade: number | null;
  tx_signature: string | null;
  status: 'pending' | 'success' | 'failed';
  error_msg: string | null;
  slippage_bps: number | null;
  priority_fee_lamports: number | null;
  created_at: number;
  confirmed_at: number | null;
  realized_pnl_sol: number | null;
}

export interface Alert {
  id: number;
  token_address: string;
  type: string;
  payload_json: string | null;
  sent_at: number;
  success: number;
}

// 与前端交互用的 DTO
export interface TokenView extends Token {
  pct_from_high_24h: number | null;
  pct_change_24h: number | null;
  has_open_position: boolean;
  position_amount_ui: number | null;
  unrealized_pnl_sol: number | null;
  // ★ 新增：单币持仓盈亏展示
  avg_entry_price_usd: number | null;
  sol_spent: number | null;
  last_buy_price_usd: number | null;
}

export interface DashboardStats {
  pnl_24h_sol: number;
  realized_pnl_24h_sol: number;
  unrealized_pnl_sol: number;
  trades_24h: number;
  active_tokens: number;
  open_positions: number;
  wallet_sol_balance: number;
  wallet_address: string;
}
