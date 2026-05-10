import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    api.health().then(setHealth).catch(() => {});
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">设置</h2>

      <div className="bg-panel border border-border rounded-lg p-5 mb-4">
        <h3 className="text-sm font-semibold mb-3">运行状态</h3>
        {health ? (
          <dl className="text-sm space-y-2">
            <Row label="服务" value={health.ok ? '✅ 运行中' : '❌ 异常'} />
            <Row label="钱包" value={health.walletUnlocked ? '🔓 已解锁' : '🔒 未解锁'} />
            <Row label="钱包地址" value={<code className="text-xs">{health.walletAddress ?? '—'}</code>} mono />
          </dl>
        ) : <div className="text-muted text-sm">加载中...</div>}
      </div>

      <div className="bg-panel border border-border rounded-lg p-5 mb-4">
        <h3 className="text-sm font-semibold mb-3">通用</h3>
        <p className="text-xs text-muted mb-3">这些值通过后端 <code>.env</code> 配置，修改后需重启后端。</p>
        {config ? (
          <dl className="text-sm space-y-2">
            <Row label="默认买入金额（手动）" value={`${config.defaultBuySol} SOL`} />
            <Row label="默认滑点" value={`${(config.defaultSlippageBps / 100).toFixed(2)}%`} />
            <Row label="MEV 保护 (Jito)" value={config.jitoMevProtectEnabled ? '✓ 启用' : '✗ 禁用'} />
          </dl>
        ) : <div className="text-muted text-sm">加载中...</div>}
      </div>

      <div className="bg-panel border border-border rounded-lg p-5 mb-4">
        <h3 className="text-sm font-semibold mb-3">卖出策略</h3>
        {config ? (
          <dl className="text-sm space-y-2">
            <Row label="自动止盈" value={`涨 ${config.takeProfitGainPct}% 全仓卖出`} />
            <Row label="RSI 超买卖出" value={`15m RSI(7) > ${config.rsiSellThreshold} 立即全仓卖`} />
            <Row label="手动卖出" value={'始终全仓（清空钱包余额）'} />
          </dl>
        ) : null}
      </div>

      {config?.autoDipBuy && (
        <div className="bg-panel border border-border rounded-lg p-5 mb-4">
          <h3 className="text-sm font-semibold mb-3">自动逢低买入</h3>
          <dl className="text-sm space-y-2">
            <Row label="状态" value={config.autoDipBuy.enabled ? '✓ 启用' : '✗ 禁用'} />
            <Row label="首次买入触发" value={`24h 跌 ≥ ${config.autoDipBuy.drop24hPct}% 且 15m RSI(7) < ${config.autoDipBuy.rsiThreshold}`} />
            <Row label="首次买入金额" value={`${config.autoDipBuy.buySol} SOL`} />
            <Row label="DCA 补仓触发" value={`自上次买入价又跌 ≥ ${config.autoDipBuy.dcaDropPct}% 且 RSI(7) < ${config.autoDipBuy.rsiThreshold}`} />
            <Row label="DCA 补仓金额" value={`${config.autoDipBuy.dcaSol} SOL`} />
            <Row label="最多买入次数" value={`${config.autoDipBuy.maxBuys} 次`} />
          </dl>
        </div>
      )}

      <div className="bg-panel border border-border rounded-lg p-5 mb-4">
        <h3 className="text-sm font-semibold mb-3">监控阈值（自动移除）</h3>
        {config ? (
          <dl className="text-sm space-y-2">
            <Row label="最低 FDV" value={`$${config.fdvMinUsd}`} />
            <Row label="最低 LP" value={`$${config.lpMinUsd}`} />
          </dl>
        ) : null}
      </div>

      <div className="bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-3">Webhook 接入</h3>
        <p className="text-xs text-muted mb-2">外部系统可通过 POST 请求往以下地址推送代币（无鉴权）：</p>
        <pre className="bg-bg border border-border rounded p-3 text-xs overflow-x-auto">{`curl -X POST ${window.location.origin}/webhook/add-token \\
  -H "Content-Type: application/json" \\
  -d '{"network":"solana","address":"<CA>","symbol":"<可选>"}'`}</pre>
        <p className="text-xs text-muted mt-2">⚠️ 接口无鉴权，请用网络层（防火墙/反代白名单）保护。</p>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1 border-b border-border last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  );
}
