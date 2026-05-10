import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { tokenRepo, tradeRepo, positionRepo } from '../db/repo.js';
import { addTokenToMonitor } from '../strategies/metadata.js';
import { strategyEngine } from '../strategies/engine.js';
import { buyToken, sellToken } from '../services/jupiter/executor.js';
import { getDashboardStats, getTokenViews } from './dashboard.js';
import { wallet } from '../wallet/index.js';

const SOL_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** 常时间字符串比较，防 timing attack */
function safeStringEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const addTokenSchema = z.object({
  network: z.string().optional(),
  address: z.string().regex(SOL_ADDRESS_REGEX),
  symbol: z.string().optional(),
});

const buySchema = z.object({
  address: z.string().regex(SOL_ADDRESS_REGEX),
  solAmount: z.coerce.number().positive().max(100).optional(),
  slippageBps: z.coerce.number().int().positive().max(10000).optional(),
});

// 卖出永远是全仓，所以 schema 里不再接 amountUi
const sellSchema = z.object({
  address: z.string().regex(SOL_ADDRESS_REGEX),
  slippageBps: z.coerce.number().int().positive().max(10000).optional(),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // 鉴权 hook：仅 /api/* 走 API_TOKEN 校验
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url || '';
    if (!url.startsWith('/api/')) return;          // /webhook、/health、/ws 走自己的鉴权或开放
    const ip = req.ip || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (config.API_TOKEN) {
      const provided = req.headers['x-api-token'];
      if (typeof provided === 'string' && safeStringEq(provided, config.API_TOKEN)) return;
      if (!isLoopback) {
        return reply.code(401).send({ error: 'unauthorized', message: '需要 x-api-token header' });
      }
    } else {
      if (!isLoopback) {
        return reply.code(401).send({
          error: 'api_token_required',
          message: '请在 .env 中设置 API_TOKEN 后才能从远程访问 /api/*',
        });
      }
    }
  });

  // ========== Health ==========
  app.get('/health', async () => ({
    ok: true,
    walletUnlocked: wallet.isUnlocked,
    walletAddress: wallet.isUnlocked ? wallet.address : null,
    ts: Date.now(),
  }));

  // ========== Dashboard ==========
  app.get('/api/dashboard/stats', async () => getDashboardStats());
  app.get('/api/dashboard/tokens', async () => getTokenViews());

  // ========== 监控代币 CRUD ==========
  app.post('/api/tokens', async (req, reply) => {
    const parsed = addTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    await addTokenToMonitor(parsed.data.address, 'manual', parsed.data.symbol);
    strategyEngine.subscribeToken(parsed.data.address);
    return { ok: true };
  });

  app.delete('/api/tokens/:address', async (req: any, reply) => {
    const address = req.params.address as string;
    if (!SOL_ADDRESS_REGEX.test(address)) {
      return reply.code(400).send({ error: 'invalid_address' });
    }
    const t = tokenRepo.get(address);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const pos = positionRepo.getOpenByToken(address);
    if (pos && pos.amount_ui > 0) {
      return reply.code(409).send({ error: 'has_open_position', message: '请先卖出持仓再移除' });
    }
    tokenRepo.setActive(address, false);
    strategyEngine.unsubscribeToken(address);
    return { ok: true };
  });

  // ========== 交易 ==========
  app.post('/api/trade/buy', async (req, reply) => {
    if (!wallet.isUnlocked) return reply.code(503).send({ error: 'wallet_locked' });
    const parsed = buySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const r = await buyToken({
        tokenAddress: parsed.data.address,
        solAmount: parsed.data.solAmount ?? config.DEFAULT_BUY_SOL,
        slippageBps: parsed.data.slippageBps,
        trigger: 'manual',
      });
      return { ok: true, ...r };
    } catch (e: any) {
      logger.error({ err: e.message }, '手动买入失败');
      return reply.code(500).send({ error: 'buy_failed', message: e.message });
    }
  });

  // 卖出永远全仓
  app.post('/api/trade/sell', async (req, reply) => {
    if (!wallet.isUnlocked) return reply.code(503).send({ error: 'wallet_locked' });
    const parsed = sellSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const r = await sellToken({
        tokenAddress: parsed.data.address,
        slippageBps: parsed.data.slippageBps,
        trigger: 'manual',
      });
      return { ok: true, ...r };
    } catch (e: any) {
      logger.error({ err: e.message }, '手动卖出失败');
      return reply.code(500).send({ error: 'sell_failed', message: e.message });
    }
  });

  // ========== 交易记录 ==========
  app.get('/api/trades', async (req: any) => {
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    return tradeRepo.list(limit);
  });

  app.get('/api/positions', async () => positionRepo.listOpen());

  // ========== Webhook 入口（无鉴权 - 用户要求） ==========
  // 注意：接受任何来源的 add-token 请求，依赖 IP 层面的网络隔离做安全
  app.post('/webhook/add-token', async (req, reply) => {
    const parsed = addTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (parsed.data.network && parsed.data.network !== 'solana') {
      return reply.code(400).send({ error: 'only_solana_supported' });
    }
    await addTokenToMonitor(parsed.data.address, 'webhook', parsed.data.symbol);
    strategyEngine.subscribeToken(parsed.data.address);
    return { ok: true, address: parsed.data.address };
  });

  // ========== 策略配置只读 ==========
  app.get('/api/config', async () => ({
    defaultBuySol: config.DEFAULT_BUY_SOL,
    defaultSlippageBps: config.DEFAULT_SLIPPAGE_BPS,
    takeProfitGainPct: config.TAKE_PROFIT_GAIN_PCT,
    rsiSellThreshold: config.RSI_SELL_THRESHOLD,
    fdvMinUsd: config.FDV_MIN_USD,
    lpMinUsd: config.LP_MIN_USD,
    jitoMevProtectEnabled: config.JITO_TIP_LAMPORTS > 0,
    autoDipBuy: {
      enabled: config.AUTO_DIP_BUY_ENABLED,
      buySol: config.AUTO_DIP_BUY_SOL,
      drop24hPct: config.AUTO_DIP_BUY_DROP_24H_PCT,
      rsiThreshold: config.AUTO_DIP_BUY_RSI_THRESHOLD,
      dcaDropPct: config.AUTO_DIP_DCA_DROP_PCT,
      dcaSol: config.AUTO_DIP_DCA_SOL,
      maxBuys: config.AUTO_DIP_MAX_BUYS,
    },
  }));
}
