import { optimizeCase } from "./optimizeCase.js";

/**
 * "Resize a Primary Pack Size" workflow (docs section 4.3): unlike Create a
 * Case, the primary pack's own dimensions aren't fixed — each axis can vary
 * within a tolerance range, stepped by an increment, and every resulting
 * candidate size gets a case designed around it (reusing optimizeCase) and
 * palletized. This is genuinely a search nested one level deeper than
 * Create a Case: candidate primary size -> candidate case grid -> pallet fit.
 *
 * "with a starting size of 3” and a variance of -0.5” to +1”, the program
 * will consider sizes from 2.5” to 4”" — docs section 4.3.1. Candidates are
 * generated per-axis from (base - minus) to (base + plus) stepping by
 * increment, inclusive, matching that description exactly.
 *
 * primary: { length, width, height, weight, allowedVertical? } — the
 *   starting size.
 * variance: { length?, width?, height? } — each present axis is
 *   { minus, plus, increment }; axes not listed stay fixed at the base value.
 * pallet: same shape as optimizePallet's pallet argument.
 * options: { varyWeight?: boolean, caseOptions?: object passed through to
 *   optimizeCase (maxPerCase, maxFactor, caseThickness), topN?,
 *   dependentAxis?: "length"|"width"|"height" }
 *
 * varyWeight mirrors CapePack's own checkbox: when true, weight scales
 * proportionally with volume relative to the base size; when false
 * (default — matches "uncheck it to keep the weight constant"), every
 * candidate keeps the original weight.
 *
 * dependentAxis mirrors real CapePack's own "Fixed Volume" mode
 * (Vary Volume Settings panel, user-supplied screenshot) — confirmed by
 * hand against 5 real export rows (baseVolume / (length × width) matched
 * the real height to within ~0.00005mm, consistent with the real UI's own
 * 4-decimal display rounding — see docs/ARCHITECTURE.md). Rather than
 * stepping through variance[axis] like every other axis, the named
 * dependentAxis is SOLVED per candidate to keep length×width×height equal
 * to the base volume — deliberately an explicit option, not inferred from
 * variance[axis].increment === 0 inside this function: a real, plausible
 * variance object for "this axis doesn't vary" (minus=plus=increment=0)
 * is indistinguishable from "derive this axis" by that signal alone, so
 * the caller (the UI layer, which already knows which mode is selected)
 * must say so explicitly. Omitted (the only pre-existing usage): every
 * axis steps independently, unchanged from before this option existed.
 */
export function resizePrimaryPack(primary, variance, pallet, options = {}) {
  const varyWeight = options.varyWeight ?? false;
  const caseOptions = options.caseOptions ?? {};
  const topN = options.topN ?? 5;
  const dependentAxis = options.dependentAxis;
  const baseVolume = primary.length * primary.width * primary.height;

  function candidateValues(axis) {
    const base = primary[axis];
    const v = variance[axis];
    // increment <= 0 is a real, reachable input (a user leaving an axis's
    // own fields at their all-zero "doesn't vary" default — see this
    // function's own doc comment above), not just a malformed one — without
    // this guard, x += 0 never advances past `base` and the loop below
    // never terminates. Treating it the same as "no variance entry at all"
    // is the safe, spec-consistent reading: a range with no step is
    // ill-defined regardless of minus/plus, so collapsing to the base value
    // is correct, not just non-crashing.
    if (!v || v.increment <= 0) return [base];
    const values = [];
    for (let x = base - v.minus; x <= base + v.plus + 1e-9; x += v.increment) {
      values.push(Math.round(x * 1000) / 1000);
    }
    return values;
  }

  // dependentAxis's own values are derived per-candidate below (from the
  // OTHER two axes), not stepped — a single null placeholder keeps the
  // triple loop's shape identical for every other axis, stepped or not.
  const lengths = dependentAxis === "length" ? [null] : candidateValues("length");
  const widths = dependentAxis === "width" ? [null] : candidateValues("width");
  const heights = dependentAxis === "height" ? [null] : candidateValues("height");

  const results = [];
  for (const lengthCandidate of lengths) {
    for (const widthCandidate of widths) {
      for (const heightCandidate of heights) {
        let length = lengthCandidate;
        let width = widthCandidate;
        let height = heightCandidate;
        // 4 decimals (not candidateValues' own 3) to match real CapePack's
        // own display precision for this specific field — showResizeSolutions
        // never rounds primary height itself, so an unrounded division here
        // would otherwise leak raw float noise into the live results table.
        if (dependentAxis === "length") length = Math.round((baseVolume / (width * height)) * 10000) / 10000;
        else if (dependentAxis === "width") width = Math.round((baseVolume / (length * height)) * 10000) / 10000;
        else if (dependentAxis === "height") height = Math.round((baseVolume / (length * width)) * 10000) / 10000;

        // A stepped candidate at or near 0 on either OTHER axis makes the
        // derived axis non-finite or negative — confirmed by direct testing
        // that a negative/NaN height crashes optimizeCase's own search with
        // a stack overflow, and a zero height silently produces a bogus fit.
        // An oversized derived value needs no special handling — the same
        // "no fit, skip it" path below already covers that, same as any
        // other oversized stepped candidate.
        if (dependentAxis) {
          const derived = dependentAxis === "length" ? length : dependentAxis === "width" ? width : height;
          if (!Number.isFinite(derived) || derived <= 0) continue;
        }

        const volume = length * width * height;
        const weight = varyWeight ? primary.weight * (volume / baseVolume) : primary.weight;
        const candidate = { length, width, height, weight, allowedVertical: primary.allowedVertical };

        const [caseResult] = optimizeCase(candidate, pallet, { ...caseOptions, topN: 1 });
        if (!caseResult) continue;

        results.push({
          primary: candidate,
          dimensionalChange: {
            length: length - primary.length,
            width: width - primary.width,
            height: height - primary.height,
          },
          caseResult,
          totalPrimaryUnits: caseResult.totalPrimaryUnits,
        });
      }
    }
  }

  results.sort((a, b) => b.totalPrimaryUnits - a.totalPrimaryUnits);

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = `${r.primary.length}x${r.primary.width}x${r.primary.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped.slice(0, topN);
}
