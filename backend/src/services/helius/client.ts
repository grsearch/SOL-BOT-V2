import axios from 'axios';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Commitment } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export interface TokenBalance {
  mint: string;
  amountRaw: string;
  amountUi: number;
  decimals: number;
  ata: string;
}

class HeliusClient {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: config.SOLANA_WS_URL,
    });
  }

  get conn(): Connection { return this.connection; }

  async getSolBalance(owner: PublicKey): Promise<number> {
    const lamports = await this.connection.getBalance(owner, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }

  /** 列出钱包所有 SPL Token 余额（包括 token-2022） */
  async getAllTokenBalances(owner: PublicKey): Promise<TokenBalance[]> {
    const out: TokenBalance[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await this.connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed');
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        const amount = info.tokenAmount;
        if (amount.uiAmount && amount.uiAmount > 0) {
          out.push({
            mint: info.mint,
            amountRaw: amount.amount,
            amountUi: amount.uiAmount,
            decimals: amount.decimals,
            ata: a.pubkey.toBase58(),
          });
        }
      }
    }
    return out;
  }

  async getTokenBalance(owner: PublicKey, mint: string): Promise<TokenBalance | null> {
    const balances = await this.getAllTokenBalances(owner);
    return balances.find(b => b.mint === mint) ?? null;
  }

  async confirmTransaction(signature: string, timeoutMs = 60_000): Promise<{ success: boolean; err?: any }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // ★ BUG #6 修：刚提交的 tx 还没进 ledger，不需要 searchTransactionHistory（且耗 RPC 额度）
        const r = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: false });
        const v = r.value;
        if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') {
          if (v.err) return { success: false, err: v.err };
          return { success: true };
        }
      } catch (e: any) {
        logger.warn({ err: e.message }, 'getSignatureStatus 失败，继续轮询');
      }
      await sleep(2000);
    }
    return { success: false, err: 'confirm-timeout' };
  }

  /**
   * Holders 数量。
   * 直接用 RPC 的 getProgramAccounts 配合 mint filter 数 owner 唯一数会非常慢，
   * 且 Helius 部分 RPC 限制了 getProgramAccounts。
   *
   * 推荐做法：调用 Helius DAS API 的 getTokenAccounts，分页统计 owner 集合。
   * 这里给出 DAS 实现，TODO 是大代币（百万级 holders）需要做并行分页。
   */
  async getHoldersCount(mint: string): Promise<number | null> {
    const url = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    const owners = new Set<string>();
    let page = 1;
    const pageSize = 1000;
    const maxPages = 50; // 上限保护：5 万 holders 之后近似返回。够用了。
    let sawAnyResponse = false;
    try {
      while (page <= maxPages) {
        const resp = await axios.post(url, {
          jsonrpc: '2.0',
          id: 'helius-holders',
          method: 'getTokenAccounts',
          params: { mint, page, limit: pageSize },
        }, { timeout: 20_000 });
        // ★ BUG #4 修：区分 "API 失败/auth 错" 和 "真没 holders"
        if (resp.data?.error) {
          logger.warn({ err: resp.data.error, mint }, 'helius getTokenAccounts 返回 error');
          return null;
        }
        const result = resp.data?.result;
        if (!result || !Array.isArray(result.token_accounts)) {
          // result 缺失说明 API 调用未成功
          logger.warn({ resp: resp.data, mint }, 'helius getTokenAccounts 响应格式异常');
          return null;
        }
        sawAnyResponse = true;
        const accounts: any[] = result.token_accounts;
        if (accounts.length === 0) break;
        for (const a of accounts) {
          if (a.owner && Number(a.amount) > 0) owners.add(a.owner);
        }
        if (accounts.length < pageSize) break;
        page++;
      }
      // 起码拿到一次成功响应才返回 size，否则视为失败
      return sawAnyResponse ? owners.size : null;
    } catch (e: any) {
      logger.warn({ err: e?.response?.data ?? e?.message, mint }, 'helius getHoldersCount 失败');
      return null;
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export const helius = new HeliusClient();
