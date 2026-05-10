/**
 * Wilder 平滑 RSI 计算（与 TradingView 默认一致）。
 *
 * 输入收盘价数组（按时间从旧到新），返回最新的 RSI 值。
 * 数据点不足 period+1 时返回 null。
 *
 * 算法：
 *   gain[i] = max(close[i] - close[i-1], 0)
 *   loss[i] = max(close[i-1] - close[i], 0)
 *   首段 avgGain/avgLoss = mean(前 period 个)
 *   后续 avgGain = (prev * (period-1) + gain) / period   ← Wilder smoothing
 *   RS = avgGain / avgLoss
 *   RSI = 100 - 100/(1+RS)
 *
 * 边界：
 *   avgLoss == 0 → RSI = 100
 *   avgGain == 0 → RSI = 0
 */
export function rsi(closes: number[], period = 7): number | null {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  // 1. 算 gain / loss 序列（长度 = closes.length - 1）
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // 2. 初始 SMA（前 period 个 gain/loss 的均值）
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // 3. Wilder 平滑迭代到最新一根
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
