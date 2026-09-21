import { getOrientations, boxVolume } from "./geometry.js";
import {
  columnPattern,
  guillotineSplitPattern,
  pinwheelPattern,
  interlockPattern,
  hexagonalPattern,
  trilockPattern,
  spiralPattern,
  diagonalPattern,
  expandedSpiralPattern,
} from "./patterns/index.js";
import { flipLayer180 } from "./layerActions.js";

/**
 * Two-level palletization search (see docs/PACKING_ALGORITHM.md):
 *   Level 1 — 2D layer pattern (column grid, guillotine split) per orientation
 *   Level 2 — 1D layer stacking under height/weight limits
 *
 * box:    { length, width, height, weight, allowedVertical?, shape? }
 *   shape?: "cylinder" — opts into real circle packing (see
 *     patterns/hexagonal.js) for the orientation where the box's own
 *     height axis is vertical AND length === width (i.e. standing upright
 *     on its actual circular face — length/width are the diameter by
 *     data-entry convention, height the real height); every other
 *     orientation — including the box lying on its side, even if its
 *     diameter happens to numerically equal its height — and every box
 *     with no shape set, keeps using the existing rectangular patterns
 *     exactly as before, since a cylinder on its side has a genuinely
 *     rectangular footprint, not a circular one. Also switches area/cube
 *     efficiency reporting (for every candidate pattern, not just
 *     hexagonal) to the circle's own true area/volume instead of its
 *     D*D bounding square — see hexagonal.js's own comment for why
 *     that's a correctness fix, not a style choice, once hexagonal
 *     packing exists at all.
 * pallet: { length, width, maxHeight, maxWeight, deckHeight? }
 * options: {
 *   objective?: 'totalCount' | 'cubeEfficiency' | 'areaEfficiency',
 *   topN?: number,
 *   allowPartialTopLayer?: boolean — CapePack Load Details > More Settings:
 *     when the weight limit stops a full top layer, add one partial layer
 *     (fewer boxes) sized to whatever weight budget remains.
 *   minLoadLength?, minLoadWidth?: number — CapePack "Minimum Load
 *     Dimensions": only keep solutions whose occupied footprint (not the
 *     full pallet) reaches at least this size on each axis.
 *   minAreaEfficiency?: number (0-1) — CapePack "Minimum Area Efficiency".
 *   loadTarget?: number — CapePack "Load Target": only keep solutions whose
 *     totalCount exactly equals this quantity. Since a single pattern only
 *     naturally yields totalCount at its own max layer count, a loadTarget
 *     search also sweeps every smaller layer count (1..max) for that
 *     pattern — all genuinely valid, just not layer-maximal — so an exact
 *     match has a real chance of being found instead of only ever checking
 *     one totalCount per pattern.
 * }
 */
export function optimizePallet(box, pallet, options = {}) {
  const objective = options.objective ?? "totalCount";
  const topN = options.topN ?? 5;
  const deckHeight = pallet.deckHeight ?? 0;
  const allowPartialTopLayer = options.allowPartialTopLayer ?? false;
  const minLoadLength = options.minLoadLength ?? 0;
  const minLoadWidth = options.minLoadWidth ?? 0;
  const minAreaEfficiency = options.minAreaEfficiency ?? 0;
  const loadTarget = options.loadTarget ?? null;

  const orientations = getOrientations(box, box.allowedVertical);
  const solutions = [];
  // Cube efficiency's denominator is the pallet's own FIXED available cube
  // (full footprint × max usable height) — the same for every solution on
  // this pallet — not each solution's own achieved stack height. A
  // weight-limited solution (fewer layers than the height budget allows)
  // must not look "more cube-efficient" just because its own bounding box
  // is shorter; that was a real bug, caught by cross-checking against real
  // Cape Pack Cloud output (user-supplied: a 40-row solution list whose
  // Cube Efficiency values only matched pallet.length*pallet.width*
  // maxUsableHeight as the denominator, not each row's own load height —
  // confirmed exactly across 3 independent rows by hand).
  const maxUsableHeight = pallet.maxHeight - deckHeight;

  const passesFilters = (pattern, totalCount) => {
    if (loadTarget != null && totalCount !== loadTarget) return false;
    if (pattern.areaEfficiency < minAreaEfficiency) return false;
    if (minLoadLength > 0 || minLoadWidth > 0) {
      const loadLength = Math.max(...pattern.positions.map((p) => p.x + p.l));
      const loadWidth = Math.max(...pattern.positions.map((p) => p.y + p.w));
      if (loadLength < minLoadLength || loadWidth < minLoadWidth) return false;
    }
    return true;
  };

  for (const { vertical, h, l, w } of orientations) {
    // A true circle for this orientation — box.length/box.width are the
    // diameter by data-entry convention (a Cylinder shape's Length and
    // Width are both set to the diameter, Height to the actual height), so
    // the footprint is only genuinely circular when the box's own height
    // axis is the one standing vertical. vertical === "height" alone isn't
    // enough to require on its own (a malformed cylinder box could still
    // have length !== width), so l === w is kept as a defensive check too
    // — but vertical === "height" is required on top of it: without that,
    // a cylinder allowed to lie on its side (allowedVertical includes
    // "length"/"width") whose diameter happens to numerically equal its
    // height would ALSO satisfy l === w on that sideways orientation, even
    // though a cylinder lying on its side has a genuinely rectangular
    // footprint (its round profile faces sideways, not up) — not a circle
    // just because the bounding footprint happens to be square. Ovals and
    // other round-but-not-circular shapes never satisfy l === w regardless
    // of vertical, so they correctly keep using the rectangular patterns/
    // bounding-box efficiency exactly as before — only a genuine circle,
    // standing on its actual circular face, gets hexagonal packing and
    // true-area reporting.
    const isTrueCircle = box.shape === "cylinder" && vertical === "height" && l === w;
    const candidates = [
      columnPattern(l, w, pallet.length, pallet.width),
      guillotineSplitPattern(l, w, pallet.length, pallet.width),
      pinwheelPattern(l, w, pallet.length, pallet.width),
      interlockPattern(l, w, pallet.length, pallet.width),
      // Real CapePack pattern names (docs: Column/Interlock = "Simple",
      // Trilock/Diagonal = "Medium", Spiral/Expanded Spiral = "Complex")
      // — Esko's own exact geometry for these 4 isn't publicly documented
      // (checked 3 real Esko manuals), so these are real, valid, disclosed
      // good-faith implementations in the spirit of the one real diagram
      // available, not verified reproductions of Esko's proprietary
      // algorithm — see each pattern file's own doc comment for exactly
      // what was checked and how each compares to the one real numeric
      // example available (user-supplied, 400x300 case on 1200x1000
      // pallet).
      trilockPattern(l, w, pallet.length, pallet.width),
      spiralPattern(l, w, pallet.length, pallet.width),
      diagonalPattern(l, w, pallet.length, pallet.width),
      expandedSpiralPattern(l, w, pallet.length, pallet.width),
    ];
    if (isTrueCircle) candidates.push(hexagonalPattern(l, pallet.length, pallet.width));

    for (const pattern of candidates) {
      if (pattern.count <= 0) continue;

      // True circle area/volume instead of the D*D bounding square every
      // pattern above computes internally — see hexagonal.js's own
      // comment for why that switch is a correctness fix (bounding
      // squares legitimately overlap in a real hexagonal packing, so
      // count*D*D can exceed the pallet's own area even though the
      // circles themselves fit and don't overlap) rather than a style
      // choice. Applied to every candidate pattern here, not just
      // hexagonal, so a circle's reported efficiency means the same thing
      // regardless of which pattern happened to win.
      const areaEfficiency = isTrueCircle
        ? (pattern.count * Math.PI * (l / 2) ** 2) / (pallet.length * pallet.width)
        : pattern.areaEfficiency;
      const perUnitVolume = isTrueCircle ? Math.PI * (l / 2) ** 2 * h : boxVolume(box);

      const layersByHeight = Math.floor((pallet.maxHeight - deckHeight) / h);
      const layersByWeight = Math.floor(pallet.maxWeight / (box.weight * pattern.count));
      const fullLayers = Math.min(layersByHeight, layersByWeight);

      const layerCountsToTry =
        loadTarget != null && fullLayers > 0
          ? Array.from({ length: fullLayers }, (_, i) => i + 1)
          : [fullLayers];

      for (const layers of layerCountsToTry) {
        if (layers <= 0) continue;
        const totalCount = pattern.count * layers;
        if (!passesFilters(pattern, totalCount)) continue;

        const loadHeight = deckHeight + layers * h;
        solutions.push({
          vertical,
          strategy: pattern.strategy,
          boxFootprint: { l, w, h },
          perLayer: pattern.count,
          layers,
          partialTopLayerCount: 0,
          totalCount,
          totalWeight: totalCount * box.weight,
          loadHeight,
          areaEfficiency,
          cubeEfficiency: (totalCount * perUnitVolume) / (pallet.length * pallet.width * maxUsableHeight),
          layerPositions: pattern.positions,
        });
      }

      // Allow Partial Top Layer: only meaningful on top of the maximum
      // achievable full-layer count, and only when weight (not height) is
      // what's stopping one more full layer.
      if (allowPartialTopLayer && fullLayers >= 0 && fullLayers < layersByHeight) {
        const usedWeight = fullLayers * pattern.count * box.weight;
        const remainingWeight = pallet.maxWeight - usedWeight;
        const partialCount = Math.min(pattern.count, Math.floor(remainingWeight / box.weight));
        if (partialCount > 0) {
          const totalCount = pattern.count * fullLayers + partialCount;
          if (passesFilters(pattern, totalCount)) {
            const loadHeight = deckHeight + (fullLayers + 1) * h;
            solutions.push({
              vertical,
              strategy: pattern.strategy,
              boxFootprint: { l, w, h },
              perLayer: pattern.count,
              layers: fullLayers,
              partialTopLayerCount: partialCount,
              totalCount,
              totalWeight: totalCount * box.weight,
              loadHeight,
              areaEfficiency,
              cubeEfficiency: (totalCount * perUnitVolume) / (pallet.length * pallet.width * maxUsableHeight),
              layerPositions: pattern.positions,
            });
          }
        }
      }
    }
  }

  solutions.sort((a, b) => b[objective] - a[objective]);

  // Collapse TRUE duplicates only — same vertical axis, same box
  // footprint, same strategy, same counts, i.e. actually the identical
  // physical solution found twice (e.g. a square footprint reached via
  // two different orientation labels). Deliberately does NOT collapse
  // same-strategy ties that differ in vertical or footprint even when
  // their summary stats (perLayer/layers/efficiency) happen to match —
  // real, user-supplied Cape Pack Cloud output shows exactly that: several
  // rows sharing one pattern name and identical stats but real, separately
  // numbered solutions (e.g. three "Trilock" rows tied at 63/9/7 in one
  // real 40-row export). The old key here (perLayer/layers/partial/
  // strategy only, no vertical or footprint) collapsed those cases too
  // aggressively — real distinct arrangements were being thrown away, not
  // just true duplicates.
  const seen = new Set();
  const deduped = [];
  for (const s of solutions) {
    const key = `${s.vertical}|${s.boxFootprint.l}|${s.boxFootprint.w}|${s.perLayer}|${s.layers}|${s.partialTopLayerCount}|${s.strategy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  return deduped.slice(0, topN);
}

/**
 * Expand a solution's single-layer positions into explicit 3D boxes
 * (one per physical box, with a world-space x/y/z origin) for rendering.
 * Pallet-space axes: x = length, y = width, z = stack height.
 *
 * pallet: { length, width, deckHeight? } — length/width only needed when
 * options.alternateLayers is set (the 180° flip needs the footprint to
 * mirror against).
 * options: { alternateLayers?: boolean } — flips every other layer 180°
 * for seam-breaking stability (Report Builder's Alternate Layers action).
 */
export function buildBoxLayout(solution, pallet, options = {}) {
  const deckHeight = pallet.deckHeight ?? 0;
  const alternateLayers = options.alternateLayers ?? false;
  const flipped = alternateLayers
    ? flipLayer180(solution.layerPositions, pallet.length, pallet.width)
    : null;

  const boxes = [];
  for (let k = 0; k < solution.layers; k++) {
    const z = deckHeight + k * solution.boxFootprint.h;
    const positions = alternateLayers && k % 2 === 1 ? flipped : solution.layerPositions;
    for (const pos of positions) {
      // !!pos.rotated defaults hexagonal's untagged positions (circles
      // have no rotation concept) to false. checker combines each box's
      // own 2D grid parity with the layer index k, so the alternating
      // color pattern shifts between layers — matching a real Cape Pack
      // Cloud screenshot's own brick-like offset look (see column.js's
      // own comment and docs/ARCHITECTURE.md).
      boxes.push({
        x: pos.x, y: pos.y, z, l: pos.l, w: pos.w, h: solution.boxFootprint.h,
        rotated: !!pos.rotated,
        checker: ((pos.checker ?? 0) + k) % 2,
      });
    }
  }

  // Allow Partial Top Layer: place only the first partialTopLayerCount
  // positions from the pattern on top of the full layers.
  if (solution.partialTopLayerCount > 0) {
    const z = deckHeight + solution.layers * solution.boxFootprint.h;
    const k = solution.layers;
    const positions = alternateLayers && k % 2 === 1 ? flipped : solution.layerPositions;
    for (const pos of positions.slice(0, solution.partialTopLayerCount)) {
      boxes.push({
        x: pos.x, y: pos.y, z, l: pos.l, w: pos.w, h: solution.boxFootprint.h,
        rotated: !!pos.rotated,
        checker: ((pos.checker ?? 0) + k) % 2,
      });
    }
  }

  return boxes;
}
