export function fmtUsd(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

export function fmtSol(n: number | null | undefined, digits = 4): string {
  if (n == null || isNaN(n)) return '—';
  return `${n.toFixed(digits)} SOL`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function fmtAge(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toString();
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr) return '';
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function pctClass(n: number | null | undefined): string {
  if (n == null) return 'text-muted';
  if (n > 0) return 'text-green';
  if (n < 0) return 'text-red';
  return 'text-muted';
}
