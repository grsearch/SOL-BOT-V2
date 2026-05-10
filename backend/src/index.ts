import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { migrate } from './db/migrate.js';
import { wallet } from './wallet/index.js';
import { keystoreExists } from './wallet/keystore.js';
import { registerRoutes } from './api/routes.js';
import { registerWsBridge } from './api/wsBridge.js';
import { strategyEngine } from './strategies/engine.js';
import path from 'path';

const KEYSTORE_PATH = path.resolve(process.cwd(), 'wallet.keystore.json');

async function readPasswordHidden(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write('请输入钱包解锁密码: ');
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf-8');
    let buf = '';
    const onData = (ch: string) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function unlockWallet(): Promise<void> {
  if (!keystoreExists(KEYSTORE_PATH)) {
    console.error(`❌ 找不到 ${KEYSTORE_PATH}，请先运行 npm run wallet:create 或 wallet:import`);
    process.exit(1);
  }
  let password = config.WALLET_PASSWORD;
  if (!password) {
    password = await readPasswordHidden();
  }
  await wallet.unlock(password);
}

async function bootstrap(): Promise<void> {
  // 1. DB
  migrate();

  // 2. 钱包
  await unlockWallet();

  // 3. HTTP server
  const app = Fastify({ logger: false, trustProxy: true });

  // CORS：FRONTEND_URL + EXTRA_CORS_ORIGINS（公网 IP 等）
  // 关键：webhook 路径不做 CORS 校验（外部调用会带 Origin header）
  const allowedOrigins = new Set([config.FRONTEND_URL, ...config.EXTRA_CORS_ORIGINS_LIST]);
  await app.register(cors, {
    hook: 'preHandler',   // 用 preHandler 而非 onRequest，可以在路由匹配后再决定是否要 CORS
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);                          // 同源 / curl
      if (allowedOrigins.has(origin)) return cb(null, true);
      cb(new Error('CORS: origin 未授权'), false);
    },
    credentials: true,
  });

  // ★ 让 webhook 完全跳过 CORS：在 onRequest 阶段拦下并打个标记，
  //   但 @fastify/cors 的最简单旁路方式是用 origin 函数对 webhook URL 也直接放行
  //   → 改用更直接的方法：onRequest 阶段判断 url 后跳过 cors hook
  // 参考实现：用一个 preParsing hook 把 origin header 在 webhook 路径下"擦掉"，
  //   这样 cors 插件不会拦截。
  app.addHook('onRequest', async (req) => {
    const url = req.url || '';
    if (url.startsWith('/webhook/')) {
      // 把 Origin header 删掉，CORS 插件会因此跳过
      delete (req.headers as any).origin;
      delete (req.headers as any).Origin;
    }
  });

  await app.register(websocket);
  await registerRoutes(app);
  registerWsBridge(app);

  app.setErrorHandler((err: any, req, reply) => {
    logger.error({ err: err?.message ?? String(err), url: req.url }, 'HTTP 错误');
    reply.code(err?.statusCode ?? 500).send({ error: err?.message ?? 'internal_error' });
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ port: config.PORT, host: config.HOST }, `HTTP/WS 监听中`);
  if (allowedOrigins.size > 1) {
    logger.info({ origins: [...allowedOrigins] }, 'CORS 允许的 origin');
  }

  // 4. 策略引擎
  strategyEngine.start();

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '准备关闭');
    strategyEngine.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, '启动失败');
  process.exit(1);
});
