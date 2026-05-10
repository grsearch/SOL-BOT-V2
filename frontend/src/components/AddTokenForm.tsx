import { useState } from 'react';
import { api } from '../api/client';

export function AddTokenForm({ onAdded }: { onAdded: () => void }) {
  const [address, setAddress] = useState('');
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim())) {
      setErr('CA 格式不正确');
      return;
    }
    setBusy(true);
    try {
      await api.addToken(address.trim(), symbol.trim() || undefined);
      setAddress('');
      setSymbol('');
      onAdded();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-panel border border-border rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[280px]">
        <label className="block text-xs text-muted mb-1">代币 CA</label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="例如 BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump"
          className="w-full bg-bg border border-border rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-accent"
        />
      </div>
      <div className="w-32">
        <label className="block text-xs text-muted mb-1">Symbol（可选）</label>
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="自动获取"
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
      </div>
      <button
        type="submit"
        disabled={busy || !address.trim()}
        className="bg-accent hover:bg-accent/90 disabled:bg-accent/50 px-4 py-2 rounded text-sm font-medium"
      >
        {busy ? '添加中...' : '+ 加入监控'}
      </button>
      {err && <div className="w-full text-xs text-red">{err}</div>}
    </form>
  );
}
