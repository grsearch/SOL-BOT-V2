import { useEffect, useState } from 'react';
import { api, type Trade } from '../api/client';
import { fmtSol, fmtTime, shortAddr } from '../api/format';

export function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      setErr(null);
      const t = await api.trades(200);
      setTrades(t);
    } catch (e: any) { setErr(e.message); }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">交易记录</h2>
        <button onClick={refresh} className="text-xs text-muted hover:text-text">↻ 刷新</button>
      </div>
      {err && <div className="bg-red/10 border border-red/30 text-red p-3 rounded mb-4 text-sm">{err}</div>}
      <div className="bg-panel border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs text-muted uppercase">
              <tr>
                <th className="text-left p-3 font-normal">时间</th>
                <th className="text-left p-3 font-normal">CA</th>
                <th className="text-left p-3 font-normal">方向</th>
                <th className="text-left p-3 font-normal">触发</th>
                <th className="text-right p-3 font-normal">输入</th>
                <th className="text-right p-3 font-normal">输出</th>
                <th className="text-right p-3 font-normal">滑点</th>
                <th className="text-left p-3 font-normal">状态</th>
                <th className="text-left p-3 font-normal">tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr><td colSpan={9} className="p-12 text-center text-muted">暂无交易</td></tr>
              )}
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-border hover:bg-panel2/40">
                  <td className="p-3 text-xs text-muted">{fmtTime(t.created_at)}</td>
                  <td className="p-3 font-mono text-xs">{shortAddr(t.token_address)}</td>
                  <td className={`p-3 font-medium ${t.side === 'buy' ? 'text-green' : 'text-red'}`}>{t.side === 'buy' ? '买入' : '卖出'}</td>
                  <td className="p-3 text-xs text-muted">{triggerLabel(t.trigger)}</td>
                  <td className="p-3 text-right font-mono">{t.in_amount_ui.toFixed(t.in_mint === 'So11111111111111111111111111111111111111112' ? 4 : 2)}</td>
                  <td className="p-3 text-right font-mono">{t.out_amount_ui.toFixed(t.out_mint === 'So11111111111111111111111111111111111111112' ? 4 : 2)}</td>
                  <td className="p-3 text-right text-xs">{t.slippage_bps ? `${(t.slippage_bps / 100).toFixed(2)}%` : '—'}</td>
                  <td className="p-3">
                    <StatusBadge status={t.status} />
                    {t.error_msg && <div className="text-xs text-red mt-1 max-w-[200px] truncate" title={t.error_msg}>{t.error_msg}</div>}
                  </td>
                  <td className="p-3">
                    {t.tx_signature ? (
                      <a href={`https://solscan.io/tx/${t.tx_signature}`} target="_blank" rel="noreferrer"
                        className="text-accent hover:underline text-xs font-mono">
                        {shortAddr(t.tx_signature, 6, 4)}
                      </a>
                    ) : <span className="text-muted text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case 'manual': return '手动';
    case 'auto_take_profit': return '自动止盈';
    case 'auto_remove_sell': return '自动移除';
    default: return trigger;
  }
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'success' ? 'bg-green/20 text-green'
    : status === 'failed' ? 'bg-red/20 text-red'
    : 'bg-yellow/20 text-yellow';
  const label = status === 'success' ? '成功' : status === 'failed' ? '失败' : '处理中';
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>;
}
