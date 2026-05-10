import axios, { AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;             // USD
  // 各时段历史价（来自 token_overview，比 OHLCV 对 meme 币更靠谱）
  history2hPrice?: number;
  history6hPrice?: number;
  history24hPrice?: number;
  priceChange2hPercent?: number;
  priceChange6hPercent?: number;
  priceChange24hPercent?: number;
  v24hUSD?: number;          // 24h volume in USD
  liquidity?: number;        // 池子 LP USD
  fdv?: number;
  mc?: number;
  holder?: number;
  numberMarkets?: number;
}

/** OHLCV 烛蜡线数据 */
export interface OhlcvCandle {
  unixTime: number;     // 烛蜡线 open 时间
  o: number;            // open
  h: number;            // high
  l: number;            // low
  c: number;            // close
  v: number;            // volume
}

class BirdeyeClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BIRDEYE_BASE,
      timeout: 15_000,
      headers: {
        'X-API-KEY': config.BIRDEYE_API_KEY,
        'x-chain': 'solana',
        accept: 'application/json',
      },
    });
  }

  /** 单个代币的元数据 + 价格 + LP + FDV + 历史价。 */
  async getTokenOverview(address: string): Promise<BirdeyeTokenOverview | null> {
    try {
      const r = await this.http.get('/defi/token_overview', { params: { address } });
      const d = r.data?.data;
      if (!d) return null;
      return {
        address,
        symbol: d.symbol,
        name: d.name,
        decimals: d.decimals,
        price: d.price,
        history2hPrice: d.history2hPrice,
        history6hPrice: d.history6hPrice,
        history24hPrice: d.history24hPrice,
        priceChange2hPercent: d.priceChange2hPercent,
        priceChange6hPercent: d.priceChange6hPercent,
        priceChange24hPercent: d.priceChange24hPercent,
        v24hUSD: d.v24hUSD,
        liquidity: d.liquidity,
        fdv: d.fdv,
        mc: d.mc,
        holder: d.holder,
        numberMarkets: d.numberMarkets,
      };
    } catch (e: any) {
      logger.warn({ err: e?.response?.status ?? e?.message, address }, 'birdeye getTokenOverview 失败');
      return null;
    }
  }

  /** 价格（轻量） */
  async getPrice(address: string): Promise<number | null> {
    try {
      const r = await this.http.get('/defi/price', { params: { address } });
      return r.data?.data?.value ?? null;
    } catch (e: any) {
      logger.warn({ err: e?.message, address }, 'birdeye getPrice 失败');
      return null;
    }
  }

  /** 代币创建时间（用于算 age） */
  async getTokenCreationInfo(address: string): Promise<{ createdAtUnix: number } | null> {
    try {
      const r = await this.http.get('/defi/token_creation_info', { params: { address } });
      const d = r.data?.data;
      if (!d?.blockUnixTime) return null;
      return { createdAtUnix: d.blockUnixTime };
    } catch (e: any) {
      logger.warn({ err: e?.message, address }, 'birdeye getTokenCreationInfo 失败');
      return null;
    }
  }

  /**
   * 拉取 OHLCV 烛蜡线，用于 RSI 计算等。
   * type: '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | ...
   * 默认拉最近 N 根。
   */
  async getOhlcv(address: string, opts: {
    type: '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D';
    limit?: number;       // 最近 N 根（计算 timeFrom/timeTo）
  }): Promise<OhlcvCandle[]> {
    const limit = opts.limit ?? 50;
    const intervalSec = parseIntervalToSeconds(opts.type);
    const now = Math.floor(Date.now() / 1000);
    const timeFrom = now - intervalSec * (limit + 5);  // 多拉几根做 buffer
    try {
      const r = await this.http.get('/defi/ohlcv', {
        params: {
          address,
          type: opts.type,
          time_from: timeFrom,
          time_to: now,
        },
      });
      const items: any[] = r.data?.data?.items ?? [];
      return items.map((it) => ({
        unixTime: it.unixTime,
        o: it.o,
        h: it.h,
        l: it.l,
        c: it.c,
        v: it.v,
      }));
    } catch (e: any) {
      logger.warn({ err: e?.response?.status ?? e?.message, address, type: opts.type }, 'birdeye getOhlcv 失败');
      return [];
    }
  }
}

function parseIntervalToSeconds(t: string): number {
  const m = /^(\d+)([mHD])$/.exec(t);
  if (!m) return 60;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'm') return n * 60;
  if (unit === 'H') return n * 3600;
  if (unit === 'D') return n * 86400;
  return 60;
}

export const birdeye = new BirdeyeClient();
