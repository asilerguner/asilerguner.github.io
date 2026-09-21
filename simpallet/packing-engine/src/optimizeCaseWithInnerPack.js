import { candidateContainers, optimizeCase } from "./optimizeCase.js";

/**
 * "Create a Case" with an optional 4th level, a genuinely new app feature
 * with no CapePack precedent (user request): Primary Pack -> Inner Pack ->
 * Case -> Pallet, instead of the usual Primary Pack -> Case -> Pallet.
 * e.g. 6 bottles grouped into a small inner pack, 4 inner packs per case.
 *
 * This is exactly one more level of the same nesting optimizeCase.js's own
 * doc comment already describes (case geometry search nested inside a
 * pallet search) — here, an inner-pack geometry search nested inside a
 * full, unmodified optimizeCase call (itself already nesting case geometry
 * inside a pallet search). optimizeCase is reused as-is: once a candidate
 * inner pack's own outside dimensions/weight are computed, that candidate
 * IS the "primary" optimizeCase searches a case around.
 *
 * Performance: a full inner-pack-candidate x case-candidate x pallet
 * product is intractable (optimizeCase alone already makes up to
 * maxFactor^3 x orientations calls into optimizePallet). Every inner-pack
 * candidate is cheaply ranked by its own primaryPerContainer (more primary
 * units per inner pack first, tie-broken by a tighter outside volume)
 * BEFORE the expensive part — only the top INNER_PACK_SEARCH_WIDTH
 * candidates each get a real, full optimizeCase call. Not a user-facing
 * setting: a small, fixed internal bound, same spirit as this file's own
 * topN.
 *
 * primary:         { length, width, height, weight, allowedVertical? }
 * pallet:          same shape as optimizePallet's pallet argument
 * innerPackOptions: same shape as optimizeCase's own options (minPerCase/
 *   maxPerCase/maxFactor/caseThickness/numThicknesses/slackIn), plus
 *   containerWeight (the inner pack's own real material weight, added once
 *   per inner pack — see candidateContainers' own doc comment).
 * caseOptions:      passed through to the inner optimizeCase call
 *   unchanged (same shape it already accepts today).
 */
const INNER_PACK_SEARCH_WIDTH = 8;

export function optimizeCaseWithInnerPack(primary, pallet, innerPackOptions = {}, caseOptions = {}) {
  const topN = caseOptions.topN ?? 5;

  const innerCandidates = candidateContainers(primary, innerPackOptions);
  const rankedInner = [...innerCandidates].sort((a, b) => {
    if (b.primaryPerCase !== a.primaryPerCase) return b.primaryPerCase - a.primaryPerCase;
    const volA = a.caseDimensions.length * a.caseDimensions.width * a.caseDimensions.height;
    const volB = b.caseDimensions.length * b.caseDimensions.width * b.caseDimensions.height;
    return volA - volB; // tighter (smaller) outside volume wins a tie
  });
  const topInner = rankedInner.slice(0, INNER_PACK_SEARCH_WIDTH);

  const results = [];
  for (const inner of topInner) {
    const innerPackAsPrimary = { ...inner.caseDimensions };
    const caseResults = optimizeCase(innerPackAsPrimary, pallet, caseOptions);
    for (const cr of caseResults) {
      results.push({
        innerPack: {
          dimensions: inner.caseDimensions,
          insideDimensions: inner.insideDimensions,
          primaryPerInnerPack: inner.primaryPerCase,
          primaryGrid: inner.primaryGrid,
        },
        caseDimensions: cr.caseDimensions,
        insideDimensions: cr.insideDimensions,
        caseThickness: cr.caseThickness,
        primaryPerCase: cr.primaryPerCase, // = inner packs per case
        primaryGrid: cr.primaryGrid, // case-level grid, in terms of inner packs
        palletSolution: cr.palletSolution,
        totalPrimaryUnits: cr.totalPrimaryUnits * inner.primaryPerCase, // real primary (e.g. bottle) count
      });
    }
  }

  results.sort((a, b) => b.totalPrimaryUnits - a.totalPrimaryUnits);

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const ip = r.innerPack.dimensions;
    const c = r.caseDimensions;
    const key = `${ip.length}x${ip.width}x${ip.height}|${c.length}x${c.width}x${c.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped.slice(0, topN);
}
