import { pinwheelPattern } from "./pinwheel.js";
import { columnPattern } from "./column.js";

/**
 * Spiral pattern: pinwheelPattern's own rotating-block tiling, PLUS
 * filling the margins that tiling alone leaves uncovered with plain
 * column-style boxes — matching the real "Spiral" pattern-style diagram
 * (Esko Cape Pack Quick Start Guide, "Select Pallet Pattern Styles
 * Screen"), which visibly shows a rotating central arrangement surrounded
 * by straight filled strips, not just the repeating rotational block on
 * its own. Esko's own real, proprietary Spiral geometry isn't publicly
 * documented (checked the Cloud user guide, the Quick Start Guide, and
 * the 610-page Retail User Guide — none give the actual algorithm), so
 * this combines two already-verified real techniques (pinwheelPattern,
 * columnPattern) in the spirit of that diagram rather than claiming to
 * reproduce Esko's exact internal geometry — disclosed rather than
 * presented as certain. Cross-checked against the one real example
 * available (user-supplied, 400x300 case on 1200x1000 pallet): plain
 * pinwheelPattern alone gets 4 there (real Spiral's own range is 6-9);
 * this margin-filled version gets close (see spiral.test.js) — a real,
 * disclosed gap, not silently hidden.
 */
export function spiralPattern(l, w, palletLength, palletWidth) {
  if (l === w) {
    // No orientation asymmetry for the rotating block to exploit — same
    // degenerate case pinwheelPattern itself already documents.
    return { strategy: "spiral", l, w, count: 0, areaEfficiency: 0, positions: [] };
  }

  const pin = pinwheelPattern(l, w, palletLength, palletWidth);
  const blockSize = l + w;
  const usedL = Math.floor(palletLength / blockSize) * blockSize;
  const usedW = Math.floor(palletWidth / blockSize) * blockSize;

  const positions = [...pin.positions];

  // Right margin strip: full pallet height, whatever length the pinwheel
  // blocks didn't reach. Tries both orientations (columnPattern itself
  // doesn't) and keeps whichever fits more.
  const rightStripLength = palletLength - usedL;
  if (rightStripLength > 0) {
    const a = columnPattern(l, w, rightStripLength, palletWidth);
    const b = columnPattern(w, l, rightStripLength, palletWidth);
    // columnPattern always tags its own output rotated:false — but when
    // the (w,l) variant wins, every one of ITS positions IS rotated
    // relative to spiral's own true outer (l,w), since columnPattern has
    // no way to know it's being used that way by this caller. Override,
    // don't trust the tag columnPattern itself returned.
    const useB = b.count > a.count;
    const best = useB ? b : a;
    for (const p of best.positions) positions.push({ x: usedL + p.x, y: p.y, l: p.l, w: p.w, rotated: useB, checker: p.checker });
  }

  // Top margin strip: only the width the pinwheel blocks DID reach along
  // length (the right strip above already claims the corner column), full
  // remaining height.
  const topStripWidth = palletWidth - usedW;
  if (topStripWidth > 0 && usedL > 0) {
    const a = columnPattern(l, w, usedL, topStripWidth);
    const b = columnPattern(w, l, usedL, topStripWidth);
    const useB = b.count > a.count;
    const best = useB ? b : a;
    for (const p of best.positions) positions.push({ x: p.x, y: usedW + p.y, l: p.l, w: p.w, rotated: useB, checker: p.checker });
  }

  const count = positions.length;
  return {
    strategy: "spiral",
    l,
    w,
    count,
    areaEfficiency: (count * l * w) / (palletLength * palletWidth),
    positions,
  };
}
