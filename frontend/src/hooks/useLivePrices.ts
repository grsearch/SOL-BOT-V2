import { useEffect, useRef, useState } from 'react';
import { openPriceStream } from '../api/client';

/**
 * 订阅 /ws，把每个 token 的最新价 USD 缓存到一个 map 里。
 * 用 ref 持有 socket，避免 StrictMode 重复连接（实际生产会更稳）。
 */
export function useLivePrices(): { livePrices: Record<string, { priceUsd: number; ts: number }>; connected: boolean } {
  const [livePrices, setLivePrices] = useState<Record<string, { priceUsd: number; ts: number }>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    const ws = openPriceStream({
      onOpen: () => alive && setConnected(true),
      onClose: () => alive && setConnected(false),
      onPrice: (tick) => {
        if (!alive) return;
        setLivePrices((prev) => ({ ...prev, [tick.address]: { priceUsd: tick.priceUsd, ts: tick.ts } }));
      },
    });
    wsRef.current = ws;
    return () => {
      alive = false;
      try { ws.close(); } catch { /* ignore */ }
    };
  }, []);

  return { livePrices, connected };
}
