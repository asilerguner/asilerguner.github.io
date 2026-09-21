/**
 * Interlock (split) pattern: divide the pallet into two zones along one
 * axis, filling one zone with the box's given orientation (l, w) and the
 * other with it rotated 90 degrees (w, l).
 *
 * This is NOT the same technique as guillotineSplitPattern, even though
 * both produce two zones. guillotineSplitPattern is greedy — it always
 * maximizes the primary grid first, then fills only whatever true
 * leftover scrap remains with rotated boxes. That misses cases where
 * deliberately using FEWER rows in zone 1 frees up enough width in zone 2
 * for a full rotated row a "leftover scraps" approach would never
 * uncover. This pattern instead tries every possible split point (every
 * row count for zone 1, from 0 up to the maximum), keeping whichever
 * total is highest — a real technique real palletizing software uses,
 * not a guess: reverse-engineered from a real Cape Pack Cloud solution a
 * user supplied (400x300 case on a 1200x1000 pallet: this pattern finds
 * the same 10-per-layer, 100% area result Cape Pack's own "Interlock"
 * pattern reports, where column/guillotine-split/pinwheel all top out at
 * 9 — see docs/ARCHITECTURE.md for the full verification).
 *
 * Tries splitting along both the length and width axes, keeping whichever
 * of the two (and whichever split point along it) wins overall — the
 * "which zone gets which orientation" choice doesn't need to be tried
 * separately, since sweeping zone 1's row/column count from 0 to its
 * maximum already covers that same range from the other direction too.
 */
function splitAlongWidth(l, w, palletLength, palletWidth) {
  const rotL = w;
  const rotW = l;
  const countAcrossZone1 = Math.floor(palletLength / l);
  const countAcrossZone2 = Math.floor(palletLength / rotL);
  const maxRows = Math.floor(palletWidth / w);

  let best = null;
  for (let rows1 = 0; rows1 <= maxRows; rows1++) {
    const usedWidth = rows1 * w;
    const rows2 = Math.floor((palletWidth - usedWidth) / rotW);
    const count = countAcrossZone1 * rows1 + countAcrossZone2 * rows2;
    if (!best || count > best.count) {
      best = { rows1, rows2, usedWidth, count };
    }
  }
  if (!best || best.count <= 0) return null;

  const positions = [];
  for (let i = 0; i < countAcrossZone1; i++) {
    for (let j = 0; j < best.rows1; j++) {
      positions.push({ x: i * l, y: j * w, l, w, rotated: false, checker: (i + j) % 2 });
    }
  }
  for (let i = 0; i < countAcrossZone2; i++) {
    for (let j = 0; j < best.rows2; j++) {
      positions.push({ x: i * rotL, y: best.usedWidth + j * rotW, l: rotL, w: rotW, rotated: true, checker: (i + j) % 2 });
    }
  }
  return { count: best.count, positions };
}

export function interlockPattern(l, w, palletLength, palletWidth) {
  if (l === w) {
    // No orientation asymmetry to exploit — identical to columnPattern.
    return { strategy: "interlock", l, w, count: 0, areaEfficiency: 0, positions: [] };
  }

  const bySplitWidth = splitAlongWidth(l, w, palletLength, palletWidth);
  // Split-by-length is the same search with length/width swapped — build
  // it in that swapped frame, then swap x<->y and l<->w back on every
  // position to return it in real pallet coordinates. `rotated` is each
  // zone's own LOCAL tag (did it use the passed-in l/w or the swapped
  // w/l, same as bySplitWidth's own zones) and is propagated UNCHANGED
  // through this remap — verified by hand (twice, independently, with
  // different concrete l/w values) that after the l<->w swap below, a
  // zone tagged rotated:false here really does end up with the footprint
  // matching the TRUE outer (l,w), and rotated:true really does end up
  // swapped relative to it. Inverting this flag would be wrong.
  const swapped = splitAlongWidth(w, l, palletWidth, palletLength);
  const bySplitLength = swapped && {
    count: swapped.count,
    // checker is (i+j) parity, symmetric under the x<->y swap — copied
    // through unchanged needs no separate frame analysis like rotated.
    positions: swapped.positions.map((p) => ({ x: p.y, y: p.x, l: p.w, w: p.l, rotated: p.rotated, checker: p.checker })),
  };

  const best = [bySplitWidth, bySplitLength]
    .filter(Boolean)
    .reduce((a, b) => (b.count > (a?.count ?? -1) ? b : a), null);
  if (!best) return { strategy: "interlock", l, w, count: 0, areaEfficiency: 0, positions: [] };

  return {
    strategy: "interlock",
    l,
    w,
    count: best.count,
    areaEfficiency: (best.count * l * w) / (palletLength * palletWidth),
    positions: best.positions,
  };
}
