/**
 * Classic pinwheel (windmill) pattern: 4 boxes of l×w arranged in rotational
 * symmetry, tiling a bounding square of side S = l + w with a central
 * square gap of side |l - w| (zero when l = w). Used in real pallet loading
 * when the box's L:W ratio is far enough from the pallet's that a straight
 * column pattern leaves large uncovered edges — S = l+w sometimes divides
 * the pallet dimension far more evenly than l or w alone does.
 *
 * One 4-box "pinwheel block" (for l > w, gap at top-right; degenerate/no
 * gap when l = w):
 *   Box1: x:[0,l]    y:[0,w]     (l × w)
 *   Box2: x:[l,l+w]  y:[0,l]     (w × l)
 *   Box3: x:[w,l+w]  y:[l,l+w]   (l × w)
 *   Box4: x:[0,w]    y:[w,l+w]   (w × l)
 * Verified by hand for l=2,w=1: all four pairwise-adjacent (touch, don't
 * overlap), and the uncovered region is exactly x:(1,2) y:(1,2) — a 1×1
 * square, matching (l-w)^2 = 1.
 *
 * The pattern tiles this block repeatedly across the pallet like a single
 * large "brick." Not meaningful when l = w (no orientation asymmetry to
 * exploit) — callers should skip it in that case.
 */
export function pinwheelPattern(l, w, palletLength, palletWidth) {
  if (l === w) {
    return { strategy: "pinwheel", l, w, count: 0, areaEfficiency: 0, positions: [] };
  }

  const blockSize = l + w;
  const blocksL = Math.floor(palletLength / blockSize);
  const blocksW = Math.floor(palletWidth / blockSize);
  const blocks = blocksL * blocksW;
  const count = blocks * 4;

  const positions = [];
  for (let bi = 0; bi < blocksL; bi++) {
    for (let bj = 0; bj < blocksW; bj++) {
      const ox = bi * blockSize;
      const oy = bj * blockSize;
      // checker alternates around the pinwheel block (0,1,0,1) plus the
      // block's own (bi+bj) parity, so adjacent blocks alternate too.
      const blockParity = (bi + bj) % 2;
      positions.push({ x: ox, y: oy, l, w, rotated: false, checker: blockParity }); // Box1
      positions.push({ x: ox + l, y: oy, l: w, w: l, rotated: true, checker: 1 - blockParity }); // Box2
      positions.push({ x: ox + w, y: oy + l, l, w, rotated: false, checker: blockParity }); // Box3
      positions.push({ x: ox, y: oy + w, l: w, w: l, rotated: true, checker: 1 - blockParity }); // Box4
    }
  }

  return {
    strategy: "pinwheel",
    l,
    w,
    count,
    areaEfficiency: (count * l * w) / (palletLength * palletWidth),
    positions,
  };
}
