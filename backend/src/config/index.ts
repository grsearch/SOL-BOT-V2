import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';
import { z } from 'zod';

// 从多个候选位置加载 .env，第一个存在的优先
// 顺序：cwd/.env、cwd/../.env（项目根）、backend/.env（如果从根目录跑）
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(process.cwd(), 'backend', '.env'),
];
for (const p of candidates) {
  if (existsSync(p)) {
    loadDotenv({ path: p });
    break;
  }
}

const envSchema = z.object({
  // API keys
  BIRDEYE_API_KEY: z.string().min(1, 'BIRDEYE_API_KEY 必填'),
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY 必填'),
  JUPITER_API_KEY: z.string().optional().default(''),

  // Webhook 鉴权
  WEBHOOK_SECRET: z.string().optional().default(''),
  // 前端 API 鉴权 token（可选 - 留空时仅 localhost 访问会被允许）
  API_TOKEN: z.string().optional().default(''),

  // 钱包
  WALLET_PASSWORD: z.string().optional().default(''),

  // 服务
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  // 额外允许的 CORS origin（公网 IP 或额外域名），逗号分隔
  EXTRA_CORS_ORIGINS: z.string().optional().default(''),

  // DB
  DATABASE_PATH: z.string().default('./data.db'),

  // 策略 - 通用
  DEFAULT_BUY_SOL: z.coerce.number().positive().default(1),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().int().positive().default(300),
  DEFAULT_PRIORITY_FEE_LAMPORTS: z.coerce.number().int().nonnegative().default(1_000_000),
  JITO_TIP_LAMPORTS: z.coerce.number().int().nonnegative().default(100_000),

  // 止盈
  TAKE_PROFIT_GAIN_PCT: z.coerce.number().positive().default(100),
  // RSI(7) 卖出阈值
  RSI_SELL_THRESHOLD: z.coerce.number().positive().default(80),

  // 自动逢低买入
  AUTO_DIP_BUY_ENABLED: z.coerce.boolean().default(true),
  AUTO_DIP_BUY_SOL: z.coerce.number().positive().default(1),
  // 触发条件：24h 跌幅 ≥ X%
  AUTO_DIP_BUY_DROP_24H_PCT: z.coerce.number().positive().default(70),
  // 触发条件：15m RSI(7) < X
  AUTO_DIP_BUY_RSI_THRESHOLD: z.coerce.number().positive().default(30),
  // 补仓：相对自己上次买入价又跌 ≥ X%
  AUTO_DIP_DCA_DROP_PCT: z.coerce.number().positive().default(50),
  // 补仓 SOL 数量（默认与首次相同）
  AUTO_DIP_DCA_SOL: z.coerce.number().positive().default(1),
  // 补仓最大次数（含首次）
  AUTO_DIP_MAX_BUYS: z.coerce.number().int().positive().default(5),

  // 监控
  FDV_MIN_USD: z.coerce.number().nonnegative().default(30_000),
  LP_MIN_USD: z.coerce.number().nonnegative().default(10_000),
  MONITOR_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // 自动策略评估周期（每 N 秒拉一次 OHLCV/RSI 检查每个币）
  AUTO_STRATEGY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // RPC
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ 环境变量校验失败:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// RPC 默认值（如果用户没显式设置，就用 Helius）
const rpcUrl = env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
const wsUrl = env.SOLANA_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

// 把 EXTRA_CORS_ORIGINS 解析成数组
const extraCorsOrigins = env.EXTRA_CORS_ORIGINS
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

export const config = {
  ...env,
  SOLANA_RPC_URL: rpcUrl,
  SOLANA_WS_URL: wsUrl,
  EXTRA_CORS_ORIGINS_LIST: extraCorsOrigins,
} as const;

export type Config = typeof config;
