// 与后端的 type 对齐（手动同步）
export interface TokenView {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  fdv_usd: number | null;
  lp_usd: number | null;
  holders: number | null;
  age_seconds: number | null;
  price_usd: number | null;
  price_sol: number | null;
  high_24h: number | null;
  high_24h_at: number | null;
  volume_24h_usd: number | null;
  history_2h_price: number | null;
  history_6h_price: number | null;
  history_24h_price: number | null;
  monitor_active: number;
  added_at: number;
  added_by: string | null;
  pct_from_high_24h: number | null;
  pct_change_24h: number | null;
  has_open_position: boolean;
  position_amount_ui: number | null;
  unrealized_pnl_sol: number | null;
  // 新增持仓信息
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

export interface Trade {
  id: number;
  token_address: string;
  side: 'buy' | 'sell';
  trigger: string;
  in_mint: string;
  out_mint: string;
  in_amount_ui: number;
  out_amount_ui: number;
  price_usd_at_trade: number | null;
  tx_signature: string | null;
  status: string;
  error_msg: string | null;
  slippage_bps: number | null;
  created_at: number;
  confirmed_at: number | null;
  realized_pnl_sol: number | null;
}

// API token：前端通过 localStorage / 输入框获取，附加到每个请求 header
function getApiToken(): string {
  // 1) URL 参数: ?api_token=xxx
  const u = new URL(window.location.href);
  const fromUrl = u.searchParams.get('api_token');
  if (fromUrl) {
    try { localStorage.setItem('api_token', fromUrl); } catch { /* ignore */ }
    u.searchParams.delete('api_token');
    window.history.replaceState({}, '', u.toString());
    return fromUrl;
  }
  try { return localStorage.getItem('api_token') ?? ''; } catch { return ''; }
}

async function call<T>(method: string, url: string, body?: any): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getApiToken();
  if (token) headers['x-api-token'] = token;
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.message ?? err.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () => call<any>('GET', '/health'),
  stats: () => call<DashboardStats>('GET', '/api/dashboard/stats'),
  tokens: () => call<TokenView[]>('GET', '/api/dashboard/tokens'),
  addToken: (address: string, symbol?: string) =>
    call<{ ok: boolean }>('POST', '/api/tokens', { address, symbol }),
  removeToken: (address: string) =>
    call<{ ok: boolean }>('DELETE', `/api/tokens/${address}`),
  buy: (address: string, solAmount?: number, slippageBps?: number) =>
    call<{ ok: boolean; signature: string; tradeId: number }>('POST', '/api/trade/buy', { address, solAmount, slippageBps }),
  // ★ 卖出永远全仓，不再接受 amountUi
  sell: (address: string, slippageBps?: number) =>
    call<{ ok: boolean; signature: string; solReceived: number }>('POST', '/api/trade/sell', { address, slippageBps }),
  trades: (limit = 100) => call<Trade[]>('GET', `/api/trades?limit=${limit}`),
  config: () => call<any>('GET', '/api/config'),
};

// WebSocket 价格推送
export function openPriceStream(handlers: {
  onPrice?: (tick: { address: string; priceUsd: number; ts: number }) => void;
  onOpen?: () => void;
  onClose?: () => void;
}): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getApiToken();
  const qs = token ? `?api_token=${encodeURIComponent(token)}` : '';
  const ws = new WebSocket(`${proto}//${window.location.host}/ws${qs}`);
  ws.onopen = () => handlers.onOpen?.();
  ws.onclose = () => handlers.onClose?.();
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'price') handlers.onPrice?.(msg.data);
    } catch { /* ignore */ }
  };
  return ws;
}
