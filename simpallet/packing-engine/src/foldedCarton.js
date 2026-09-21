import { optimizeCase } from "./optimizeCase.js";

/**
 * "Pack Folded Cartons" workflow (docs section 4.5): "builds bundles of flat
 * folded cartons, arranges them into cases, and loads the cases onto
 * pallets." Two sub-workflows — New Case and Stock Case — mirror Create a
 * Case and Fill a Stock Case exactly, with one carton-specific step in
 * front: turning a flat folded carton into a bundle.
 *
 * Per the docs, "Folded Carton Dimensions" are direct USER INPUT — CapePack
 * does not compute them from an assembled-carton fold pattern (that would
 * depend on carton style: reverse tuck, straight tuck, auto-bottom, etc.,
 * a whole taxonomy this project doesn't have verified geometry for, so it's
 * deliberately not guessed at). What IS carton-specific and documented is:
 * "Thickness values and Fluff Factor auto-populate based on the carton and
 * board selected... the fluff factor is the expansion ratio of the carton
 * when folded flat" (section 4.5.1). The exact auto-population table is
 * proprietary to CapePack's own carton/board database and isn't reproduced
 * here — fluffFactor defaults to 1 (no expansion) so a caller who doesn't
 * know a better value gets the literal board thickness, not a fabricated
 * multiplier.
 */
export function buildFoldedCartonBundle(carton, cartonsPerBundle) {
  const { length, width, weight, boardThickness, fluffFactor = 1 } = carton;
  const flatThickness = boardThickness * fluffFactor;

  return {
    length,
    width,
    height: cartonsPerBundle * flatThickness,
    weight: cartonsPerBundle * weight,
    allowedVertical: ["height"], // a bundle stacks along the flat-carton thickness axis
  };
}

/**
 * "New Case" sub-workflow: search cartonsPerBundle from
 * cartonsPerBundleRange.min to .max (inclusive, step 1) — mirrors real
 * Cape Pack Cloud's own "Bundle Counts: Minimum/Maximum" input, confirmed
 * against a real 11-of-80-row export (bundle height = cartonsPerBundle ×
 * Thickness1, exact on every row; rows ranked by total CARTONS across the
 * pallet, descending). Structurally mirrors kdf.js's own
 * optimizeKdfBundleCount (same outer loop over a count range) but nests
 * optimizeCase() instead of going straight to optimizePallet, since Pack
 * Folded Cartons' New Case puts a designed case between the bundle and
 * the pallet (mirrors resizePrimaryPack.js's own nested-optimizeCase
 * precedent) — with one deliberate difference from BOTH of those: the
 * inner optimizeCase() call is NOT forced to topN:1. The real export
 * shows multiple distinct Secondary Pack IDs at the exact same
 * cartonsPerBundle (e.g. two real rows share bundle height 90mm but
 * differ in case ID and pattern type), so every candidate's own topN
 * worth of case options is pooled, not collapsed to its single best.
 *
 * Known, disclosed gap (not fixed by this function): the real export's
 * Secondary Pack (ID) height is 200mm on every one of the 11 real rows
 * checked, regardless of bundle height varying from 90mm to 180mm across
 * them. optimizeCase()'s own rectilinear grid model always makes case
 * inside-height an integer multiple of the packed object's height
 * (nz × height, plus slack) — no integer nz produces 200 from any of
 * those real bundle heights, and every allowedVertical/axis permutation
 * tried during design review got no closer. Real Cape Pack Cloud is
 * doing something structurally different here for bundle-to-case sizing
 * (plausibly a partially fixed envelope tied to the chosen Pack Type
 * library entry, not a plain grid search) — not a tunable parameter, a
 * different algorithm this project doesn't have enough evidence to
 * reproduce. Same disclosed-gap category as optimizeCase.js's own
 * "Pattern Type can never show Multiple" / Esko pattern-fidelity notes —
 * see docs/ARCHITECTURE.md. Tests against this function use synthetic
 * fixtures, not real export numbers, for exactly this reason.
 *
 * Still open after a second, independent real export (see
 * buildFoldedCartonBundle's own test for the bundle-level numbers this
 * one confirms): Case (OD) 246×156×212mm against Bundle (OD)
 * 120×100×90mm — Length is a clean fit (2×120 + 6mm walls = 246), but
 * Width/Height aren't (156 isn't 2×100 plus any plausible wall thickness;
 * 212 isn't an integer multiple of 90 either). The real screen's own
 * "Number of Thicknesses" readout (2, 2, 4 here) suggests CapePack may be
 * packing at the individual-carton level inside the case — using
 * Thickness 2 for a different stacking axis than the bundle itself uses —
 * rather than arranging whole pre-built bundles in a grid, which would
 * also finally explain why Thickness 2 has never shown a confirmed effect
 * at the bundle level. That's a real hypothesis, not a guess dressed up as
 * one — but it's built from exactly one example, the same evidence bar
 * this project has never shipped a formula on before, so it stays
 * disclosed instead of implemented until a second example can confirm or
 * kill it.
 *
 * carton: { length, width, weight, boardThickness, fluffFactor? } — same
 *   shape buildFoldedCartonBundle already takes.
 * cartonsPerBundleRange: { min, max }
 * pallet: same shape as optimizePallet's pallet argument.
 * options: { caseOptions?: object passed through to optimizeCase
 *   (maxPerCase, maxFactor, caseThickness, numThicknesses, odRange,
 *   maxCaseWeight, caseAllowedVertical, topN), loadOptions?, topN?,
 *   cartonsPerCaseRange?: { min?, max? } }
 *
 * cartonsPerCaseRange (user ask: "fill in the gaps" — this was previously
 * captured in the UI for save/rerun fidelity only, never actually applied
 * to the search — a real, mechanical gap, unlike several others in this
 * same UI section left deliberately unfilled below for lack of real
 * evidence). Filters the OUTPUT after both loops below, the same point
 * odRange/maxCaseWeight are already enforced inside optimizeCase itself —
 * cartonsPerCase = cartonsPerBundle × the case's own primaryPerCase, so it
 * isn't knowable until both are multiplied together, unlike a per-axis
 * dimension check that can reject a candidate case before its pallet fit
 * is even computed. Either bound is optional; an absent min/max means "no
 * bound on that side," matching every other optional range in this app
 * (e.g. readCaseOptions' own odRange).
 */
export function optimizeFoldedCartonBundleCount(carton, cartonsPerBundleRange, pallet, options = {}) {
  const topN = options.topN ?? 40;
  const caseOptions = options.caseOptions ?? {};
  const { min: minPerCase, max: maxPerCase } = options.cartonsPerCaseRange ?? {};
  const results = [];

  for (let cartonsPerBundle = cartonsPerBundleRange.min; cartonsPerBundle <= cartonsPerBundleRange.max; cartonsPerBundle++) {
    if (cartonsPerBundle <= 0) continue;
    const bundle = buildFoldedCartonBundle(carton, cartonsPerBundle);
    const caseResults = optimizeCase(bundle, pallet, { ...caseOptions, loadOptions: options.loadOptions });
    for (const r of caseResults) {
      const cartonsPerCase = r.primaryPerCase * cartonsPerBundle;
      if (minPerCase != null && cartonsPerCase < minPerCase) continue;
      if (maxPerCase != null && cartonsPerCase > maxPerCase) continue;
      results.push({
        ...r,
        cartonsPerBundle,
        bundle,
        cartonsPerCase,
        totalCartons: r.totalPrimaryUnits * cartonsPerBundle,
      });
    }
  }

  // Ranking key is total CARTONS across the pallet, hand-verified against
  // all 11 real rows (PP Per Load, descending) — not total bundles, which
  // is what optimizeCase's own totalPrimaryUnits means here.
  results.sort((a, b) => b.totalCartons - a.totalCartons);

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const { length, width, height } = r.caseDimensions;
    const key = `${r.cartonsPerBundle}-${length}x${width}x${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped.slice(0, topN);
}
