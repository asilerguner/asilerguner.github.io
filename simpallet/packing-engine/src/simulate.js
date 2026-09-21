import { optimizePallet } from "./optimize.js";
import { optimizeCase } from "./optimizeCase.js";
import { fillStockCase } from "./fillStockCase.js";
import { resizePrimaryPack } from "./resizePrimaryPack.js";
import { buildFoldedCartonBundle } from "./foldedCarton.js";
import { optimizeKdfBundleCount } from "./kdf.js";
import { multiDimensionalAnalysis } from "./multiDimensional.js";
import { mckeeBaseStrengthImperial, loadsHigh, safetyMargin } from "./compression.js";

// --- Scenario: carton on a Euro pallet (metric, mm / kg) ---------------
const carton = {
  length: 400,
  width: 300,
  height: 250,
  weight: 5,
  allowedVertical: ["height"], // carton may only stand on its base
};

const euroPallet = {
  length: 1200,
  width: 800,
  deckHeight: 144,
  maxHeight: 1800,
  maxWeight: 1000,
};

console.log("=== Build a Pallet: carton on Euro pallet ===");
console.log("Carton:", carton);
console.log("Pallet:", euroPallet);
console.log();

const solutions = optimizePallet(carton, euroPallet, { objective: "totalCount", topN: 5 });

console.log(
  `${"strategy".padEnd(24)}${"per layer".padEnd(11)}${"layers".padEnd(8)}${"total".padEnd(8)}${"weight(kg)".padEnd(12)}${"area eff.".padEnd(11)}cube eff.`
);
for (const s of solutions) {
  console.log(
    s.strategy.padEnd(24) +
      String(s.perLayer).padEnd(11) +
      String(s.layers).padEnd(8) +
      String(s.totalCount).padEnd(8) +
      s.totalWeight.toFixed(1).padEnd(12) +
      `${(s.areaEfficiency * 100).toFixed(1)}%`.padEnd(11) +
      `${(s.cubeEfficiency * 100).toFixed(1)}%`
  );
}

// --- Compression strength check on the winning solution -----------------
const best = solutions[0];
const perimeterIn = (2 * (carton.length + carton.width)) / 25.4; // mm -> in
const caliperMils = 40; // typical single-wall board caliper
const ectLbIn = 40; // typical 32 ECT-ish single wall board

const baseStrengthLb = mckeeBaseStrengthImperial({
  ectLbIn,
  caliperMils,
  perimeterIn,
});

const caseWeightLb = carton.weight * 2.20462;
const weightOnBottomCase = caseWeightLb * (best.layers - 1);

console.log();
console.log("=== Compression check (bottom case of tallest stack) ===");
console.log(`Base strength (McKee, imperial): ${baseStrengthLb.toFixed(1)} lb`);
console.log(`Loads high (raw, no derating):   ${loadsHigh(baseStrengthLb, caseWeightLb)}`);
console.log(`Weight actually stacked above:   ${weightOnBottomCase.toFixed(1)} lb (${best.layers - 1} cases)`);
console.log(`Safety margin:                   ${safetyMargin(baseStrengthLb, weightOnBottomCase).toFixed(0)}%`);
console.log();
console.log(
  "Note: this uses the raw McKee formula only — no production/environmental factor chain yet (Phase 2)."
);

// --- Scenario: Create a Case — a small jar packed into a new case -------
const jar = {
  length: 70,
  width: 70,
  height: 120,
  weight: 0.3,
  allowedVertical: ["height"],
};

console.log();
console.log("=== Create a Case: jar -> new case -> Euro pallet ===");
console.log("Primary pack:", jar);

// 1.5mm single-wall corrugated caliper, added to both sides of each axis
// (matches CapePack's Inside/Outside Dimensions + Thickness model).
const caseSolutions = optimizeCase(jar, euroPallet, { maxPerCase: 24, caseThickness: 1.5, topN: 5 });

console.log(
  `${"case OD (LxWxH mm)".padEnd(21)}${"jars/case".padEnd(11)}${"cases/pallet".padEnd(14)}${"total jars".padEnd(12)}cube eff.`
);
for (const r of caseSolutions) {
  const { length, width, height } = r.caseDimensions;
  console.log(
    `${length}x${width}x${height}`.padEnd(21) +
      String(r.primaryPerCase).padEnd(11) +
      String(r.palletSolution.totalCount).padEnd(14) +
      String(r.totalPrimaryUnits).padEnd(12) +
      `${(r.palletSolution.cubeEfficiency * 100).toFixed(1)}%`
  );
}

// --- Scenario: Fill a Stock Case — same jar into an existing case size --
const mediumStockCase = { length: 400, width: 300, height: 250, weight: 0.3, maxWeight: 20 };

console.log();
console.log("=== Fill a Stock Case: jar -> fixed 400x300x250 case -> Euro pallet ===");

const fillResults = fillStockCase(jar, mediumStockCase, euroPallet, { topN: 5 });

console.log(
  `${"grid (nx,ny,nz)".padEnd(18)}${"jars/case".padEnd(11)}${"fill eff.".padEnd(11)}${"cases/pallet".padEnd(14)}total jars`
);
for (const r of fillResults) {
  const { nx, ny, nz } = r.orientation.grid;
  console.log(
    `${nx}x${ny}x${nz}`.padEnd(18) +
      String(r.primaryPerCase).padEnd(11) +
      `${(r.fillEfficiency * 100).toFixed(1)}%`.padEnd(11) +
      String(r.palletSolution.totalCount).padEnd(14) +
      String(r.totalPrimaryUnits)
  );
}

// --- Scenario: Resize a Primary Pack — vary the jar's diameter/height ---
console.log();
console.log("=== Resize a Primary Pack: jar dimensions vary -> new case each time -> Euro pallet ===");

const resizeResults = resizePrimaryPack(
  jar,
  {
    length: { minus: 5, plus: 5, increment: 5 }, // 65, 70, 75mm
    width: { minus: 5, plus: 5, increment: 5 },
    height: { minus: 10, plus: 10, increment: 10 }, // 110, 120, 130mm
  },
  euroPallet,
  { varyWeight: true, caseOptions: { maxPerCase: 24, caseThickness: 1.5 }, topN: 5 }
);

console.log(
  `${"primary LxWxH".padEnd(18)}${"Δ vs base".padEnd(16)}${"case OD".padEnd(16)}${"total jars"}`
);
for (const r of resizeResults) {
  const { length, width, height } = r.primary;
  const d = r.dimensionalChange;
  const c = r.caseResult.caseDimensions;
  console.log(
    `${length}x${width}x${height}`.padEnd(18) +
      `${d.length >= 0 ? "+" : ""}${d.length},${d.width >= 0 ? "+" : ""}${d.width},${d.height >= 0 ? "+" : ""}${d.height}`.padEnd(16) +
      `${c.length}x${c.width}x${c.height}`.padEnd(16) +
      String(r.totalPrimaryUnits)
  );
}

// --- Scenario: Pinwheel pattern — ISO pallet where l+w divides evenly ---
console.log();
console.log("=== Pinwheel check: 300x250 case on 1100x1100 ISO pallet ===");

const isoPallet = { length: 1100, width: 1100, deckHeight: 150, maxHeight: 1800, maxWeight: 1500 };
const pinwheelCase = { length: 300, width: 250, height: 200, weight: 8, allowedVertical: ["height"] };

const pinwheelSolutions = optimizePallet(pinwheelCase, isoPallet, { objective: "totalCount", topN: 5 });
console.log(`${"strategy".padEnd(14)}${"per layer".padEnd(11)}${"area eff."}`);
for (const s of pinwheelSolutions) {
  console.log(s.strategy.padEnd(14) + String(s.perLayer).padEnd(11) + `${(s.areaEfficiency * 100).toFixed(1)}%`);
}

// --- Scenario: Pack Folded Cartons — flat carton -> bundle -> new case ---
console.log();
console.log("=== Pack Folded Cartons: flat carton -> bundle -> new case -> Euro pallet ===");

const foldedCarton = {
  length: 250,
  width: 180,
  weight: 0.05,
  boardThickness: 0.5,
  fluffFactor: 1.3, // user-supplied; not a CapePack auto-population value
};
const cartonsPerBundle = 50;
const bundle = buildFoldedCartonBundle(foldedCarton, cartonsPerBundle);
console.log("Bundle geometry:", bundle);

const foldedCaseSolutions = optimizeCase(bundle, euroPallet, { maxPerCase: 24, caseThickness: 1.5, topN: 3 });
console.log(
  `${"case (LxWxH mm)".padEnd(20)}${"bundles/case".padEnd(14)}${"cases/pallet".padEnd(14)}${"total bundles".padEnd(15)}total cartons`
);
for (const r of foldedCaseSolutions) {
  const { length, width, height } = r.caseDimensions;
  console.log(
    `${length}x${width}x${height}`.padEnd(20) +
      String(r.primaryPerCase).padEnd(14) +
      String(r.palletSolution.totalCount).padEnd(14) +
      String(r.totalPrimaryUnits).padEnd(15) +
      String(r.totalPrimaryUnits * cartonsPerBundle)
  );
}

// --- Scenario: Palletize Knocked-Down Flat — bundle count search --------
console.log();
console.log("=== KDF: flat blank -> bundle (count searched) -> Euro pallet directly ===");

const flatblank = { length: 500, width: 400, weight: 0.3, thickness: 4 };
const kdfResults = optimizeKdfBundleCount(flatblank, { min: 50, max: 150 }, euroPallet, { topN: 5 });
console.log(`${"bundle count".padEnd(14)}${"bundle height".padEnd(15)}${"bundles/pallet".padEnd(16)}total flatblanks`);
for (const r of kdfResults) {
  console.log(
    String(r.bundleCount).padEnd(14) +
      `${r.bundle.height}mm`.padEnd(15) +
      String(r.palletSolution.totalCount).padEnd(16) +
      String(r.totalFlatblanks)
  );
}

// --- Scenario: Multi-Dimensional Analysis — mixing orientations ---------
console.log();
console.log("=== Multi-Dimensional Analysis: mixing layer orientations beats any single one ===");

const mdBox = { length: 200, width: 300, height: 500, weight: 5, allowedVertical: ["length", "width", "height"] };
const mdPallet = { length: 1200, width: 800, deckHeight: 0, maxHeight: 1200, maxWeight: 100000 };

const mdUniform = optimizePallet(mdBox, mdPallet, { objective: "totalCount", topN: 1 });
console.log(`Best uniform-orientation solution: ${mdUniform[0].totalCount} units (vertical=${mdUniform[0].vertical}, ${mdUniform[0].perLayer}/layer x ${mdUniform[0].layers} layers)`);

const mdMixed = multiDimensionalAnalysis(mdBox, mdPallet, {});
console.log(`Multi-dimensional mix:            ${mdMixed.totalCount} units, using:`);
for (const t of mdMixed.layerMix) {
  console.log(`  ${t.layers}x layer(s) @ vertical=${t.vertical}, h=${t.h}mm, ${t.perLayer}/layer`);
}
