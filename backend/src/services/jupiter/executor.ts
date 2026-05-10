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

  // ★ BUG #6 修：从链上拿真实 decimals
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

  const quote = await jupiter.quote({
    inputMint: SOL_MINT,
    outputMint: args.tokenAddress,
    amountRaw: inAmountRaw,
    slippageBps: args.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS,
  });

  const expectedOutUi = rawToUi(BigInt(quote.outAmount), decimals);
  const priceUsd = t.price_usd ?? null;
  const solPriceUsd = await getCachedSolPrice();

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
    priority_fee_lamports: config.DEFAULT_PRIORITY_FEE_LAMPORTS,
    created_at: Date.now(),
    realized_pnl_sol: null,
  });

  let result;
  try {
    result = await jupiter.executeSwap(quote);
  } catch (e: any) {
    tradeRepo.markFailed(tradeId, e.message ?? String(e));
    throw e;
  }

  const conf = await helius.confirmTransaction(result.signature, 90_000);
  if (!conf.success) {
    tradeRepo.markFailed(tradeId, `确认失败: ${JSON.stringify(conf.err)}`, result.signature);
    throw new Error(`交易确认失败：${result.signature}`);
  }

  // ★ BUG #7 修：链上 diff 拿真实到账数量
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

  logger.info({ token: args.tokenAddress, sol: args.solAmount, gotUi: actualOutUi, sig: result.signature }, '买入成功');

  return { tradeId, signature: result.signature, tokenAmountUi: actualOutUi };
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

  const inAmountRawBn = before.amountRaw;     // 全卖
  const inAmountRaw = inAmountRawBn.toString();
  const sellUi = rawToUi(inAmountRawBn, decimals);

  const quote = await jupiter.quote({
    inputMint: args.tokenAddress,
    outputMint: SOL_MINT,
    amountRaw: inAmountRaw,
    slippageBps: args.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS,
  });

  const expectedSolUi = Number(quote.outAmount) / LAMPORTS_PER_SOL;
  const solPriceUsd = await getCachedSolPrice();

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
    priority_fee_lamports: config.DEFAULT_PRIORITY_FEE_LAMPORTS,
    created_at: Date.now(),
    realized_pnl_sol: null,
  });

  let result;
  try {
    result = await jupiter.executeSwap(quote);
  } catch (e: any) {
    tradeRepo.markFailed(tradeId, e.message ?? String(e));
    throw e;
  }

  const conf = await helius.confirmTransaction(result.signature, 90_000);
  if (!conf.success) {
    tradeRepo.markFailed(tradeId, `确认失败: ${JSON.stringify(conf.err)}`, result.signature);
    throw new Error(`卖出确认失败：${result.signature}`);
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
  }, '卖出成功（全仓）');

  return {
    tradeId,
    signature: result.signature,
    solReceived: actualSolReceived,
    realizedPnlSol: sellResult.realized,
  };
}
