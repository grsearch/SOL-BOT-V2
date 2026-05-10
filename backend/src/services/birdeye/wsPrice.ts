import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const WS_URL = 'wss://public-api.birdeye.so/socket/solana?x-api-key=';

export interface PriceTick {
  address: string;
  priceUsd: number;
  ts: number;
}

/**
 * Birdeye Real-Time WebSocket 价格订阅
 *
 * 协议要点（按官方文档）：
 *  - URL: wss://public-api.birdeye.so/socket/<chain>?x-api-key=<key>
 *  - 子协议: 'echo-protocol'
 *  - 单连接 SUBSCRIBE_PRICE complex 模式可订阅最多 100 个 token
 *  - 返回 PRICE_DATA，OHLCV：用 c (close) 作为最新价
 *  - currency 用 'pair'（按 pair 折算成 USD）
 *
 * Birdeye 单连接限制：simple 1 个 / complex 100 个，我们一律用 complex。
 */
export class BirdeyePriceStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedAddresses = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isStopping = false;

  on(event: 'price', listener: (tick: PriceTick) => void): this;
  on(event: 'open', listener: () => void): this;
  on(event: 'error', listener: (err: any) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  start(): void {
    this.isStopping = false;
    this.connect();
  }

  stop(): void {
    this.isStopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const url = WS_URL + encodeURIComponent(config.BIRDEYE_API_KEY);
    logger.info('Birdeye WS 连接中...');
    this.ws = new WebSocket(url, 'echo-protocol', {
      headers: {
        Origin: 'ws://public-api.birdeye.so',
        'Sec-WebSocket-Origin': 'ws://public-api.birdeye.so',
      },
    });

    this.ws.on('open', () => {
      logger.info('Birdeye WS 已连接');
      this.reconnectAttempts = 0;
      if (this.subscribedAddresses.size > 0) {
        this.sendComplexSubscribe(Array.from(this.subscribedAddresses));
      }
      this.heartbeatTimer = setInterval(() => {
        try { this.ws?.ping(); } catch { /* ignore */ }
      }, 30_000);
      this.emit('open');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'PRICE_DATA') return;
        const d = msg.data;
        if (!d) return;
        // OHLCV：c=close 作为最新价
        const address: string | undefined = d.address;
        const closePrice: number | undefined = d.c;
        const tsUnix: number | undefined = d.unixTime;
        if (!address || typeof closePrice !== 'number') return;
        const ts = tsUnix && tsUnix > 1e12 ? tsUnix : (tsUnix ?? Math.floor(Date.now() / 1000)) * 1000;
        this.emit('price', { address, priceUsd: closePrice, ts });
      } catch (e) {
        logger.warn({ err: e }, 'Birdeye WS 消息解析失败');
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'Birdeye WS 错误');
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'Birdeye WS 断开');
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.ws = null;
      if (!this.isStopping) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
    logger.info({ delay }, `Birdeye WS ${delay}ms 后重连`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * complex queryType 订阅多个 token mint，统一用 USD 计价。
   * Birdeye 不支持增量订阅，我们每次都重订全量。
   *
   * 注：currency=pair 是给"pair address"（LP 地址）用的，
   * 给 token mint 必须用 currency=usd 才能拿到美元价。
   */
  private sendComplexSubscribe(addresses: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (addresses.length === 0) return;
    const list = addresses.slice(0, 100);
    // 按 Birdeye 文档：query 形如 "(address = X AND chartType = 1m AND currency = usd) OR ..."
    const query = list.map((a) => `(address = ${a} AND chartType = 1m AND currency = usd)`).join(' OR ');
    this.ws.send(JSON.stringify({
      type: 'SUBSCRIBE_PRICE',
      data: {
        queryType: 'complex',
        query,
      },
    }));
    logger.info({ count: list.length }, 'Birdeye WS 已发送 complex 订阅 (USD)');
  }

  private sendUnsubscribeAll(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'UNSUBSCRIBE_PRICE' }));
  }

  subscribe(address: string): void {
    if (this.subscribedAddresses.has(address)) return;
    this.subscribedAddresses.add(address);
    this.resubscribe();
  }

  unsubscribe(address: string): void {
    if (!this.subscribedAddresses.has(address)) return;
    this.subscribedAddresses.delete(address);
    this.resubscribe();
  }

  private resubscribe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.sendUnsubscribeAll();
    if (this.subscribedAddresses.size > 0) {
      this.sendComplexSubscribe(Array.from(this.subscribedAddresses));
    }
  }
}

export const priceStream = new BirdeyePriceStream();
