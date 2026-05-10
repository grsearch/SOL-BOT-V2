# SOL Trading Bot

Solana 链上自动交易机器人，包含 Dashboard、监控引擎、自动交易策略（RSI + 逢低买入 + 100% 止盈）。

## ⚠️ 安全须知（务必先读）

1. **永远不要把 `.env`、`wallet.keystore.json`、`data.db` 提交到 Git**。`.gitignore` 已配置好。
2. **机器人钱包只放当次交易需要的资金**。建议单独创建一个新钱包专门用于这个机器人。
3. **私钥用 AES-256-GCM 加密存盘**，启动时通过环境变量或交互式输入密码解锁。
4. 所有交易在签名前会做 `simulateTransaction`，失败的不会上链，避免白付 gas。
5. **API_TOKEN 强烈建议设置**，否则只能 loopback 访问，从公网 / Docker 都会 401。

## 功能清单

### Dashboard
- 24h 盈亏（已实现 + 未实现）、24h 交易笔数、持仓数、监控代币数、钱包余额
- 监控代币表：Symbol/CA、现价（实时 WS 推送）、距 24h 高跌幅、FDV、LP、24h Volume、Holders、Age、持仓数量、**单币实时盈亏（绿涨红跌）**
- **代币按跌幅排序**（跌得最多的排最前）
- 一键 GMGN 链接、复制 CA、移除监控
- 添加监控：手动 CA / Webhook 推送

### 自动交易策略

**卖出（任一触发即全仓卖出）：**
- 价格涨到平均买入价 2 倍 → 全仓止盈
- 15m K 线 RSI(7) > 80 → 立即全仓卖（超买信号）

**买入（自动逢低买入，可关闭）：**
- 首次：24h 跌幅 ≥ 70% **且** 15m RSI(7) < 30 → 买 1 SOL
- 补仓 (DCA)：相对自己上次买入价又跌 ≥ 50% **且** RSI(7) < 30 → 加 1 SOL
- 最多 5 次买入（含首次和所有 DCA）

**自动移除：**
- FDV < 30000 USD 或 LP < 10000 USD → 自动卖出后退出监控
- 5 分钟巡检一次

### 手动交易
- 买入：自定义 SOL 数量、滑点
- 卖出：**永远全仓**（清空钱包内该代币的全部余额，不论是程序自动买的还是外部打过来的）
- 滑点可调

### 防夹/抗失败
- Jupiter `dynamicSlippage`（默认上限 3%）
- 高优先级 fee + 可选 Jito MEV 保护
- 模拟后再签名，避免 gas 浪费

## 快速开始

### 1. 准备环境

需要 Node.js ≥ 20 和 npm。

```bash
git clone <your-repo>
cd sol-trading-bot
cp .env.example .env
# 编辑 .env：填入 Birdeye / Helius / Jupiter key、API_TOKEN
```

### 2. 创建并加密钱包

```bash
cd backend
npm install
npm run wallet:create  # 交互式生成新钱包并加密存盘
# 或导入已有私钥：
# npm run wallet:import
```

会生成 `backend/wallet.keystore.json`（已加密）。**请离线备份私钥**，命令会显示一次后请清掉终端历史。

### 3. 启动后端

```bash
cd backend
npm run db:migrate   # 初始化 SQLite
npm run dev          # 开发模式（tsx watch）
# 或生产模式：
# npm run build && npm start
```

启动时会要求输入钱包解锁密码（或读取 `WALLET_PASSWORD` 环境变量）。

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

**首次访问**：浏览器会弹出"需要 API Token"，把 `.env` 中 `API_TOKEN` 粘贴进去（保存到 localStorage）。也可以用 URL 参数：`http://localhost:5173/?api_token=你的token` 自动写入。

### 5. 生产部署（pm2 推荐）

```bash
cd backend
npm install
npm run build

# 用 pm2 启动后端（fork 模式确保 .env 加载正常）
pm2 start dist/index.js --name sol-bot --node-args="--enable-source-maps"
pm2 save
pm2 startup       # 设置开机自启
```

前端用 nginx 反代：

```nginx
server {
    listen 80;
    root /path/to/sol-trading-bot/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ { proxy_pass http://localhost:3001; }
    location /health { proxy_pass http://localhost:3001; }
    location /webhook/ { proxy_pass http://localhost:3001; }

    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 6. Docker

```bash
docker compose up -d
```

详见 `docker-compose.yml`。**Docker 模式下必须设置 `API_TOKEN`**，因为容器间不是 loopback。

## Webhook 接入（无鉴权）

```bash
curl -X POST http://your-host:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

⚠️ webhook 接口无鉴权，请用网络层（防火墙、反代白名单、Cloudflare Access 等）限制访问源。

## 安全配置一览

| 鉴权 | 用途 | 没设会怎样 |
|------|------|-----------|
| `WALLET_PASSWORD` | 解锁加密 keystore | 启动时交互式提示输入 |
| `API_TOKEN` | 前端调用 `/api/*` 和 `/ws` | 没设的话**只允许 loopback (127.0.0.1)** 访问，远程会 401 |

**强烈建议**：
- HOST 设为 `127.0.0.1`（仅本机）或者放在 nginx/Cloudflare Tunnel 后面
- 直接把 PORT 暴露到公网 + 不设 API_TOKEN = 任何人能调你的钱包做交易

## 主要环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `BIRDEYE_API_KEY` | - | Birdeye Premium Plus key |
| `HELIUS_API_KEY` | - | Helius Business plan key |
| `JUPITER_API_KEY` | - | Jupiter Developer plan key（可选） |
| `API_TOKEN` | - | 前端访问 API 的鉴权令牌 |
| `EXTRA_CORS_ORIGINS` | - | 额外允许的 CORS origin，逗号分隔 |
| `DEFAULT_BUY_SOL` | 1 | 手动买入默认 SOL 数量 |
| `DEFAULT_SLIPPAGE_BPS` | 300 | 默认滑点（3%） |
| `JITO_TIP_LAMPORTS` | 100000 | Jito MEV 保护 tip，0 = 关闭 |
| `TAKE_PROFIT_GAIN_PCT` | 100 | 止盈阈值（涨 100% = 2x） |
| `RSI_SELL_THRESHOLD` | 80 | RSI(7) 超买卖出阈值 |
| `AUTO_DIP_BUY_ENABLED` | true | 是否启用自动逢低买入 |
| `AUTO_DIP_BUY_SOL` | 1 | 首次自动买入金额 |
| `AUTO_DIP_BUY_DROP_24H_PCT` | 70 | 24h 跌幅阈值 |
| `AUTO_DIP_BUY_RSI_THRESHOLD` | 30 | 触发 RSI(7) 阈值 |
| `AUTO_DIP_DCA_DROP_PCT` | 50 | DCA 触发跌幅（vs 上次买入价） |
| `AUTO_DIP_DCA_SOL` | 1 | DCA 补仓金额 |
| `AUTO_DIP_MAX_BUYS` | 5 | 最多买入次数（含首次） |
| `FDV_MIN_USD` | 30000 | 自动移除的 FDV 下限 |
| `LP_MIN_USD` | 10000 | 自动移除的 LP 下限 |

完整变量见 `.env.example`。

## License

MIT - 仅供学习。链上交易有亏损风险，使用本软件造成的资金损失由使用者自行承担。
