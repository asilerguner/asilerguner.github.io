import { optimizePallet } from "./optimize.js";

/**
 * "Palletize Knocked-Down Flat cases" (KDF, docs section 4.6): flat-glued
 * corrugated blanks, stacked flat into a bundle, loaded DIRECTLY onto a
 * pallet (unlike Pack Folded Cartons, there is no intermediate case —
 * "determine... the best number of bundles on a pallet"). The search is
 * over bundle count (min to max, inclusive) rather than case geometry.
 *
 * KDF Formulae (docs section 11.10): a named, reusable formula that derives
 * the assembled case's reference "KDF Dimensions" from the flat blank's own
 * Length/Width/Thickness. A real, complete Cape Pack Cloud KDF Formulae
 * export (user-supplied, 9 real rows, plus its own real Add form, plus a
 * second real "Palletize Knocked-Down Flat" example's own live KDF Details
 * + Load Details + 6-row Solution Report) confirmed the actual shape: KDF
 * Length and KDF Width are each a FIXED 3-step chain — an optional
 * parenthesized first step combining the base with either nothing ("No
 * Selection") or Glue Flap, then a mandatory ×/÷-style step, then a
 * mandatory +/−-style step — while KDF Height is just a single mandatory
 * step (no parens, no Glue Flap slot). E.g. RSC's real KDF Length reads
 * "(L - Glue Flap) / 2.0000 - 0.0000", a simple style's (1 Piece Folders, 5
 * Panel Folders, Diecut Flat) reads "L * 1.0000 + 0.0000" (first slot
 * skipped — "No Selection" — so no parens show, KDF Height for these simple
 * styles is "Thickness * 1.0000"), while FOL/HSC/RSC's own KDF Height is
 * "Thickness * 2.0000".
 *
 * This function itself stays a generic left-to-right ordered-chain
 * evaluator regardless of that fixed UI shape — the UI (main.js) is what
 * constrains a real formula to exactly 3 terms (length/width) or 1 term
 * (height). A skipped first slot ("No Selection") is stored as a real term
 * with source "none" rather than omitted from the array, so the array
 * length alone can't be used to tell "slot skipped" apart from "shorter
 * chain" — evaluateKdfFormula treats "none" as a true no-op (skipped
 * entirely, regardless of its own op/value) rather than special-casing it
 * as e.g. "+0", which would be wrong for a "×" op.
 *
 * baseValue: the flat blank's own L, W, or Thickness, depending on which
 * KDF dimension is being computed.
 * terms: [{ op: "+" | "-" | "*" | "/", source: "none" | "value" | "glueFlap", value? }]
 * context: { glueFlap? } — glueFlap defaults to 0 (no-op) when omitted.
 */
export function evaluateKdfFormula(baseValue, terms = [], context = {}) {
  const glueFlap = context.glueFlap ?? 0;
  let result = baseValue;
  for (const term of terms) {
    if (term.source === "none") continue;
    const operand = term.source === "glueFlap" ? glueFlap : term.value ?? 0;
    if (term.op === "+") result += operand;
    else if (term.op === "-") result -= operand;
    else if (term.op === "*") result *= operand;
    else if (term.op === "/") result = operand === 0 ? result : result / operand;
  }
  return result;
}

// The simplest real KDF Formula shape ("1 Piece Folders" / "5 Panel
// Folders" / "Diecut Flat", all identical: pure pass-through, no Glue Flap
// involvement) — used as the default when no formula is selected, since
// it's the most conservative real option (not a fabricated default).
const IDENTITY_TERM = [{ op: "*", source: "value", value: 1 }, { op: "+", source: "value", value: 0 }];

/**
 * A bundle's own footprint and per-unit stack height are NOT simply the
 * raw flat blank's own length/width/thickness — they're the KDF-Formula-
 * derived "KDF Dimensions" (the assembled case's own reference size)
 * instead. Confirmed exactly, independently, by TWO real Cape Pack Cloud
 * examples this session (see docs/ARCHITECTURE.md for the full
 * derivation — including a real wrong turn along the way: an earlier pass
 * here hardcoded a x2 height multiplier from the FIRST example alone,
 * before the real formula list and the real Glue Flap value from the
 * SECOND example revealed it's actually formula-dependent, not universal):
 * both examples are explained exactly by the SAME real formula (FOL/HSC/
 * RSC-shaped: KDF Length=(L-GlueFlap)/2+/-0, KDF Width=W*1+0, KDF
 * Height=Thickness*2) with Glue Flap=25mm — a genuinely different result
 * from the "1 Piece Folders"-style simple pass-through (Thickness*1, no
 * Glue Flap) this function now defaults to when no formula is supplied.
 *
 * A KDF case is FLAT-GLUED (pre-glued into a tube before being laid flat,
 * unlike Pack Folded Cartons' own single flat blank — see
 * buildFoldedCartonBundle's own single-thickness formula, a genuinely
 * different physical product): laid flat, a glued tube's own front and
 * back walls overlap directly, so FOL/HSC/RSC-style cases contribute 2
 * plies of board thickness per unit — but this is a property of THAT
 * formula/case style specifically (confirmed real, not every KDF style —
 * the 3 simple styles use x1), not a fixed universal constant.
 *
 * flatblank: { length, width, weight, thickness }
 * options: { formula?: { length: terms[], width: terms[], height: terms[] },
 *   glueFlapMm?: number, heightFactor?: number, additionalStrapWeight?: number }
 *   formula omitted -> IDENTITY_TERM for length/width, Thickness*1 for
 *   height (the simplest real style, not a guess). heightFactor (real
 *   CapePack's own separate "Allow Height Factor" checkbox) multiplies ON
 *   TOP of the formula-derived per-unit height, not instead of it — still
 *   defaults to 1 (no additional adjustment).
 */
export function buildKdfBundle(flatblank, bundleCount, options = {}) {
  const heightFactor = options.heightFactor ?? 1;
  const additionalStrapWeight = options.additionalStrapWeight ?? 0;
  const formula = options.formula;
  const ctx = { glueFlap: options.glueFlapMm ?? 0 };

  const length = evaluateKdfFormula(flatblank.length, formula?.length ?? IDENTITY_TERM, ctx);
  const width = evaluateKdfFormula(flatblank.width, formula?.width ?? IDENTITY_TERM, ctx);
  const perUnitHeight = evaluateKdfFormula(flatblank.thickness, formula?.height ?? [{ op: "*", source: "value", value: 1 }], ctx);

  return {
    length,
    width,
    height: bundleCount * perUnitHeight * heightFactor,
    weight: bundleCount * flatblank.weight + additionalStrapWeight,
    allowedVertical: ["height"],
  };
}

/**
 * Search bundle count from bundleCountRange.min to .max (inclusive, step 1)
 * — mirrors CapePack's own "minimum and maximum Bundle Counts" input
 * (docs section 4.6.1) — building a bundle at each count and palletizing it
 * directly (no case), ranked by total flat blanks across the pallet.
 *
 * flatblank: { length, width, weight, thickness }
 * bundleCountRange: { min, max }
 * pallet: same shape as optimizePallet's pallet argument
 * options: passed straight through to buildKdfBundle (formula?,
 *   glueFlapMm?, heightFactor?, additionalStrapWeight?), plus topN?,
 *   loadOptions?.
 * loadOptions passes through to optimizePallet's own Load Details options
 * (allowPartialTopLayer, minLoadLength/Width, minAreaEfficiency, loadTarget).
 */
export function optimizeKdfBundleCount(flatblank, bundleCountRange, pallet, options = {}) {
  const topN = options.topN ?? 5;
  const results = [];

  for (let bundleCount = bundleCountRange.min; bundleCount <= bundleCountRange.max; bundleCount++) {
    if (bundleCount <= 0) continue;
    const bundle = buildKdfBundle(flatblank, bundleCount, options);

    const [palletSolution] = optimizePallet(bundle, pallet, {
      objective: "totalCount",
      topN: 1,
      ...options.loadOptions,
    });
    if (!palletSolution) continue;

    results.push({
      bundleCount,
      bundle,
      palletSolution,
      totalFlatblanks: palletSolution.totalCount * bundleCount,
    });
  }

  results.sort((a, b) => b.totalFlatblanks - a.totalFlatblanks);
  return results.slice(0, topN);
}
