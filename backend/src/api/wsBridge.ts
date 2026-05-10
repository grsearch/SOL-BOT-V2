import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { priceStream } from '../services/birdeye/wsPrice.js';

interface ClientMessage {
  // {address, priceUsd, ts}
  type: 'price' | 'hello';
  data: any;
}

const clients = new Set<WebSocket>();

function safeStringEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function registerWsBridge(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket /* WebSocket */, req) => {
    // ★ 安全修：WS 连接前鉴权 - 跟 routes 的 preHandler 对齐
    const ip = req.ip || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const url = req.url || '';
    const tokenMatch = url.match(/[?&]api_token=([^&]+)/);
    const provided = tokenMatch ? decodeURIComponent(tokenMatch[1]) : '';

    if (config.API_TOKEN) {
      const tokenOk = provided && safeStringEq(provided, config.API_TOKEN);
      if (!tokenOk && !isLoopback) {
        socket.close(1008, 'unauthorized');
        return;
      }
    } else {
      // 未配置 API_TOKEN：只允许 loopback
      if (!isLoopback) {
        socket.close(1008, 'api_token_required');
        return;
      }
    }
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', data: { ts: Date.now() } } satisfies ClientMessage));

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  // 把 Birdeye 推上来的价格转发给所有前端连接
  priceStream.on('price', (tick) => {
    const msg = JSON.stringify({ type: 'price', data: tick } satisfies ClientMessage);
    for (const c of clients) {
      try {
        if (c.readyState === 1) c.send(msg);
      } catch (e) {
        // ignore
      }
    }
  });

  logger.info('前端 WS 桥接已注册 /ws');
}

/** 主动从其他模块广播事件给前端 */
export function broadcast(type: string, data: any): void {
  const msg = JSON.stringify({ type, data });
  for (const c of clients) {
    try { if (c.readyState === 1) c.send(msg); } catch { /* ignore */ }
  }
}
