// f0 自适应移调(WT 唱歌定稿公式):把输入歌声中位 f0 拉进模型训练带。
// 输出旋律音程完整保留(所有音符同幅平移),清唱场景即"在调上"。

export function keyForMedianF0(
  medianHz: number,
  targetHz: number,
  keyMin: number,
  keyMax: number,
): number {
  if (!Number.isFinite(medianHz) || medianHz <= 0) return 0;
  if (!Number.isFinite(targetHz) || targetHz <= 0) return 0;
  // WT-P3-006:边界防御取整(schema 已限整数,此处兜底防小数边界的非整数钳位结果)
  const lo = Math.round(keyMin);
  const hi = Math.round(keyMax);
  const raw = Math.round(12 * Math.log2(targetHz / medianHz));
  return Math.min(hi, Math.max(lo, raw));
}
