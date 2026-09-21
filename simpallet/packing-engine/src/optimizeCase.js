import { getOrientations } from "./geometry.js";
import { optimizePallet } from "./optimize.js";

/**
 * "Create a Case" workflow: search over candidate new-case sizes built as an
 * nx × ny × nz grid of the primary pack, and score each candidate by how
 * well the resulting case then palletizes — i.e. total primary units per
 * pallet, not just case fill. This nests the Level 1/2 pallet search inside
 * an outer search over case geometry (see docs/PACKING_ALGORITHM.md).
 *
 * Mirrors CapePack's own Inside/Outside Dimensions model (see "Adding
 * Secondary Pack Details" in the Cape Pack Cloud user guide): the primary
 * packs determine the case's INSIDE dimensions, and caseThickness (board
 * caliper) is added to both sides of each axis to get the OUTSIDE
 * dimensions actually placed on the pallet. Without this, every nx×ny×nz
 * factorization of the same primary count is volume-identical and the
 * search can't tell them apart — thickness is what makes fewer, larger
 * cases genuinely more material-efficient per unit than many small ones.
 *
 * primary: { length, width, height, weight, allowedVertical? }
 * pallet:  same shape as optimizePallet's pallet argument
 * options: { maxPerCase?, maxFactor?, minPerCase?, caseThickness?, numThicknesses?,
 *            slackIn?, odRange?, maxCaseWeight?, caseAllowedVertical?, topN?, loadOptions? }
 * loadOptions passes through to optimizePallet's own Load Details options
 * (allowPartialTopLayer, minLoadLength/Width, minAreaEfficiency, loadTarget).
 *
 * numThicknesses/slackIn/odRange/maxCaseWeight/caseAllowedVertical (real
 * CapePack Secondary Pack Details fields, user-supplied Create a Case
 * export) all default to exactly reproducing this function's pre-existing
 * behavior when omitted — see each default's own comment below — so every
 * existing caller (Resize's own caseOptions passthrough, Pack Folded
 * Cartons' "New Case" path) picks these up automatically and harmlessly.
 */
/**
 * The container-geometry half of optimizeCase's own search — enumerate
 * every nx×ny×nz grid of `primary` that fits the count/weight/OD
 * constraints, with NO pallet-level scoring at all. Extracted out of
 * optimizeCase (which now just calls this once, then scores each
 * candidate against a real pallet exactly as it always has) so a second
 * caller — optimizeCaseWithInnerPack.js's own inner "primary -> inner
 * pack" level — can reuse the identical, already-verified geometry math
 * without a pallet in the loop at all (an inner pack isn't itself
 * palletized directly).
 *
 * containerWeight (new, optional, default 0): a fixed weight added once
 * per container on top of `primaryCount * primary.weight` — e.g. an
 * inner pack's own real wrap/tray material weight. optimizeCase itself
 * never passes this (case-level material weight has never been modeled
 * — see optimizeCase's own doc comment), so omitting it leaves every
 * existing candidate's own weight byte-identical to before this was
 * added.
 */
export function candidateContainers(primary, options = {}) {
  const maxPerCase = options.maxPerCase ?? 24;
  const minPerCase = options.minPerCase ?? 1;
  const maxFactor = options.maxFactor ?? 6; // max count of primary packs along any one case axis
  const caseThickness = options.caseThickness ?? 0; // board caliper, same units as primary dims
  // {2,2,2} here, NOT the real RSC-style {2,2,4} default shapes.json uses —
  // the two existing pinned tests below assert height===123 from
  // insideDimensions.height=120 and caseThickness=1.5 (120 + 2×1.5); a
  // {2,2,4} engine-level default would silently break both (120 + 4×1.5 =
  // 126). The real {2,2,4} default belongs only at the UI layer (Create a
  // Case's own initial field value, matching Cases and Trays' identical
  // convention) and when a real Pack Type style is picked there.
  const numThicknesses = options.numThicknesses ?? { length: 2, width: 2, height: 2 };
  const slackIn = options.slackIn ?? { length: 0, width: 0, height: 0 };
  const odRange = options.odRange ?? {}; // { length?: {min?,max?}, width?: {...}, height?: {...} }
  const maxCaseWeight = options.maxCaseWeight ?? Infinity;
  const caseAllowedVertical = options.caseAllowedVertical; // undefined preserves the all-axes-permissive default getOrientations already has
  const containerWeight = options.containerWeight ?? 0;

  const orientations = getOrientations(primary, primary.allowedVertical);
  const candidates = [];

  const odAxisInRange = (value, axis) => {
    const range = odRange[axis];
    if (!range) return true;
    if (range.min != null && value < range.min) return false;
    if (range.max != null && value > range.max) return false;
    return true;
  };

  for (const { vertical, h, l, w } of orientations) {
    for (let nx = 1; nx <= maxFactor; nx++) {
      for (let ny = 1; ny <= maxFactor; ny++) {
        for (let nz = 1; nz <= maxFactor; nz++) {
          const primaryCount = nx * ny * nz;
          if (primaryCount > maxPerCase || primaryCount < minPerCase) continue;

          const insideDimensions = {
            length: nx * l + 2 * slackIn.length,
            width: ny * w + 2 * slackIn.width,
            height: nz * h + 2 * slackIn.height,
          };
          const outsideDimensions = {
            length: insideDimensions.length + caseThickness * numThicknesses.length,
            width: insideDimensions.width + caseThickness * numThicknesses.width,
            height: insideDimensions.height + caseThickness * numThicknesses.height,
            weight: primaryCount * primary.weight + containerWeight,
            allowedVertical: caseAllowedVertical,
          };
          if (outsideDimensions.weight > maxCaseWeight) continue;
          if (
            !odAxisInRange(outsideDimensions.length, "length") ||
            !odAxisInRange(outsideDimensions.width, "width") ||
            !odAxisInRange(outsideDimensions.height, "height")
          )
            continue;

          candidates.push({
            caseDimensions: outsideDimensions,
            insideDimensions,
            caseThickness,
            primaryPerCase: primaryCount,
            primaryGrid: { nx, ny, nz, vertical },
          });
        }
      }
    }
  }

  return candidates;
}

export function optimizeCase(primary, pallet, options = {}) {
  const topN = options.topN ?? 5;
  const candidates = candidateContainers(primary, options);
  const results = [];

  for (const c of candidates) {
    const [palletSolution] = optimizePallet(c.caseDimensions, pallet, {
      objective: "totalCount",
      topN: 1,
      ...options.loadOptions,
    });
    if (!palletSolution) continue;

    results.push({
      ...c,
      palletSolution,
      totalPrimaryUnits: palletSolution.totalCount * c.primaryPerCase,
    });
  }

  results.sort((a, b) => b.totalPrimaryUnits - a.totalPrimaryUnits);

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const { length, width, height } = r.caseDimensions;
    const key = `${length}x${width}x${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped.slice(0, topN);
}
