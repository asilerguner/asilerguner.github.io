/**
 * Diagonal pattern: recursively fill each leftover rectangle with the
 * better-fitting orientation's own grid, cascading into smaller and
 * smaller leftover strips — a multi-level generalization of
 * guillotineSplitPattern's own single-level leftover recovery (that file:
 * fill the primary grid, recover ONE leftover strip; this one: recover
 * the leftover strip, then recover ITS OWN leftover strip, and so on)
 * until nothing more fits. Matches the real "Diagonal" pattern-style
 * diagram (Esko Cape Pack Quick Start Guide, "Select Pallet Pattern
 * Styles Screen") — visibly a genuine staircase/cascading arrangement of
 * differently-sized blocks, not a single split.
 *
 * Esko's own real, proprietary Diagonal geometry isn't publicly
 * documented (checked the Cloud user guide, the Quick Start Guide, and
 * the 610-page Retail User Guide — none give the actual algorithm), so
 * this is a good-faith, real, valid, genuinely-cascading technique in
 * that same spirit rather than a verified reproduction of Esko's exact
 * internal geometry — disclosed rather than presented as certain.
 * Cross-checked against the one real example available (user-supplied,
 * 400x300 case on 1200x1000 pallet): this recursion's own result there is
 * 9 — matching one of the real Diagonal rows in that export exactly (not
 * all of them: real Diagonal also appears there at 6 and 4, tiers this
 * recursion doesn't independently reach for the same box/pallet) — a
 * real, disclosed partial match, not silently hidden. See
 * diagonal.test.js.
 */
// Exported (not just used internally by diagonalPattern below) so
// expandedSpiralPattern can reuse this exact same recursive cascade to
// fill pinwheelPattern's own leftover margins more thoroughly than
// spiralPattern's single-level columnPattern fill does — see that file's
// own doc comment.
export function packRect(l, w, rectLength, rectWidth, offsetX, offsetY, positions) {
  const minSide = Math.min(l, w);
  if (rectLength < minSide || rectWidth < minSide) return; // too small for either orientation

  const countAcrossA = Math.floor(rectLength / l);
  const countDownA = Math.floor(rectWidth / w);
  const countA = countAcrossA * countDownA;

  const countAcrossB = Math.floor(rectLength / w);
  const countDownB = Math.floor(rectWidth / l);
  const countB = countAcrossB * countDownB;

  if (countA === 0 && countB === 0) return;

  const useA = countA >= countB;
  const boxL = useA ? l : w;
  const boxW = useA ? w : l;
  const countAcross = useA ? countAcrossA : countAcrossB;
  const countDown = useA ? countDownA : countDownB;

  for (let i = 0; i < countAcross; i++) {
    for (let j = 0; j < countDown; j++) {
      positions.push({ x: offsetX + i * boxL, y: offsetY + j * boxW, l: boxL, w: boxW, rotated: !useA, checker: (i + j) % 2 });
    }
  }

  const usedLength = countAcross * boxL;
  const usedWidth = countDown * boxW;
  const leftoverLength = rectLength - usedLength;
  const leftoverWidth = rectWidth - usedWidth;

  // Recurse into the right leftover strip (full rect height) and the top
  // leftover strip (only the already-used length, so the two never
  // overlap in the shared corner) — same non-overlapping-strips shape as
  // spiralPattern's own margin fill, just applied recursively instead of
  // once.
  if (leftoverLength > 0) packRect(l, w, leftoverLength, rectWidth, offsetX + usedLength, offsetY, positions);
  if (leftoverWidth > 0 && usedLength > 0) packRect(l, w, usedLength, leftoverWidth, offsetX, offsetY + usedWidth, positions);
}

export function diagonalPattern(l, w, palletLength, palletWidth) {
  const positions = [];
  packRect(l, w, palletLength, palletWidth, 0, 0, positions);
  const count = positions.length;
  return {
    strategy: "diagonal",
    l,
    w,
    count,
    areaEfficiency: (count * l * w) / (palletLength * palletWidth),
    positions,
  };
}
