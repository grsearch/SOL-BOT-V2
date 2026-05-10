import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(path.resolve(process.cwd(), config.DATABASE_PATH));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL');
  }
  return _db;
}

/**
 * 找到 schema.sql 文件。
 * - tsx/dev：__dirname 指向 src/db/，schema.sql 就在隔壁
 * - tsc 编译后：__dirname 指向 dist/db/，schema.sql 不会被自动复制过来
 *   → 回退去找 ../../src/db/schema.sql、cwd/src/db/schema.sql 等
 */
function findSchemaPath(): string {
  const candidates = [
    path.join(__dirname, 'schema.sql'),                         // dev or build w/ asset copy
    path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), // dist → ../../src/db
    path.resolve(process.cwd(), 'src', 'db', 'schema.sql'),     // 从 backend/ 启动
    path.resolve(process.cwd(), 'backend', 'src', 'db', 'schema.sql'), // 从项目根启动
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`找不到 schema.sql，已尝试：\n  ${candidates.join('\n  ')}`);
}

export function migrate(): void {
  const db = getDb();
  const schemaPath = findSchemaPath();
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // 兼容性 ALTER：v0 版本 DB 升级路径（CREATE IF NOT EXISTS 不会改老表）
  ensureColumn(db, 'trades', 'realized_pnl_sol', 'REAL');
  // 新增：positions 增加 last_buy_price_usd（用于 DCA 补仓判定）
  ensureColumn(db, 'positions', 'last_buy_price_usd', 'REAL');
  // 新增：positions 增加 buy_count（限制 DCA 次数）
  ensureColumn(db, 'positions', 'buy_count', 'INTEGER NOT NULL DEFAULT 0');
  // 新增：tokens 增加 history2hPrice / history6hPrice / history24hPrice（用于反推真实 24h 高点）
  ensureColumn(db, 'tokens', 'history_2h_price', 'REAL');
  ensureColumn(db, 'tokens', 'history_6h_price', 'REAL');
  ensureColumn(db, 'tokens', 'history_24h_price', 'REAL');

  logger.info({ schemaPath }, '数据库迁移完成');
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info({ table, column }, '已添加 DB 列（兼容旧版）');
  }
}

// CLI: tsx src/db/migrate.ts
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate();
  console.log('✅ DB ready at', config.DATABASE_PATH);
}
