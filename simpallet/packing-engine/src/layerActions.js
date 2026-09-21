/**
 * Report Builder "Layer Actions" (see docs section 8.1, Formatting the Load):
 * Column Stack, Alternate Layers, Flip Layers, Spread/Unspread. The 180°
 * flip and Spread are implemented — both are pure geometric transforms
 * that work on any layer pattern without needing to know its internal
 * grid, and are what "Flip Layers"/"Alternate Layers" and "Spread" reduce
 * to respectively.
 *
 * Column Stack is not yet implemented — a real user-supplied screenshot
 * shows its own icon (a highlighted vertical band running through the
 * load) but not what it actually changes; left for a later pass with
 * better evidence rather than guessed at from an icon alone.
 */
export function flipLayer180(positions, palletLength, palletWidth) {
  return positions.map((p) => ({
    x: palletLength - p.x - p.l,
    y: palletWidth - p.y - p.w,
    l: p.l,
    w: p.w,
    // A 180° flip changes x/y, not a box's own orientation relative to
    // the pattern's base, or its own checkerboard parity — both carried
    // through unchanged.
    rotated: !!p.rotated,
    checker: p.checker ?? 0,
  }));
}

// One axis of spreadLayer — factored out since Length and Width both need
// the exact same treatment, independently.
function spreadAxis(positions, axisKey, sizeKey, palletSize) {
  const starts = [...new Set(positions.map((p) => p[axisKey]))].sort((a, b) => a - b);
  // A single column/row has nowhere to put a gap — matches the real
  // screen's own Unspread state for a layer with only one box position
  // along this axis (nothing visibly changes there either).
  if (starts.length <= 1) return positions;
  const span = Math.max(...positions.map((p) => p[axisKey] + p[sizeKey])) - starts[0];
  const slack = palletSize - span;
  // Already fills (or overfills) the pallet on this axis — no slack to
  // redistribute, same as real CapePack presumably has nothing to spread
  // into once a layer already spans the full deck.
  if (slack <= 0) return positions;
  const gap = slack / (starts.length - 1);
  const rank = new Map(starts.map((v, i) => [v, i]));
  return positions.map((p) => ({ ...p, [axisKey]: p[axisKey] + rank.get(p[axisKey]) * gap }));
}

/**
 * "Spread" (docs section 8.1) — user-supplied real screenshots (Format
 * Load > Layer Actions > Spread/UnSpread, applied to one real layer):
 * before, that layer's own bounding footprint (the report's "Old Product
 * Dims") was 1068 × 918mm on a 1200 × 1000mm pallet (Maximum Load); after
 * checking that layer and applying Spread, "New Product Dims" became
 * 1200 × 1000mm — exactly the pallet's own Maximum Load Length/Width, to
 * the millimeter. Load Height and Load Weight were unchanged in both real
 * screenshots — spreading only redistributes each axis's own leftover
 * slack as gaps BETWEEN boxes already in that layer; it doesn't add,
 * remove, resize, or re-stack anything.
 *
 * The real screenshots confirm that AGGREGATE result exactly (the layer's
 * footprint grows to fill the pallet — true by construction here, for any
 * number of columns/rows, since the full slack always gets redistributed)
 * but can't show exactly where each individual box lands, only the
 * before/after bounding box. Implemented as "space-between": the
 * outermost boxes on each axis stay flush with the pallet edges (x=0 and
 * x+l=palletLength, same for y/width) and the slack is split evenly across
 * the gaps BETWEEN columns/rows only — the standard reading of "spread"
 * (matches CSS's own justify-content:space-between, e.g.), and the one
 * that keeps edge boxes exactly where Unspread already had them, but a
 * disclosed judgment call rather than something the two real screenshots
 * alone can fully distinguish from center-weighted alternatives (e.g.
 * space-around, which would also reach the same final footprint).
 *
 * Applied independently per axis — a layer can be spread in Length only,
 * Width only, or both, same as the real screen's own single Spread toggle
 * presumably drives both together, but nothing here assumes that.
 */
export function spreadLayer(positions, palletLength, palletWidth) {
  return spreadAxis(spreadAxis(positions, "x", "l", palletLength), "y", "w", palletWidth);
}
