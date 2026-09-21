import { getOrientations, boxVolume } from "./geometry.js";
import { columnPattern, guillotineSplitPattern, pinwheelPattern, hexagonalPattern } from "./patterns/index.js";

/**
 * Multi-Dimensional Analysis (docs section 6): "explores the possibility of
 * combining layers with varying vertical heights... requires more than one
 * case dimension is designated as vertical during input." This is NOT
 * general mixed-size 3D bin packing (which would need heuristics or
 * metaheuristics — see docs/PACKING_ALGORITHM.md's "deliberately out of
 * scope" section, still true). It's specifically: the same box has more
 * than one valid standing orientation, each with a different layer height;
 * find the best MIX of full layers (using different orientations) to fill
 * the pallet's height/weight budget, rather than repeating one orientation
 * uniformly for every layer.
 *
 * That reduces to a small bounded knapsack: each orientation contributes
 * one "layer type" (its best single-strategy layer pattern — height,
 * count, weight), and the search picks non-negative integer counts of each
 * type maximizing total units subject to a height budget AND a weight
 * budget. With ≤3 orientations (a box has at most 3 standing axes) this is
 * cheap to brute-force exactly — no DP or approximation needed.
 */
function bestLayerForFootprint(l, w, palletLength, palletWidth, isTrueCircle) {
  const candidates = [
    columnPattern(l, w, palletLength, palletWidth),
    guillotineSplitPattern(l, w, palletLength, palletWidth),
    pinwheelPattern(l, w, palletLength, palletWidth),
  ];
  // Same real hexagonal packing optimizePallet uses (see its own comment on
  // isTrueCircle) — without this, a cylinder's upright layer type would be
  // undercounted here relative to what optimizePallet itself finds for the
  // exact same orientation, purely because this function forgot the pattern
  // existed, not because of any real Multi-Dimensional-specific reason.
  if (isTrueCircle) candidates.push(hexagonalPattern(l, palletLength, palletWidth));
  return candidates.reduce((best, c) => (c.count > best.count ? c : best));
}

/**
 * box:    { length, width, height, weight, allowedVertical?, shape? } —
 *   needs at least 2 entries in allowedVertical to have anything to mix
 *   (matches the docs' own precondition). shape: "cylinder" (see
 *   optimizePallet's own doc comment for the exact convention) gets the
 *   same real hexagonal packing on its upright orientation, and the same
 *   true-cylinder-volume cubeEfficiency, that optimizePallet uses — the
 *   object's true volume doesn't depend on which orientation a given layer
 *   in the mix uses, so it's computed once from the box's own raw dims.
 * pallet: same shape as optimizePallet's pallet argument.
 * options: { maxTypeCombinations? } safety cap on the brute-force search
 *   (default 200 layers of any single type — generous for any real pallet).
 *
 * Returns null if fewer than 2 distinct layer heights are available (docs:
 * "Multi-Dimensional analysis is only applicable to pallet groups" with
 * more than one vertical dimension), or the best mix found: an array of
 * { vertical, strategy, h, perLayer, layers } entries (one per orientation
 * actually used) plus totals.
 */
export function multiDimensionalAnalysis(box, pallet, options = {}) {
  const maxLayersPerType = options.maxTypeCombinations ?? 200;
  const orientations = getOrientations(box, box.allowedVertical);

  // One layer type per distinct height, keeping the highest-count pattern
  // when multiple orientations share a height.
  const byHeight = new Map();
  for (const { vertical, h, l, w } of orientations) {
    // Same condition as optimizePallet's own isTrueCircle: the box's real
    // height axis must be the one standing vertical (length/width are the
    // diameter by data-entry convention) — a cylinder mixed in on its side
    // has a genuinely rectangular footprint, not a circle, even if that
    // footprint happens to be numerically square (diameter === height).
    const isTrueCircle = box.shape === "cylinder" && vertical === "height" && l === w;
    const pattern = bestLayerForFootprint(l, w, pallet.length, pallet.width, isTrueCircle);
    if (pattern.count <= 0) continue;
    const existing = byHeight.get(h);
    if (!existing || pattern.count > existing.perLayer) {
      byHeight.set(h, { vertical, h, strategy: pattern.strategy, perLayer: pattern.count });
    }
  }
  const types = [...byHeight.values()];
  if (types.length < 2) return null;

  const deckHeight = pallet.deckHeight ?? 0;
  const availableHeight = pallet.maxHeight - deckHeight;
  const maxWeight = pallet.maxWeight;
  const weightPerLayer = types.map((t) => t.perLayer * box.weight);
  // The object's true volume is the same physical number regardless of
  // which orientation a given layer in the mix used (it's the same
  // cylinder whether it's standing up or lying down) — so this is computed
  // once from the box's own raw dims, not per-type. length === width is
  // the diameter by data-entry convention (see optimizePallet's own
  // isTrueCircle comment); falls back to the plain bounding-box volume for
  // every non-cylinder box, or a malformed cylinder entry (length !==
  // width) exactly like optimizePallet does.
  const isCylinderBox = box.shape === "cylinder" && box.length === box.width;
  const perUnitVolume = isCylinderBox ? Math.PI * (box.length / 2) * (box.width / 2) * box.height : boxVolume(box);

  let best = null;
  const counts = new Array(types.length).fill(0);

  function search(idx, heightUsed, weightUsed) {
    if (idx === types.length) {
      const totalLayers = counts.reduce((s, n) => s + n, 0);
      if (totalLayers === 0) return;
      const totalCount = counts.reduce((s, n, i) => s + n * types[i].perLayer, 0);
      if (!best || totalCount > best.totalCount) {
        best = {
          layerMix: types
            .map((t, i) => ({ vertical: t.vertical, strategy: t.strategy, h: t.h, perLayer: t.perLayer, layers: counts[i] }))
            .filter((t) => t.layers > 0),
          totalLayers,
          totalCount,
          totalWeight: weightUsed,
          loadHeight: deckHeight + heightUsed,
          // Same fix as optimizePallet's own cubeEfficiency (see its
          // comment) — the pallet's fixed available cube, not this
          // particular layer mix's own achieved height. perUnitVolume
          // (see above) additionally swaps in the true cylinder volume
          // instead of the bounding-box volume when applicable.
          cubeEfficiency: (totalCount * perUnitVolume) / (pallet.length * pallet.width * availableHeight),
        };
      }
      return;
    }
    const maxN = Math.min(maxLayersPerType, Math.floor((availableHeight - heightUsed) / types[idx].h));
    for (let n = 0; n <= maxN; n++) {
      const newWeight = weightUsed + n * weightPerLayer[idx];
      if (newWeight > maxWeight) break;
      counts[idx] = n;
      search(idx + 1, heightUsed + n * types[idx].h, newWeight);
    }
    counts[idx] = 0;
  }
  search(0, 0, 0);

  return best;
}
