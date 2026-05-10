import { Keypair } from '@solana/web3.js';
import { createInterface } from 'readline';
import path from 'path';
import bs58 from 'bs58';
import { encryptSecretKey, keystoreExists, keypairFromBase58, readKeystore, writeKeystore } from './keystore.js';

const KEYSTORE_PATH = path.resolve(process.cwd(), 'wallet.keystore.json');

function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      // 简易隐藏输入：写出 question 然后用一个 muted 流读
      process.stdout.write(question);
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
          rl.close();
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
    } else {
      rl.question(question, (ans) => {
        rl.close();
        resolve(ans);
      });
    }
  });
}

async function askPasswordTwice(): Promise<string> {
  const p1 = await prompt('设置加密密码（≥8位）: ', true);
  if (p1.length < 8) {
    console.error('❌ 密码至少 8 位');
    process.exit(1);
  }
  const p2 = await prompt('再输一次确认: ', true);
  if (p1 !== p2) {
    console.error('❌ 两次密码不一致');
    process.exit(1);
  }
  return p1;
}

async function confirmOverwrite(): Promise<void> {
  if (keystoreExists(KEYSTORE_PATH)) {
    const ans = await prompt(`⚠️  ${KEYSTORE_PATH} 已存在，覆盖会永久丢失旧钱包。继续？(yes/no): `);
    if (ans.trim().toLowerCase() !== 'yes') {
      console.log('已取消');
      process.exit(0);
    }
  }
}

async function cmdCreate(): Promise<void> {
  await confirmOverwrite();
  const kp = Keypair.generate();
  const password = await askPasswordTwice();
  const ks = encryptSecretKey(kp.secretKey, password);
  await writeKeystore(KEYSTORE_PATH, ks);

  console.log('\n✅ 钱包创建成功');
  console.log(`   地址: ${kp.publicKey.toBase58()}`);
  console.log(`   keystore: ${KEYSTORE_PATH}`);
  console.log('\n⚠️  请离线备份私钥（base58）：');
  console.log(`   ${bs58.encode(kp.secretKey)}`);
  console.log('\n   备份后请清除终端历史，私钥泄露 = 资金归零。');
}

async function cmdImport(): Promise<void> {
  await confirmOverwrite();
  const sk = await prompt('粘贴 base58 私钥（输入会隐藏）: ', true);
  let kp: Keypair;
  try {
    kp = keypairFromBase58(sk.trim());
  } catch (e: any) {
    console.error('❌ 私钥解析失败:', e.message);
    process.exit(1);
  }
  console.log(`即将导入地址: ${kp.publicKey.toBase58()}`);
  const password = await askPasswordTwice();
  const ks = encryptSecretKey(kp.secretKey, password);
  await writeKeystore(KEYSTORE_PATH, ks);
  console.log(`\n✅ 已导入并加密保存到 ${KEYSTORE_PATH}`);
}

async function cmdShow(): Promise<void> {
  if (!keystoreExists(KEYSTORE_PATH)) {
    console.error(`找不到 ${KEYSTORE_PATH}`);
    process.exit(1);
  }
  const ks = await readKeystore(KEYSTORE_PATH);
  console.log(`地址: ${ks.address}`);
  console.log(`版本: ${ks.version}`);
  console.log(`KDF: ${ks.crypto.kdf} N=${ks.crypto.kdfparams.N}`);
  console.log(`Cipher: ${ks.crypto.cipher}`);
}

const cmd = process.argv[2];
const handlers: Record<string, () => Promise<void>> = {
  create: cmdCreate,
  import: cmdImport,
  show: cmdShow,
};
const fn = handlers[cmd];
if (!fn) {
  console.error('用法: npm run wallet:create | wallet:import | wallet:show');
  process.exit(1);
}
fn().catch((e) => {
  console.error(e);
  process.exit(1);
});
