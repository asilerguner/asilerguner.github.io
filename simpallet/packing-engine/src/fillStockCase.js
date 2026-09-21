import { getOrientations, boxVolume } from "./geometry.js";
import { optimizePallet } from "./optimize.js";

/**
 * "Fill a Stock Case" workflow: unlike Create a Case (which designs a new
 * case size around the primary pack), here the case size is FIXED — it
 * comes from an existing Stock Cases database entry — and the search is
 * over which orientation of the primary pack fits the most units inside
 * that fixed case, subject to fill-efficiency and weight constraints. The
 * resulting case is then palletized via the same Level 1/2 search as every
 * other workflow (see docs/PACKING_ALGORITHM.md).
 *
 * Not implemented (honestly, not guessed at): CapePack's Pattern Types
 * (Simple/Medium/Complex), Multi-Dimensional Solutions, and Maximizer
 * Solutions options for this workflow — this only finds the single best
 * axis-aligned grid orientation of the primary pack per stock case.
 *
 * primary:   { length, width, height, weight, allowedVertical? }
 * stockCase: { length, width, height (OUTSIDE dimensions — same convention
 *   as the ArtiosCAD-style import, see docs/ARCHITECTURE.md), weight?
 *   (tare), maxWeight?, wallThickness?, insideLength?, insideWidth?,
 *   insideHeight?, allowedVertical? (which OUTSIDE axis may stand up when
 *   this case is palletized — undefined preserves the pre-existing
 *   unrestricted, all-3-axes default getOrientations already has) } —
 *   mirrors optimizeCase's own Inside/Outside Dimensions
 *   model (docs "Adding Secondary Pack Details"): by default wallThickness
 *   (board caliper, defaults to 0) is subtracted ×2 per axis to get the
 *   INSIDE dimensions the primary pack actually fits into, while the
 *   stored length/width/height (outside) is what gets palletized. Real
 *   CapePack's own Cases and Trays database (user-supplied screenshot)
 *   stores ID and OD independently — a case's own real per-axis "Number
 *   of Thicknesses" isn't always a uniform x2 (e.g. a height crossing
 *   top+bottom flaps might use x4) — so insideLength/insideWidth/
 *   insideHeight, when given, are used directly instead of derived from
 *   wallThickness x2, without disturbing any existing caller that doesn't
 *   pass them.
 * pallet:    same shape as optimizePallet's pallet argument
 * options:   { minFillEfficiency?: 0-1, topN?, loadOptions? }
 * loadOptions passes through to optimizePallet's own Load Details options
 * (allowPartialTopLayer, minLoadLength/Width, minAreaEfficiency, loadTarget).
 */
export function fillStockCase(primary, stockCase, pallet, options = {}) {
  const minFillEfficiency = options.minFillEfficiency ?? 0;
  const topN = options.topN ?? 5;
  const tareWeight = stockCase.weight ?? 0;
  const wallThickness = stockCase.wallThickness ?? 0;
  const insideLength = stockCase.insideLength ?? stockCase.length - 2 * wallThickness;
  const insideWidth = stockCase.insideWidth ?? stockCase.width - 2 * wallThickness;
  const insideHeight = stockCase.insideHeight ?? stockCase.height - 2 * wallThickness;
  const caseVolume = insideLength * insideWidth * insideHeight;

  const orientations = getOrientations(primary, primary.allowedVertical);
  const results = [];

  for (const { vertical, h, l, w } of orientations) {
    const nx = Math.floor(insideLength / l);
    const ny = Math.floor(insideWidth / w);
    const nz = Math.floor(insideHeight / h);
    const primaryPerCase = nx * ny * nz;
    if (primaryPerCase <= 0) continue;

    const fillEfficiency = (primaryPerCase * boxVolume(primary)) / caseVolume;
    if (fillEfficiency < minFillEfficiency) continue;

    const caseWeight = tareWeight + primaryPerCase * primary.weight;
    if (stockCase.maxWeight !== undefined && caseWeight > stockCase.maxWeight) continue;

    const caseForPallet = {
      length: stockCase.length,
      width: stockCase.width,
      height: stockCase.height,
      weight: caseWeight,
      allowedVertical: stockCase.allowedVertical,
    };
    const [palletSolution] = optimizePallet(caseForPallet, pallet, {
      objective: "totalCount",
      topN: 1,
      ...options.loadOptions,
    });
    if (!palletSolution) continue;

    results.push({
      orientation: { vertical, grid: { nx, ny, nz } },
      primaryPerCase,
      fillEfficiency,
      caseWeight,
      palletSolution,
      totalPrimaryUnits: palletSolution.totalCount * primaryPerCase,
    });
  }

  results.sort((a, b) => b.totalPrimaryUnits - a.totalPrimaryUnits);

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = r.primaryPerCase;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped.slice(0, topN);
}
