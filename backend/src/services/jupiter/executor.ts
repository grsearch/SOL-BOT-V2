import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { wallet } from '../../wallet/index.js';
import { jupiter } from './client.js';
import { helius } from '../helius/client.js';
import { tokenRepo, positionRepo, tradeRepo, SOL_MINT } from '../../db/repo.js';
import { getOwnerBalanceWithDecimals, rawToUi } from '../../utils/tokenMath.js';
import { getCachedSolPrice } from '../../utils/solPrice.js';
import type { TradeTrigger } from '../../types/index.js';

export type { TradeTrigger };

const SOL_DECIMALS = 9;
const GAS_RESERVE_SOL = 0.01;

/** 把 SOL（UI）转 lamports 字符串，避免浮点损失 */
function solToLamportsRaw(solAmount: number): string {
  const fixed = solAmount.toFixed(SOL_DECIMALS);
  const [intPart, fracPart = ''] = fixed.split('.');
  const padded = (fracPart + '0'.repeat(SOL_DECIMALS)).slice(0, SOL_DECIMALS);
  return (BigInt(intPart) * BigInt(LAMPORTS_PER_SOL) + BigInt(padded)).toString();
}

// 重试参数：每次失败时把这些 multiplier 乘到原值上
const MAX_ATTEMPTS = 2;
const RETRY_SLIPPAGE_MULTIPLIER = 1.5;
const RETRY_PRIORITY_FEE_MULTIPLIER = 2;
const RETRY_JITO_TIP_MULTIPLIER = 2;
// 滑点硬上限（避免重试时给出离谱滑点）
const MAX_SLIPPAGE_BPS = 5000; // 50%

/** 判定 error 是否安全重试（confirm 超时**不可**重试，可能上链了） */
function isRetryableError(e: any): boolean {
  const msg = (e?.message ?? String(e)).toLowerCase();
  if (msg.includes('confirm-timeout') || msg.includes('确认失败')) {
    // 这两种情况 tx 可能已经上链，绝不重试
    return false;
  }
  // 钱包未解锁、余额不足等业务错误，重试也是同样结果，不重试
  if (msg.includes('钱包未解锁') || msg.includes('余额不足') || msg.includes('未知')) {
    return false;
  }
  // 模拟失败、jupiter quote 失败、提交失败、网络错误 → 重试
  return true;
}

/** 买入：用 SOL 换目标代币 */
export async function buyToken(args: {
  tokenAddress: string;
  solAmount: number;
  trigger: TradeTrigger;
  slippageBps?: number;
}): Promise<{ tradeId: number; signature: string; tokenAmountUi: number }> {
  if (!wallet.isUnlocked) throw new Error('钱包未解锁');
  const t = tokenRepo.get(args.tokenAddress);
  if (!t) throw new Error(`代币 ${args.tokenAddress} 不在监控列表`);
  if (t.monitor_active === 0) throw new Error('该代币已被移除监控，无法买入');

  const solBal = await wallet.getSolBalance();
  if (solBal < args.solAmount + GAS_RESERVE_SOL) {
    throw new Error(`SOL 余额不足：钱包 ${solBal.toFixed(4)}，需要 ${args.solAmount} + ${GAS_RESERVE_SOL} (gas)`);
  }

  // ★ 从链上拿真实 decimals
  const tokenInfo = await getOwnerBalanceWithDecimals(wallet.conn, wallet.publicKey, args.tokenAddress);
  if (!tokenInfo) {
    throw new Error(`无法读取 mint decimals，CA 可能无效：${args.tokenAddress}`);
  }
  const decimals = tokenInfo.decimals;
  const balanceBefore = tokenInfo.amountRaw;
  if (t.decimals !== decimals) {
    tokenRepo.upsert({ address: args.tokenAddress, decimals });
  }

  const inAmountRaw = solToLamportsRaw(args.solAmount);
  const baseSlippage = args.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS;
  const solPriceUsd = await getCachedSolPrice();
  const priceUsd = t.price_usd ?? null;

  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 第 N 次尝试时按倍数提高参数
    const slippageBps = Math.min(MAX_SLIPPAGE_BPS,
      Math.floor(baseSlippage * Math.pow(RETRY_SLIPPAGE_MULTIPLIER, attempt - 1)));
    const priorityFee = Math.floor(config.DEFAULT_PRIORITY_FEE_LAMPORTS * Math.pow(RETRY_PRIORITY_FEE_MULTIPLIER, attempt - 1));
    const jitoTip = config.JITO_TIP_LAMPORTS > 0
      ? Math.floor(config.JITO_TIP_LAMPORTS * Math.pow(RETRY_JITO_TIP_MULTIPLIER, attempt - 1))
      : 0;

    if (attempt > 1) {
      logger.warn({
        attempt, token: args.tokenAddress,
        slippageBps, priorityFee, jitoTip,
      }, '买入重试中（已提高滑点/fee/tip）');
    }

    // 每次重试要重新拿 quote（市场价格变了）
    let quote;
    try {
      quote = await jupiter.quote({
        inputMint: SOL_MINT,
        outputMint: args.tokenAddress,
        amountRaw: inAmountRaw,
        slippageBps,
      });
    } catch (e: any) {
      lastErr = e;
      logger.warn({ err: e.message, attempt }, 'quote 失败');
      if (!isRetryableError(e) || attempt >= MAX_ATTEMPTS) break;
      continue;
    }

    const expectedOutUi = rawToUi(BigInt(quote.outAmount), decimals);
    const tradeId = tradeRepo.insertPending({
      token_address: args.tokenAddress,
      side: 'buy',
      trigger: args.trigger,
      in_mint: SOL_MINT,
      out_mint: args.tokenAddress,
      in_amount_raw: inAmountRaw,
      out_amount_raw: quote.outAmount,
      in_amount_ui: args.solAmount,
      out_amount_ui: expectedOutUi,
      price_usd_at_trade: priceUsd,
      sol_price_usd_at_trade: solPriceUsd,
      status: 'pending',
      slippage_bps: quote.slippageBps,
      priority_fee_lamports: priorityFee,
      created_at: Date.now(),
      realized_pnl_sol: null,
    });

    let result;
    try {
      result = await jupiter.executeSwap(quote, { jitoTipLamports: jitoTip, priorityFeeLamports: priorityFee });
    } catch (e: any) {
      tradeRepo.markFailed(tradeId, e.message ?? String(e));
      lastErr = e;
      if (!isRetryableError(e) || attempt >= MAX_ATTEMPTS) break;
      continue;
    }

    const conf = await helius.confirmTransaction(result.signature, 90_000);
    if (!conf.success) {
      const errMsg = `确认失败: ${JSON.stringify(conf.err)}`;
      tradeRepo.markFailed(tradeId, errMsg, result.signature);
      lastErr = new Error(errMsg);
      // confirm 超时/失败：tx 可能已上链，绝不重试
      logger.warn({ sig: result.signature, err: conf.err, attempt }, '买入 confirm 失败，不再重试');
      break;
    }

    // 成功 → 处理余额差 + 写持仓
    const after = await getOwnerBalanceWithDecimals(wallet.conn, wallet.publicKey, args.tokenAddress);
    const balanceAfter = after?.amountRaw ?? 0n;
    let actualOutRaw = balanceAfter - balanceBefore;
    if (actualOutRaw <= 0n) {
      logger.warn({ token: args.tokenAddress, balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString() }, '买入后链上 diff <=0，回退用 quote.outAmount');
      actualOutRaw = BigInt(quote.outAmount);
    }
    const actualOutUi = rawToUi(actualOutRaw, decimals);

    tradeRepo.markSuccess(tradeId, result.signature, Date.now(), {
      outAmountRaw: actualOutRaw.toString(),
      outAmountUi: actualOutUi,
    });

    const avgPriceUsd = priceUsd ?? (solPriceUsd && actualOutUi > 0 ? (args.solAmount * solPriceUsd) / actualOutUi : 0);
    const avgPriceSol = actualOutUi > 0 ? args.solAmount / actualOutUi : 0;
    positionRepo.applyBuy({
      token_address: args.tokenAddress,
      amount_raw_added: actualOutRaw.toString(),
      amount_ui_added: actualOutUi,
      sol_spent: args.solAmount,
      price_usd: avgPriceUsd,
      price_sol: avgPriceSol,
      ts: Date.now(),
    });

    logger.info({
      token: args.tokenAddress, sol: args.solAmount, gotUi: actualOutUi,
      sig: result.signature, attempt,
    }, '买入成功');

    return { tradeId, signature: result.signature, tokenAmountUi: actualOutUi };
  }

  throw lastErr ?? new Error('买入失败');
}

/**
 * 卖出：用代币换 SOL。
 *
 * ★ 重要语义：永远全仓卖出钱包里这个 mint 的所有余额。
 * 这意味着不管该代币是程序自动买入的、手动买入的、还是 webhook 之外打过来的，
 * 一旦触发卖出（手动或自动），都会清空钱包对该 mint 的全部持仓。
 */
export async function sellToken(args: {
  tokenAddress: string;
  trigger: TradeTrigger;
  slippageBps?: number;
}): Promise<{ tradeId: number; signature: string; solReceived: number; realizedPnlSol: number }> {
  if (!wallet.isUnlocked) throw new Error('钱包未解锁');
  const t = tokenRepo.get(args.tokenAddress);
  if (!t) throw new Error(`代币 ${args.tokenAddress} 未知`);

  // 链上 raw 余额（永远全卖）
  const before = await getOwnerBalanceWithDecimals(wallet.conn, wallet.publicKey, args.tokenAddress);
  if (!before || before.amountRaw <= 0n) {
    throw new Error('钱包没有该代币余额，无法卖出');
  }
  const decimals = before.decimals;
  const balanceBeforeSol = await wallet.getSolBalance();

  const inAmountRawBn = before.amountRaw;
  const inAmountRaw = inAmountRawBn.toString();
  const sellUi = rawToUi(inAmountRawBn, decimals);
  const baseSlippage = args.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS;
  const solPriceUsd = await getCachedSolPrice();

  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const slippageBps = Math.min(MAX_SLIPPAGE_BPS,
      Math.floor(baseSlippage * Math.pow(RETRY_SLIPPAGE_MULTIPLIER, attempt - 1)));
    const priorityFee = Math.floor(config.DEFAULT_PRIORITY_FEE_LAMPORTS * Math.pow(RETRY_PRIORITY_FEE_MULTIPLIER, attempt - 1));
    const jitoTip = config.JITO_TIP_LAMPORTS > 0
      ? Math.floor(config.JITO_TIP_LAMPORTS * Math.pow(RETRY_JITO_TIP_MULTIPLIER, attempt - 1))
      : 0;

    if (attempt > 1) {
      logger.warn({
        attempt, token: args.tokenAddress,
        slippageBps, priorityFee, jitoTip,
      }, '卖出重试中（已提高滑点/fee/tip）');
    }

    let quote;
    try {
      quote = await jupiter.quote({
        inputMint: args.tokenAddress,
        outputMint: SOL_MINT,
        amountRaw: inAmountRaw,
        slippageBps,
      });
    } catch (e: any) {
      lastErr = e;
      logger.warn({ err: e.message, attempt }, 'sell quote 失败');
      if (!isRetryableError(e) || attempt >= MAX_ATTEMPTS) break;
      continue;
    }

    const expectedSolUi = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const tradeId = tradeRepo.insertPending({
      token_address: args.tokenAddress,
      side: 'sell',
      trigger: args.trigger,
      in_mint: args.tokenAddress,
      out_mint: SOL_MINT,
      in_amount_raw: inAmountRaw,
      out_amount_raw: quote.outAmount,
      in_amount_ui: sellUi,
      out_amount_ui: expectedSolUi,
      price_usd_at_trade: t.price_usd,
      sol_price_usd_at_trade: solPriceUsd,
      status: 'pending',
      slippage_bps: quote.slippageBps,
      priority_fee_lamports: priorityFee,
      created_at: Date.now(),
      realized_pnl_sol: null,
    });

    let result;
    try {
      result = await jupiter.executeSwap(quote, { jitoTipLamports: jitoTip, priorityFeeLamports: priorityFee });
    } catch (e: any) {
      tradeRepo.markFailed(tradeId, e.message ?? String(e));
      lastErr = e;
      if (!isRetryableError(e) || attempt >= MAX_ATTEMPTS) break;
      continue;
    }

    const conf = await helius.confirmTransaction(result.signature, 90_000);
    if (!conf.success) {
      const errMsg = `确认失败: ${JSON.stringify(conf.err)}`;
      tradeRepo.markFailed(tradeId, errMsg, result.signature);
      lastErr = new Error(errMsg);
      logger.warn({ sig: result.signature, err: conf.err, attempt }, '卖出 confirm 失败，不再重试');
      break;
    }

    const balanceAfterSol = await wallet.getSolBalance();
    let actualSolReceived = balanceAfterSol - balanceBeforeSol;
    if (actualSolReceived <= 0) {
      logger.warn({ before: balanceBeforeSol, after: balanceAfterSol }, 'sell 后 SOL diff <=0，回退用 quote.outAmount');
      actualSolReceived = expectedSolUi;
    }

    const sellResult = positionRepo.applySell({
      token_address: args.tokenAddress,
      amount_raw_sold: inAmountRaw,
      amount_ui_sold: sellUi,
      sol_received: actualSolReceived,
      ts: Date.now(),
    });

    tradeRepo.markSuccess(tradeId, result.signature, Date.now(), {
      outAmountRaw: BigInt(Math.round(actualSolReceived * LAMPORTS_PER_SOL)).toString(),
      outAmountUi: actualSolReceived,
      realizedPnlSol: sellResult.realized,
    });

    logger.info({
      token: args.tokenAddress, sold: sellUi, gotSol: actualSolReceived,
      realized: sellResult.realized, sig: result.signature, trigger: args.trigger,
      attempt,
    }, '卖出成功（全仓）');

    return {
      tradeId,
      signature: result.signature,
      solReceived: actualSolReceived,
      realizedPnlSol: sellResult.realized,
    };
  }

  throw lastErr ?? new Error('卖出失败');
}
