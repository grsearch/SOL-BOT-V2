import { api, type TokenView } from '../api/client';
import { fmtUsd, fmtPct, fmtAge, fmtNum, fmtSol, shortAddr, pctClass } from '../api/format';
import { TradeButtons } from './TradeButtons';

interface Props {
  tokens: TokenView[];
  livePrices: Record<string, { priceUsd: number; ts: number }>;
  defaultBuySol: number;
  defaultSlippageBps: number;
  onChanged: () => void;
}

export function TokenTable({ tokens, livePrices, defaultBuySol, defaultSlippageBps, onChanged }: Props) {
  if (tokens.length === 0) {
    return (
      <div className="bg-panel border border-border rounded-lg p-12 text-center text-muted">
        当前没有监控代币。在上方输入 CA 加入监控，或通过 webhook 推送。
      </div>
    );
  }

  async function remove(addr: string) {
    if (!confirm('确认从监控移除该代币？（如有持仓需先卖出）')) return;
    try {
      await api.removeToken(addr);
      onChanged();
    } catch (e: any) {
      alert(`移除失败：${e.message}`);
    }
  }

  return (
    <div className="bg-panel border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-xs text-muted uppercase">
            <tr>
              <th className="text-left p-3 font-normal">Symbol / CA</th>
              <th className="text-right p-3 font-normal">现价</th>
              <th className="text-right p-3 font-normal">距 24h 高</th>
              <th className="text-right p-3 font-normal">FDV</th>
              <th className="text-right p-3 font-normal">LP</th>
              <th className="text-right p-3 font-normal">24h Vol</th>
              <th className="text-right p-3 font-normal">Holders</th>
              <th className="text-right p-3 font-normal">Age</th>
              <th className="text-right p-3 font-normal">持仓</th>
              <th className="text-right p-3 font-normal">盈亏</th>
              <th className="text-right p-3 font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const live = livePrices[t.address];
              const currentPrice = live?.priceUsd ?? t.price_usd;
              // 用最新价重算 pct
              let pctFromHigh = t.pct_from_high_24h;
              if (live && t.high_24h && t.high_24h > 0) {
                pctFromHigh = ((live.priceUsd - t.high_24h) / t.high_24h) * 100;
              }

              // 单币持仓盈亏：用最新 currentPrice 实时计算 pct（vs avg_entry_price_usd）
              // unrealized_pnl_sol 是后端用 30s 缓存价算的，pct 用前端最新价
              let entryPctChange: number | null = null;
              if (t.has_open_position && t.avg_entry_price_usd && t.avg_entry_price_usd > 0 && currentPrice != null) {
                entryPctChange = ((currentPrice - t.avg_entry_price_usd) / t.avg_entry_price_usd) * 100;
              }

              const gmgnUrl = `https://gmgn.ai/sol/token/${t.address}`;
              return (
                <tr key={t.address} className="border-t border-border hover:bg-panel2/40">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <a href={gmgnUrl} target="_blank" rel="noreferrer"
                        className="font-medium hover:text-accent">
                        {t.symbol ?? '?'}
                      </a>
                      <span className="text-xs text-muted font-mono">{shortAddr(t.address, 4, 4)}</span>
                      <button
                        title="复制 CA"
                        onClick={() => navigator.clipboard.writeText(t.address)}
                        className="text-xs text-muted hover:text-text"
                      >📋</button>
                    </div>
                  </td>
                  <td className="p-3 text-right font-mono">
                    {currentPrice != null ? `$${currentPrice.toFixed(currentPrice < 1 ? 6 : 4)}` : '—'}
                    {live && <span className="ml-1 text-xs text-green animate-pulse">●</span>}
                  </td>
                  <td className={`p-3 text-right font-mono ${pctClass(pctFromHigh)}`}>{fmtPct(pctFromHigh)}</td>
                  <td className="p-3 text-right font-mono">{fmtUsd(t.fdv_usd)}</td>
                  <td className="p-3 text-right font-mono">{fmtUsd(t.lp_usd)}</td>
                  <td className="p-3 text-right font-mono">{fmtUsd(t.volume_24h_usd)}</td>
                  <td className="p-3 text-right font-mono">{fmtNum(t.holders)}</td>
                  <td className="p-3 text-right">{fmtAge(t.age_seconds)}</td>
                  <td className="p-3 text-right">
                    {t.has_open_position
                      ? <span className="text-accent text-xs">{t.position_amount_ui?.toFixed(2)}</span>
                      : <span className="text-muted text-xs">—</span>}
                  </td>
                  <td className="p-3 text-right font-mono text-xs whitespace-nowrap">
                    {t.has_open_position ? (
                      <div>
                        <div className={pctClass(t.unrealized_pnl_sol)}>
                          {t.unrealized_pnl_sol != null && t.unrealized_pnl_sol >= 0 ? '+' : ''}
                          {fmtSol(t.unrealized_pnl_sol)}
                        </div>
                        <div className={`${pctClass(entryPctChange)} text-[11px]`}>
                          {fmtPct(entryPctChange)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1 justify-end items-center">
                      <TradeButtons
                        token={t}
                        defaultBuySol={defaultBuySol}
                        defaultSlippageBps={defaultSlippageBps}
                        onTraded={onChanged}
                      />
                      <button
                        onClick={() => remove(t.address)}
                        className="text-muted hover:text-red px-1 text-xs"
                        title="移除监控"
                      >✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
