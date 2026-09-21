import { pinwheelPattern } from "./pinwheel.js";
import { packRect } from "./diagonal.js";

/**
 * Expanded Spiral pattern: spiralPattern's own pinwheel-block-plus-margins
 * idea, but filling the margins with diagonalPattern's own recursive
 * cascade (see that file) instead of a single flat columnPattern grid —
 * recovers more of the leftover space than spiralPattern's own single-
 * level fill, matching the real "Expanded Spiral" pattern-style diagram
 * (Esko Cape Pack Quick Start Guide, "Select Pallet Pattern Styles
 * Screen"), which visibly shows more/finer subdivided cells than plain
 * Spiral's own diagram — a real, plausible "more thorough" relationship
 * between the two, not an arbitrary difference.
 *
 * Esko's own real, proprietary Expanded Spiral geometry isn't publicly
 * documented (checked the Cloud user guide, the Quick Start Guide, and
 * the 610-page Retail User Guide — none give the actual algorithm), so
 * this combines already-verified real techniques (pinwheelPattern,
 * diagonalPattern's own recursion) in the spirit of that diagram rather
 * than claiming to reproduce Esko's exact internal geometry — disclosed
 * rather than presented as certain. Cross-checked against the one real
 * example available (user-supplied, 400x300 case on 1200x1000 pallet):
 * real Expanded Spiral shows 8 there (tied with several real Spiral
 * rows at the same tier) — see expandedSpiral.test.js for this
 * implementation's own result on that scenario.
 */
export function expandedSpiralPattern(l, w, palletLength, palletWidth) {
  if (l === w) {
    return { strategy: "expanded-spiral", l, w, count: 0, areaEfficiency: 0, positions: [] };
  }

  const pin = pinwheelPattern(l, w, palletLength, palletWidth);
  const blockSize = l + w;
  const usedL = Math.floor(palletLength / blockSize) * blockSize;
  const usedW = Math.floor(palletWidth / blockSize) * blockSize;

  const positions = [...pin.positions];

  const rightStripLength = palletLength - usedL;
  if (rightStripLength > 0) {
    packRect(l, w, rightStripLength, palletWidth, usedL, 0, positions);
  }
  const topStripWidth = palletWidth - usedW;
  if (topStripWidth > 0 && usedL > 0) {
    packRect(l, w, usedL, topStripWidth, 0, usedW, positions);
  }

  const count = positions.length;
  return {
    strategy: "expanded-spiral",
    l,
    w,
    count,
    areaEfficiency: (count * l * w) / (palletLength * palletWidth),
    positions,
  };
}
