import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Keystore 文件结构（加密后）
 * {
 *   version: 1,
 *   address: "<公钥 base58>",
 *   crypto: {
 *     cipher: "aes-256-gcm",
 *     kdf: "scrypt",
 *     kdfparams: { N, r, p, salt(hex) },
 *     iv: "<hex>",
 *     authTag: "<hex>",
 *     ciphertext: "<hex>"  // 加密前是 64 字节的 secretKey
 *   }
 * }
 */

export interface Keystore {
  version: 1;
  address: string;
  crypto: {
    cipher: 'aes-256-gcm';
    kdf: 'scrypt';
    kdfparams: { N: number; r: number; p: number; salt: string };
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

const SCRYPT_N = 1 << 15;  // 32768，强度足够同时不卡死
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
}

export function encryptSecretKey(secretKey: Uint8Array, password: string): Keystore {
  if (secretKey.length !== 64) {
    throw new Error(`secretKey 长度应为 64 字节，实际 ${secretKey.length}`);
  }
  if (password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const kp = Keypair.fromSecretKey(secretKey);
  return {
    version: 1,
    address: kp.publicKey.toBase58(),
    crypto: {
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      kdfparams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('hex') },
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    },
  };
}

export function decryptKeystore(ks: Keystore, password: string): Keypair {
  if (ks.version !== 1) throw new Error('keystore 版本不支持');
  const { kdfparams, iv, authTag, ciphertext } = ks.crypto;
  const salt = Buffer.from(kdfparams.salt, 'hex');
  const key = scryptSync(password, salt, KEY_LEN, {
    N: kdfparams.N,
    r: kdfparams.r,
    p: kdfparams.p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
  } catch {
    throw new Error('密码错误或 keystore 损坏');
  }
  const kp = Keypair.fromSecretKey(plaintext);
  // 校验地址一致
  const expected = Buffer.from(ks.address);
  const actual = Buffer.from(kp.publicKey.toBase58());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('keystore 校验失败：地址不匹配');
  }
  return kp;
}

export async function writeKeystore(filePath: string, ks: Keystore): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  // 写临时文件再 rename，避免中途崩溃损坏 keystore
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export async function readKeystore(filePath: string): Promise<Keystore> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as Keystore;
}

export function keystoreExists(filePath: string): boolean {
  return existsSync(filePath);
}

/** 把 base58 私钥字符串解析成 Keypair（导入用） */
export function keypairFromBase58(secretBase58: string): Keypair {
  const secret = bs58.decode(secretBase58);
  if (secret.length !== 64) {
    throw new Error('Solana 私钥应为 64 字节 base58 编码');
  }
  return Keypair.fromSecretKey(secret);
}
