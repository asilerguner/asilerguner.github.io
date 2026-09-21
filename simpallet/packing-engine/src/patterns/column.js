/**
 * Uniform grid layer pattern: every box in the same orientation.
 * Caller is expected to try both (l, w) and (w, l) via geometry.getOrientations.
 *
 * Real Cape Pack Cloud distributes each axis's own leftover space evenly
 * as gaps BETWEEN boxes ("space-between": first box flush with the near
 * edge, last box's far edge flush with the pallet's own far edge, the
 * remainder split into countL-1 (resp. countW-1) equal gaps) rather than
 * leaving it all as one lump at the far edge — hand-verified against a
 * real Cape Pack Cloud screenshot (see docs/ARCHITECTURE.md). Degenerates
 * to the original flush-at-origin placement when there's 0 or 1 box on
 * an axis — nothing to distribute "between". Doesn't change count or
 * areaEfficiency (same formula, doesn't depend on exact x/y).
 *
 * `checker` (0 or 1): a 2D checkerboard parity from each box's own (i,j)
 * grid index — real Cape Pack Cloud colors adjacent boxes differently
 * purely so individual boxes are visually distinguishable (confirmed via
 * a real screenshot: a brick-like alternating pattern, offset between
 * layers — NOT a rotation indicator, an earlier guess this corrects).
 * See main.js's renderBoxes for how this becomes actual box color.
 */
export function columnPattern(l, w, palletLength, palletWidth) {
  const countL = Math.floor(palletLength / l);
  const countW = Math.floor(palletWidth / w);
  const count = countL * countW;

  const gapL = countL > 1 ? (palletLength - countL * l) / (countL - 1) : 0;
  const gapW = countW > 1 ? (palletWidth - countW * w) / (countW - 1) : 0;

  const positions = [];
  for (let i = 0; i < countL; i++) {
    for (let j = 0; j < countW; j++) {
      positions.push({ x: i * (l + gapL), y: j * (w + gapW), l, w, rotated: false, checker: (i + j) % 2 });
    }
  }

  return {
    strategy: "column",
    l,
    w,
    countL,
    countW,
    count,
    areaEfficiency: (count * l * w) / (palletLength * palletWidth),
    positions,
  };
}
