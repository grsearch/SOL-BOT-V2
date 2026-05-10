import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
  // 防止意外把私钥/密码打到日志
  redact: {
    paths: [
      '*.privateKey',
      '*.secretKey',
      '*.password',
      '*.mnemonic',
      'WALLET_PASSWORD',
      'X_BEARER_TOKEN',
      'BIRDEYE_API_KEY',
      'HELIUS_API_KEY',
      'JUPITER_API_KEY',
      'DISCORD_WEBHOOK_URL',
    ],
    censor: '[REDACTED]',
  },
});
