import { type DashboardStats } from '../api/client';
import { fmtSol, fmtNum, shortAddr, pctClass } from '../api/format';

export function StatsBar({ stats }: { stats: DashboardStats | null }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-panel border border-border rounded-lg p-4 h-24 animate-pulse" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      <Card label="24h 总盈亏" value={fmtSol(stats.pnl_24h_sol)} valueClass={pctClass(stats.pnl_24h_sol)} sub={`已实现 ${fmtSol(stats.realized_pnl_24h_sol)}`} />
      <Card label="未实现盈亏" value={fmtSol(stats.unrealized_pnl_sol)} valueClass={pctClass(stats.unrealized_pnl_sol)} />
      <Card label="24h 交易笔数" value={fmtNum(stats.trades_24h)} />
      <Card label="持仓 / 监控" value={`${stats.open_positions} / ${stats.active_tokens}`} />
      <Card label="钱包" value={fmtSol(stats.wallet_sol_balance)} sub={shortAddr(stats.wallet_address, 6, 6)} />
    </div>
  );
}

function Card({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-panel border border-border rounded-lg p-4">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className={`text-xl font-semibold ${valueClass ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1 font-mono">{sub}</div>}
    </div>
  );
}
