import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * 在 App 顶部装一个守卫：先 ping /api/config，401 时提示用户输入 token。
 * Token 写到 localStorage，刷新页面后通过 client.ts 自动读取。
 */
export function ApiTokenGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'need_token'>('checking');
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    try {
      await api.config();
      setState('ok');
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (msg.includes('unauthorized') || msg.includes('api_token_required') || msg.includes('401')) {
        setState('need_token');
      } else {
        // 其他错误（后端没起、网络问题）也给一个统一提示
        setState('need_token');
        setErr(msg);
      }
    }
  }

  useEffect(() => { check(); }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      localStorage.setItem('api_token', input.trim());
      // 刷新页面让 client.ts 再读取
      window.location.reload();
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  }

  if (state === 'checking') {
    return <div className="min-h-screen flex items-center justify-center text-muted text-sm">连接后端中...</div>;
  }
  if (state === 'need_token') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-panel border border-border rounded-lg p-6 w-[480px] max-w-full">
          <div className="text-base font-semibold mb-2">🔒 需要 API Token</div>
          <div className="text-xs text-muted mb-4 leading-relaxed">
            后端要求鉴权才能访问 <code className="bg-bg px-1 rounded">/api/*</code>。
            请把 <code className="bg-bg px-1 rounded">.env</code> 中的 <code className="bg-bg px-1 rounded">API_TOKEN</code> 粘贴到下方。
            <br /><br />
            如果 <code className="bg-bg px-1 rounded">API_TOKEN</code> 没设置，说明后端未启动或不可达。
          </div>
          <input
            type="password"
            autoFocus
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && input.trim()) save(); }}
            placeholder="API_TOKEN"
            className="w-full bg-bg border border-border rounded px-3 py-2 text-sm mb-3 font-mono focus:outline-none focus:border-accent"
          />
          {err && <div className="text-xs text-red mb-3">{err}</div>}
          <button
            onClick={save}
            disabled={!input.trim() || saving}
            className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium"
          >
            {saving ? '验证中...' : '保存并继续'}
          </button>
          <div className="text-xs text-muted mt-4">
            或在 URL 添加 <code className="bg-bg px-1 rounded">?api_token=xxx</code> 自动设置后跳回。
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
