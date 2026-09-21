/**
 * McKee formula — compression strength of a Regular Slotted Container (RSC)
 * corrugated case.
 *
 * Honesty note: mckeeBaseStrengthImperial's 5.874 coefficient (with
 * caliper in MILS, not literal inches, despite CapePack's own Imperial
 * Formulae screen saying "Caliper value (in)") is hand-verified against
 * a real reference BCT (compression.test.js). mckeeBaseStrengthMetric's
 * 1.82*1.0194=1.855308 coefficient independently matches CapePack's own
 * Metric Formulae screen exactly (shown there as "x 1.855" / precisely
 * "1.8553" in its Custom Formula editor, both user-supplied screenshots).
 * Both are individually confirmed real. But they do NOT dimensionally
 * reconcile with each other: converting the same physical case's inputs
 * (ECT/caliper/perimeter) from Imperial to literal kN·m⁻¹/mm/cm and
 * running them through the metric formula gives a result roughly 33.5x
 * smaller than converting the Imperial formula's own output from lb to
 * kg (verified numerically, several plausible caliper/perimeter unit-
 * scale alternatives — cm/dm/m instead of mm — checked and ruled out, not
 * just assumed). Whatever the reason (McKee-type formulas are known to
 * have independently-calibrated regional/unit-system coefficient sets
 * rather than being a strict unit conversion of one single formula), the
 * practical consequence is real: an analysis run under Imperial Report
 * Units and the SAME analysis run under Metric will show meaningfully
 * different absolute Base Strength numbers for the same physical case,
 * not just the same number in different units. Each formula matches its
 * own real CapePack screen exactly, so neither is "wrong" to implement
 * as shown — flagged here rather than silently picking one to adjust.
 */

// Named and exported (not just inline literals) so the Databases > Strength
// > Formulae screen (main.js) can display the exact same numbers this app
// actually calculates with, instead of a second hand-copied set of digits
// that could quietly drift out of sync with the real calculation.
export const MCKEE_COEFFICIENT_IMPERIAL = 5.874;
export const MCKEE_EXPONENT_CALIPER = 0.508;
export const MCKEE_EXPONENT_PERIMETER = 0.492;
export const MCKEE_COEFFICIENT_METRIC = 1.82 * 1.0194; // 1.855308 — see the honesty note above

export function mckeeBaseStrengthImperial({ ectLbIn, caliperMils, perimeterIn }) {
  return ectLbIn * MCKEE_COEFFICIENT_IMPERIAL * caliperMils ** MCKEE_EXPONENT_CALIPER * perimeterIn ** MCKEE_EXPONENT_PERIMETER;
}

export function mckeeBaseStrengthMetric({ ectKnM, caliperMm, perimeterCm }) {
  return MCKEE_COEFFICIENT_METRIC * ectKnM * caliperMm ** MCKEE_EXPONENT_CALIPER * perimeterCm ** MCKEE_EXPONENT_PERIMETER;
}

/** Number of cases that can safely be stacked on top of the bottom case. */
export function loadsHigh(baseStrengthLbOrKg, caseWeightLbOrKg) {
  return Math.floor(baseStrengthLbOrKg / caseWeightLbOrKg);
}

/** Percentage the board's strength exceeds (positive) or falls short of (negative) the required load. */
export function safetyMargin(strength, requiredWeight) {
  return ((strength - requiredWeight) / requiredWeight) * 100;
}

/**
 * The documented CapePack strength pipeline (docs section 7):
 *   Base Strength (McKee) -> x factors (case type, printing, partition,
 *   case proportion, fluting orientation) and - Production Factor % =
 *   Production Strength -> - humidity/storage/interlock/overhang
 *   degradation % = Life Cycle Strength (docs: "should be compared to the
 *   weight on the bottom case") -> - seasonal degradation % = Seasonal
 *   Strength
 *
 * caseProportionFactor/flutingOrientationFactor are the pipeline's
 * remaining two "x factors" this function didn't originally implement at
 * all (only case type/printing/partition were ever wired up) — real
 * CapePack's own Case Configuration screen (user-supplied screenshot)
 * confirmed both are real, separate multipliers alongside the other
 * three, not folded into any of them. caseProportionFactor in particular
 * is a manual pick, not auto-derived from the case's own L/H/W here: the
 * real screen's own 4 conditions ("L >= H, H > 1.5xW", "L > H, W > 1.5xH",
 * "L > H, W <= 1.5xH & H <= 1.5xW", "H > L") aren't provably mutually
 * exclusive and exhaustive as independent tests — e.g. "L >= H, H > 1.5xW"
 * and "L > H, W > 1.5xH" can both describe the same case depending on
 * evaluation order, which isn't specified — so rather than guess at
 * CapePack's own tie-breaking logic and risk silently misclassifying a
 * real case, this stays a factor the user selects directly (see
 * DATABASES_MENU/main.js's Case Proportion picker), the same way Storage
 * Environment's own Case Orientation/Stacking/Pallet Surface are manual
 * picks despite also describing a physical fact about the load.
 *
 * Every factor here still defaults to "no adjustment" (1 for multipliers,
 * 0% for deductions) so omitting one never silently fabricates a number —
 * now backed by real published values (see the Case Configuration/
 * Material Factors library types) for the ones that have them, not just a
 * documented pipeline shape with placeholder values.
 */
export function applyStrengthFactorChain(baseStrength, factors = {}) {
  const {
    caseTypeFactor = 1,
    printingFactor = 1,
    partitionFactor = 1,
    caseProportionFactor = 1,
    flutingOrientationFactor = 1,
    productionFactorPct = 0,
    lifeCycleDegradationPct = 0,
    seasonalDegradationPct = 0,
  } = factors;

  const productionStrength =
    baseStrength *
    caseTypeFactor *
    printingFactor *
    partitionFactor *
    caseProportionFactor *
    flutingOrientationFactor *
    (1 - productionFactorPct / 100);
  const lifeCycleStrength = productionStrength * (1 - lifeCycleDegradationPct / 100);
  const seasonalStrength = lifeCycleStrength * (1 - seasonalDegradationPct / 100);

  return { baseStrength, productionStrength, lifeCycleStrength, seasonalStrength };
}

/**
 * Storage Environment Database — CapePack's own documented factor tables
 * (Cape Pack Cloud "Strength" tab > Database > Storage Environment), taken
 * directly from Esko's published Cloud Strength user guide (the "Master
 * Strength Database" defaults every install ships with, Imperial units:
 * docs.esko.com/docs/en-us/cape/18/otherdocs/Cloud Strength-EN.pdf, p.5).
 * Unlike the McKee formula's own coefficients, these particular numbers
 * *are* publicly documented by Esko as their shipped defaults — reproduced
 * here verbatim, not estimated. CapePack lets each company edit its own
 * copy of this database; so does SimPallet (see storage-environment
 * library type) — these are the starting values, not fixed constants.
 */
export const STORAGE_ENVIRONMENT_DEFAULTS = {
  humidityPct: [
    { max: 35, factor: 1.1 },
    { max: 45, factor: 1.1 },
    { max: 55, factor: 1 },
    { max: 65, factor: 0.9 },
    { max: 75, factor: 0.8 },
    { max: 85, factor: 0.7 },
    { max: 100, factor: 0.5 },
  ],
  daysStored: [
    { max: 0, factor: 1 },
    { max: 3, factor: 0.7 },
    { max: 10, factor: 0.65 },
    { max: 30, factor: 0.6 },
    { max: 60, factor: 0.55 },
    { max: 90, factor: 0.55 },
    { max: 120, factor: 0.5 },
    { max: Infinity, factor: 0.45 },
  ],
  caseOrientation: { base: 1, side: 0.9, end: 0.8 },
  stacking: { stacked: 1, interlocked: 0.6 },
  palletOverhangPct: [
    { max: 0, factor: 1 },
    { max: 0.25, factor: 0.9 },
    { max: 0.75, factor: 0.8 },
    { max: 1.0, factor: 0.7 },
    { max: Infinity, factor: 0.6 },
  ],
  palletSurface: { gapped: 0.92, solid: 1 },
};

function bracketFactor(brackets, value) {
  const hit = brackets.find((b) => value <= b.max);
  return (hit ?? brackets[brackets.length - 1]).factor;
}

/**
 * Combined multiplier for the six Storage Environment factors, matching
 * how CapePack's own docs describe them: "the initially calculated
 * compression value" gets multiplied by each selected factor in turn.
 * Feed the result into applyStrengthFactorChain's lifeCycleDegradationPct
 * as (1 - factor) * 100.
 */
export function storageEnvironmentFactor(
  {
    humidityPct = 50,
    daysStored = 0,
    caseOrientation = "base",
    stacking = "stacked",
    palletOverhangPct = 0,
    palletSurface = "solid",
  } = {},
  table = STORAGE_ENVIRONMENT_DEFAULTS
) {
  return (
    bracketFactor(table.humidityPct, humidityPct) *
    bracketFactor(table.daysStored, daysStored) *
    (table.caseOrientation[caseOrientation] ?? 1) *
    (table.stacking[stacking] ?? 1) *
    bracketFactor(table.palletOverhangPct, palletOverhangPct) *
    (table.palletSurface[palletSurface] ?? 1)
  );
}

/**
 * Combined-board Edge Crush (Ring Crush method) — CapePack's own documented
 * formula (Strength tab > Database > Formulae > Edge Crush Formulae >
 * "Edge Ring Crush"), generalized from its Σ notation to any wall count:
 *   EC(RC) = (Σ(medium.rc × medium.takeupFactor) + Σ(liner.rc)) × efficiencyFactor
 *            + (12 if burstTestLb <= 200 else -6)
 * Inputs come from the Material Factors Database (liner/medium Ring Crush
 * values, per-flute takeup factors, and the burst-test efficiency factor).
 *
 * Honesty note: this transcription was re-verified character-for-character
 * against a zoomed capture of Esko's own Formulae screen. Esko's Single
 * Wall Board demo table's first row doesn't fully reconcile against this
 * formula using the Material Factors values printed elsewhere in the same
 * PDF (off by a small, non-rounding amount) — most likely the two
 * screenshots in Esko's own doc weren't captured from the same database
 * snapshot. The STFI formula below WAS independently cross-checked against
 * that same demo row and matches almost exactly, which validates the
 * liner/medium lookup and pairing logic used here; the discrepancy is
 * isolated to this Ring Crush formula's constants. Use with real material
 * data and sanity-check against a known board before relying on it.
 *
 * Update: a real user account's own Single AND Double Wall Board export
 * (packages/library/board-grades.json's "sw-r01"/"dw-r01" — a genuinely
 * different, non-generic-demo data source from the paragraph above) DOES
 * fully reconcile against this same formula and this same Material
 * Factors lookup — e.g. sw-r01 (L1=L2="23", M1="23", F1="B", burst=125):
 * (30×1.33 + 31+31) × 0.13 + 12 = 25.247, matching that board's own real
 * EC(RC)=25.2470 to 4 decimal places, and dw-r01 similarly matches
 * exactly (see compression.test.js). So the formula and lookup logic are
 * both confirmed correct in general; the one demo row above that doesn't
 * reconcile is most likely just internally inconsistent within Esko's own
 * generic PDF, not a sign anything here is wrong.
 */
// Named and exported for the same reason as the McKee constants above —
// the Formulae screen shows these same numbers, unit-converted for
// display, and must never drift from what this function actually uses.
export const RING_CRUSH_BURST_THRESHOLD_LB = 200;
export const RING_CRUSH_LOW_BURST_ADJUSTMENT = 12;
export const RING_CRUSH_HIGH_BURST_ADJUSTMENT = -6;

export function combinedEdgeCrushRingCrush({ liners, mediums, burstTestLb, efficiencyFactor }) {
  const mediumSum = mediums.reduce((sum, m) => sum + m.rc * m.takeupFactor, 0);
  const linerSum = liners.reduce((sum, l) => sum + l.rc, 0);
  const adjustment =
    burstTestLb <= RING_CRUSH_BURST_THRESHOLD_LB ? RING_CRUSH_LOW_BURST_ADJUSTMENT : RING_CRUSH_HIGH_BURST_ADJUSTMENT;
  return (mediumSum + linerSum) * efficiencyFactor + adjustment;
}

/**
 * Combined-board Edge Crush (STFI method) — CapePack's own documented
 * per-wall-count formulas (same Formulae screen, "For STFI"). Unlike Ring
 * Crush these are NOT one generalized formula per wall count; each has its
 * own published form, reproduced exactly from the real Formulae screen
 * (user-supplied screenshot, superseding the coefficients this function
 * used before — see below):
 *   Single: ((medium.stfi × medium.takeupFactor) + Σ(liner.stfi)) × 0.642 + 0.948
 *   Double: ((medium1.stfi × takeup1) + (medium2.stfi × takeup2) + Σ(liner.stfi)) × 0.473 + 24.853
 *   Triple: 1.28 × (L1 + F1×M1 + L2 + F2×M2 + L3 + F3×M3 + L4)  — a real
 *     4-liner/3-medium/3-flute board, not a "sum of liners + one medium"
 *     shape at all.
 *
 * stfiTripleWall's PREVIOUS implementation here — `0.62 + 0.633 ×
 * Σ(liner.stfi) + 1.03 × medium.stfi`, a single fitted-linear-regression-
 * style formula with no per-layer flute/medium structure — was wrong,
 * not just imprecise: the real formula has a completely different shape
 * (each medium layer paired with its own flute's takeup factor, all 4
 * liners entering individually, no regression-style intercept). It was
 * never wired to any picker in the app (confirmed via grep before fixing
 * — main.js's own comment already flagged it as "not wired to a picker
 * yet"), so this corrects the formula before its first real use rather
 * than fixing a live miscalculation. Not independently re-validated
 * against a non-degenerate real Triple Wall Board row — every real row
 * available (10, all sourced from the same account) uses liners with an
 * unrecorded STFI value (0 in this app's own Liner Materials data, "56H"
 * and "35H"), so their real EC(STFI) is 0 for a structural reason (an
 * unknown input), not something a correct formula could reproduce as a
 * meaningful non-zero check.
 */
export function stfiSingleWall({ medium, liners }) {
  const linerSum = liners.reduce((sum, l) => sum + l.stfi, 0);
  return (medium.stfi * medium.takeupFactor + linerSum) * 0.642 + 0.948;
}

export function stfiDoubleWall({ medium1, medium2, liners }) {
  const linerSum = liners.reduce((sum, l) => sum + l.stfi, 0);
  return (medium1.stfi * medium1.takeupFactor + medium2.stfi * medium2.takeupFactor + linerSum) * 0.473 + 24.853;
}

export function stfiTripleWall({ liner1, liner2, liner3, liner4, medium1, medium2, medium3, flute1, flute2, flute3 }) {
  return (
    1.28 *
    (liner1.stfi +
      flute1.takeupFactor * medium1.stfi +
      liner2.stfi +
      flute2.takeupFactor * medium2.stfi +
      liner3.stfi +
      flute3.takeupFactor * medium3.stfi +
      liner4.stfi)
  );
}

/**
 * Generic 3-term custom BCT formula — CapePack's own "Custom Formula
 * Entry" editor (Strength > Database > Formulae > "Edit your Custom
 * Formulae", user-supplied screenshot): each of Edge Crush Value/Caliper
 * Value/Case Perimeter is first combined with its own value via one of
 * Times/Raised To/Divided by, then adjusted by Plus/Minus its own amount;
 * the three resulting terms are then chained together via two more
 * Times/Raised To/Divided by connectors. Deliberately fully generic (not
 * hardcoded to McKee's own particular choice of operators) since the real
 * editor lets every one of those five operators be changed independently
 * — feeding it McKee's own defaults (term1: Times COEFFICIENT, term2:
 * Raised To 0.508, term3: Raised To 0.492, both connectors Times, every
 * Plus adjustment 0) reproduces mckeeBaseStrengthImperial/Metric exactly.
 */
function applyFormulaOp(value, op, operand) {
  if (op === "raisedTo") return value ** operand;
  if (op === "dividedBy") return value / operand;
  return value * operand; // "times" (and any unrecognized op, defensively)
}

export function evaluateCustomFormula(formula, { edgeCrushValue, caliperValue, casePerimeter }) {
  const termValue = (term, input) => {
    const combined = applyFormulaOp(input, term.combineOp, term.value);
    return term.adjOp === "minus" ? combined - term.adjValue : combined + term.adjValue;
  };
  const term1 = termValue(formula.term1, edgeCrushValue);
  const term2 = termValue(formula.term2, caliperValue);
  const term3 = termValue(formula.term3, casePerimeter);
  const step1 = applyFormulaOp(term1, formula.connector1, term2);
  return applyFormulaOp(step1, formula.connector2, term3);
}
