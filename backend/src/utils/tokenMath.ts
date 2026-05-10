import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { logger } from './logger.js';

/** 从链上读取 mint 的真实 decimals（自动判定 token program 类型） */
export async function getMintDecimals(conn: Connection, mintAddress: string): Promise<{ decimals: number; programId: PublicKey } | null> {
  const mintPk = new PublicKey(mintAddress);
  // 先按 SPL Token 程序读
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const info = await getMint(conn, mintPk, 'confirmed', programId);
      return { decimals: info.decimals, programId };
    } catch {
      // 继续尝试下一个程序
    }
  }
  logger.warn({ mint: mintAddress }, '无法从链上读取 mint decimals');
  return null;
}

/**
 * 读取钱包某个 mint 的实际 raw 余额（直接走 getTokenAccountBalance，比 getParsedTokenAccountsByOwner 快）。
 * 找不到 ATA 时返回 0。
 */
export async function getOwnerTokenRawBalance(
  conn: Connection,
  owner: PublicKey,
  mintAddress: string,
  programId: PublicKey,
): Promise<{ amountRaw: bigint; decimals: number } | null> {
  try {
    const mintPk = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mintPk, owner, false, programId);
    const r = await conn.getTokenAccountBalance(ata, 'confirmed');
    return { amountRaw: BigInt(r.value.amount), decimals: r.value.decimals };
  } catch (e: any) {
    // ATA 不存在 = 余额 0
    return null;
  }
}

/**
 * 一次性读取：mint 的 decimals + 钱包当前余额（用于 buy/sell 前后 diff）
 */
export async function getOwnerBalanceWithDecimals(
  conn: Connection,
  owner: PublicKey,
  mintAddress: string,
): Promise<{ amountRaw: bigint; decimals: number; programId: PublicKey } | null> {
  const m = await getMintDecimals(conn, mintAddress);
  if (!m) return null;
  const b = await getOwnerTokenRawBalance(conn, owner, mintAddress, m.programId);
  return {
    amountRaw: b?.amountRaw ?? 0n,
    decimals: m.decimals,
    programId: m.programId,
  };
}

/** raw -> ui 数量（避免浮点精度损失：用 string 处理大数） */
export function rawToUi(raw: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  const integer = raw / divisor;
  const fraction = raw % divisor;
  // 浮点转换前先做字符串拼接保留精度
  const fractionStr = fraction.toString().padStart(decimals, '0');
  return Number(`${integer}.${fractionStr}`);
}
