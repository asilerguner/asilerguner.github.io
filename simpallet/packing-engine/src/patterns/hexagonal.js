/**
 * Hexagonal (staggered-row) circle packing — the real technique CapePack's
 * own docs refer to when they say cylinders get "dedicated circle-packing
 * patterns" on a pallet (the user guide names the pattern list — Column,
 * Interlock, Trilock, Spiral, Diagonal, Expanded Spiral — but doesn't
 * publish the underlying geometry, so this is the standard, well-known
 * circle-packing construction, not a guess at CapePack's own internal
 * code: alternating rows of circles, each row spaced only
 * D*sin(60 degrees) (~0.866*D) from the next instead of a full diameter
 * apart, with every other row shifted by half a diameter so each circle
 * nests into the gap left by its two neighbors in the row above. That
 * spacing is the tightest possible for two rows of circles that don't
 * overlap (Pythagorean: for a horizontal offset of D/2, the row spacing
 * D*sin(60) is the minimum that keeps center-to-center distance at
 * exactly D — any other offset needs MORE row spacing to stay valid, so
 * D/2 is the provably tightest choice, not an arbitrary one).
 *
 * Only meaningful for TRUE circles (diameter === diameter, i.e. l === w
 * for this orientation) — ovals and other non-circular round shapes stay
 * on the existing bounding-box approximation, since ellipse packing is a
 * genuinely different, harder problem this doesn't attempt.
 *
 * Positions are returned in the SAME {x, y, l, w} bounding-square format
 * every other pattern uses (x/y = the square's own corner, l = w =
 * diameter) — required for zero changes to buildBoxLayout or the 3D
 * renderer, both of which already draw a cylinder as a round mesh
 * inscribed in whatever footprint box it's given. Adjacent circles'
 * bounding squares DO legitimately overlap in a valid hexagonal packing
 * (that's exactly what makes the tighter row spacing possible) even
 * though the actual circles never do — real overlap is checked by
 * center-to-center distance in this file's own tests, not by rectangle
 * overlap like every other pattern's tests use.
 *
 * areaEfficiency here uses each circle's own true area (pi * r^2), not
 * its D*D bounding square — the square-based convention every other
 * pattern uses is fine for boxes (a box genuinely occupies its whole
 * bounding rectangle) but becomes mathematically incoherent once
 * circles' bounding squares can overlap: count*D*D can exceed the
 * pallet's own area even though the circles themselves fit and don't
 * overlap. True circle area is a principled fix (guaranteed <= 100%,
 * always comparable) rather than a verified match to CapePack's own
 * exact number — this session has no reference screenshot with real
 * cylinder efficiency values to check it against, unlike the Cube
 * Efficiency denominator fix, which was checked against real pasted
 * output. optimizePallet applies this same true-circle-area convention
 * to every OTHER pattern's reported efficiency too when packing a true
 * circle, so the numbers stay comparable across strategies.
 */
function rowsAlongWidth(diameter, palletLength, palletWidth) {
  if (diameter <= 0 || palletLength < diameter || palletWidth < diameter) {
    return { count: 0, positions: [] };
  }

  const rowSpacing = diameter * (Math.sqrt(3) / 2);
  const numRows = Math.floor((palletWidth - diameter) / rowSpacing) + 1;

  const positions = [];
  for (let r = 0; r < numRows; r++) {
    const cy = diameter / 2 + r * rowSpacing;
    const shifted = r % 2 === 1;
    // Tightest valid start for this row's phase — D/2 for the unshifted
    // phase (the provably optimal start for equally-spaced circles in a
    // bounded interval), D for the shifted phase (that same start plus
    // the half-diameter nesting offset).
    const firstCx = shifted ? diameter : diameter / 2;
    const maxCx = palletLength - diameter / 2;
    if (firstCx > maxCx + 1e-9) continue;
    const countInRow = Math.floor((maxCx - firstCx) / diameter + 1e-9) + 1;
    for (let k = 0; k < countInRow; k++) {
      const cx = firstCx + k * diameter;
      positions.push({ x: cx - diameter / 2, y: cy - diameter / 2, l: diameter, w: diameter });
    }
  }
  return { count: positions.length, positions };
}

export function hexagonalPattern(diameter, palletLength, palletWidth) {
  const byWidth = rowsAlongWidth(diameter, palletLength, palletWidth);
  // Rows along the length axis instead — same search, transposed, then
  // swap x<->y back on every position to return real pallet coordinates.
  // (l === w === diameter throughout, so no l/w swap is needed alongside
  // the x/y swap, unlike interlockPattern's rectangular version.)
  const transposed = rowsAlongWidth(diameter, palletWidth, palletLength);
  const byLength = {
    count: transposed.count,
    positions: transposed.positions.map((p) => ({ x: p.y, y: p.x, l: p.l, w: p.w })),
  };

  const best = byWidth.count >= byLength.count ? byWidth : byLength;
  const circleArea = Math.PI * (diameter / 2) ** 2;

  return {
    strategy: "hexagonal",
    l: diameter,
    w: diameter,
    count: best.count,
    areaEfficiency: (best.count * circleArea) / (palletLength * palletWidth),
    positions: best.positions,
  };
}
