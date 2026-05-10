import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { decryptKeystore, keystoreExists, readKeystore } from './keystore.js';
import path from 'path';

const KEYSTORE_PATH = path.resolve(process.cwd(), 'wallet.keystore.json');

class WalletManager {
  private keypair: Keypair | null = null;
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: config.SOLANA_WS_URL,
    });
  }

  get isUnlocked(): boolean {
    return this.keypair !== null;
  }

  get publicKey(): PublicKey {
    if (!this.keypair) throw new Error('钱包未解锁');
    return this.keypair.publicKey;
  }

  get address(): string {
    return this.publicKey.toBase58();
  }

  get conn(): Connection {
    return this.connection;
  }

  async unlock(password: string): Promise<void> {
    if (!keystoreExists(KEYSTORE_PATH)) {
      throw new Error(`找不到 keystore 文件：${KEYSTORE_PATH}，请先运行 npm run wallet:create`);
    }
    const ks = await readKeystore(KEYSTORE_PATH);
    this.keypair = decryptKeystore(ks, password);
    logger.info({ address: this.address }, '钱包已解锁');
  }

  /** 签名一笔 VersionedTransaction（不广播） */
  signTransaction(tx: VersionedTransaction): VersionedTransaction {
    if (!this.keypair) throw new Error('钱包未解锁');
    tx.sign([this.keypair]);
    return tx;
  }

  async getSolBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }
}

export const wallet = new WalletManager();
