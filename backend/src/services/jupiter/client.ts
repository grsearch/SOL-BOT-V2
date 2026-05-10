import axios, { AxiosInstance } from 'axios';
import { VersionedTransaction, Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { wallet } from '../../wallet/index.js';

const QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapResult {
  signature: string;
  inAmountRaw: string;
  outAmountRaw: string;
  slippageBpsUsed: number;
  priorityFeeLamports: number;
  computeUnitLimit?: number;
}

class JupiterClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: 30_000,
      headers: config.JUPITER_API_KEY
        ? { 'x-api-key': config.JUPITER_API_KEY, accept: 'application/json' }
        : { accept: 'application/json' },
    });
  }

  /** 获取 swap 报价 */
  async quote(args: {
    inputMint: string;
    outputMint: string;
    amountRaw: string;        // 输入金额（最小单位字符串）
    slippageBps?: number;     // 兜底滑点（dynamic slippage 也会用这个上限）
    swapMode?: 'ExactIn' | 'ExactOut';
  }): Promise<QuoteResponse> {
    const params: Record<string, any> = {
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amountRaw,
      slippageBps: args.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS,
      swapMode: args.swapMode ?? 'ExactIn',
      restrictIntermediateTokens: true,    // ★ 防止路由到低流动性中间币（防夹关键）
    };
    const r = await this.http.get(QUOTE_URL, { params });
    return r.data as QuoteResponse;
  }

  /**
   * 用 quote 构建 swap 交易并签名+发送
   *
   * 防夹/抗失败手段：
   * 1. dynamicSlippage: 动态计算滑点（上限由用户给的 slippageBps 决定）
   * 2. priorityLevel: veryHigh - 提高上链优先级
   * 3. restrictIntermediateTokens（在 quote 里）
   * 4. dynamicComputeUnitLimit: true - 自动算 CU
   * 5. MEV protection: 走 Jito 私有内存池（如果配置了 JITO_TIP_LAMPORTS > 0）
   */
  async executeSwap(quote: QuoteResponse): Promise<SwapResult> {
    if (!wallet.isUnlocked) throw new Error('钱包未解锁，无法执行交易');

    const useMev = config.JITO_TIP_LAMPORTS > 0;

    // ★ BUG #12 修：以用户/quote 指定的 slippageBps 为上限，不被 DEFAULT 反向放大
    const dynamicSlippageMaxBps = quote.slippageBps;

    // ★ BUG #2 修：/swap 接口不支持同时设置 priorityLevel 和 jitoTipLamports
    // 见 Jupiter 文档：https://github.com/jup-ag/jupiter-quote-api-node/blob/main/swagger.yaml
    // "If you want to include both, you will need to use /swap-instructions"
    // MEV 模式下只用 jitoTipLamports（tip 本身就构成优先级）；非 MEV 模式才用 priorityLevel。
    const swapBody: Record<string, any> = {
      userPublicKey: wallet.address,
      quoteResponse: quote,
      dynamicSlippage: { maxBps: dynamicSlippageMaxBps },
      dynamicComputeUnitLimit: true,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: useMev
        ? { jitoTipLamports: config.JITO_TIP_LAMPORTS }
        : {
            priorityLevelWithMaxLamports: {
              priorityLevel: 'veryHigh',
              maxLamports: config.DEFAULT_PRIORITY_FEE_LAMPORTS,
            },
          },
    };

    const r = await this.http.post(SWAP_URL, swapBody);
    const data = r.data;
    const swapTxBase64 = data.swapTransaction as string;
    if (!swapTxBase64) throw new Error('Jupiter 返回 swapTransaction 为空');

    // 反序列化
    const swapTxBuf = Buffer.from(swapTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(swapTxBuf);

    // ★ 模拟一遍，失败就别浪费 gas
    const sim = await wallet.conn.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
    if (sim.value.err) {
      logger.warn({ err: sim.value.err, logs: sim.value.logs?.slice(-5) }, 'swap simulate 失败');
      throw new Error(`交易模拟失败: ${JSON.stringify(sim.value.err)}`);
    }

    // 签名
    wallet.signTransaction(tx);

    // 发送
    const rawTx = tx.serialize();
    const signature = await wallet.conn.sendRawTransaction(rawTx, {
      skipPreflight: true,    // 已经 simulate 过，跳过 preflight 加速
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    logger.info({ signature, useMev }, 'Swap 已提交');

    return {
      signature,
      inAmountRaw: quote.inAmount,
      outAmountRaw: quote.outAmount,
      slippageBpsUsed: quote.slippageBps,
      priorityFeeLamports: data.prioritizationFeeLamports ?? config.DEFAULT_PRIORITY_FEE_LAMPORTS,
      computeUnitLimit: data.computeUnitLimit,
    };
  }
}

export const jupiter = new JupiterClient();
