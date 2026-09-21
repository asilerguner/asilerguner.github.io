import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  optimizePallet,
  optimizeCase,
  optimizeCaseWithInnerPack,
  fillStockCase,
  resizePrimaryPack,
  buildBoxLayout,
  mckeeBaseStrengthImperial,
  mckeeBaseStrengthMetric,
  MCKEE_COEFFICIENT_IMPERIAL,
  MCKEE_COEFFICIENT_METRIC,
  MCKEE_EXPONENT_CALIPER,
  MCKEE_EXPONENT_PERIMETER,
  loadsHigh,
  safetyMargin,
  applyStrengthFactorChain,
  packPalletsIntoTruck,
  buildFoldedCartonBundle,
  optimizeFoldedCartonBundleCount,
  optimizeKdfBundleCount,
  evaluateKdfFormula,
  multiDimensionalAnalysis,
  applyFormatLoadAdditions,
  packPalletsOntoMasterBase,
  flipLayer180,
  spreadLayer,
  storageEnvironmentFactor,
  combinedEdgeCrushRingCrush,
  RING_CRUSH_BURST_THRESHOLD_LB,
  RING_CRUSH_LOW_BURST_ADJUSTMENT,
  RING_CRUSH_HIGH_BURST_ADJUSTMENT,
  stfiSingleWall,
  loadMultiSizedProducts,
  buildMultiSizeBoxLayout,
  evaluateCustomFormula,
} from "../packing-engine/src/index.js";

let alternateLayers = false;
// Set by "Apply Format Load Additions"; cleared whenever a different
// solution is selected. Truck Analysis and Master Pallet Base use these
// adjusted numbers instead of the raw solution when present.
let formatLoadAdjustment = null;

// --- Settings (docs section 14) ---------------------------------------------
// "To make these options site-wide, use the Settings menu." Persisted in
// localStorage since this is a per-browser UI preference, not shared state —
// same reasoning as every other localStorage use in this project.
const SETTINGS_KEY = "simpallet-settings";
const LEGACY_SETTINGS_KEY = "stackworks-settings"; // pre-rename key — read as a fallback so existing settings aren't silently lost
// User ask: "show the imported settings folder, so we know that we are
// connected to that" — see renderLastImportInfo's own comment (near
// openManageDatabaseView) for why this remembers a FILE name, not a real
// folder. Persisted the same way as SETTINGS_KEY above (localStorage,
// per-browser).
const LAST_IMPORT_KEY = "simpallet-last-import";
const DEFAULT_SETTINGS = {
  units: "metric",
  objective: "totalCount",
  // CapePack's own "Default Environmental Factors" screen — set once here,
  // applied to every new analysis's Compression Strength section instead of
  // re-entering Board Grade/Case Type/storage conditions each time.
  strengthEct: 40,
  strengthCaliper: 40,
  strengthCaseType: 1,
  // Printing/Partition/Fluting orientation defaults — real CapePack's own
  // Default Environmental Factors screen (user-supplied screenshot) sets
  // these three alongside Case Type; Case Proportion deliberately has no
  // default here, matching that same real screen (see
  // applyStrengthFactorChain's own note on why it stays a manual per-case
  // pick instead).
  strengthPrinting: 1,
  strengthPartition: 1,
  strengthFluting: 1,
  // Real screen's "Internal Support"/"Pallets Stacked" — extend the
  // existing weight-above-bottom-case calculation (see the r-calc handler)
  // rather than any of the six Storage Environment factors. Neutral
  // defaults (0 lb, 1 pallet high) so this is a pure additive extension:
  // an existing analysis with these left untouched gets byte-identical
  // results to before this field existed.
  strengthInternalSupportLb: 0,
  strengthPalletsStacked: 1,
  // Real screen's "Safety Margin Required" toggle+percentage — a minimum
  // threshold checked against the app's own already-existing safetyMargin()
  // result, not a new formula. Off by default (matches the real screen's
  // own unchecked/0% default).
  strengthSafetyMarginEnabled: false,
  strengthSafetyMarginRequiredPct: 0,
  strengthProductionPct: 0,
  strengthSeasonalPct: 0,
  strengthHumidity: 55,
  strengthDays: 0,
  strengthOrientation: "base",
  strengthStacking: "stacked",
  strengthOverhang: 0,
  strengthSurface: "solid",
  // Real CapePack's own "Custom Formula Entry" (Strength > Database >
  // Formulae > "Edit your Custom Formulae") — null until the user saves
  // one. Shape: { units, term1: {combineOp, value, adjOp, adjValue},
  // connector1, term2: {...}, connector2, term3: {...} } — see
  // evaluateCustomFormula (packing-engine) for what actually runs it.
  // `units` records which Report Units it was saved under, since
  // McKee's own Imperial/Metric coefficients aren't interchangeable
  // (see compression.js's own honesty note) — only offered for use
  // on the Report step when it matches the current setting.
  customFormula: null,
  // User ask ("fill in the gaps" -> CO2/cost): this app's own feature, no
  // CapePack equivalent (same disclosure pattern as Inner Pack — see
  // co2CostEstimateHtml). Deliberately just two plain user-entered
  // multipliers against the one gross-load-weight figure every workflow
  // already computes, not a fabricated freight/material-cost formula.
  // null (not 0) by default so an unconfigured analysis shows nothing here
  // instead of a misleading "$0.00".
  costPerKg: null,
  co2PerKg: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(LEGACY_SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = loadSettings();

// Every existing settings-save site used to inline this try/catch around a
// raw localStorage write; now they all call this instead — same behavior,
// just de-duplicated.
function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage can throw (private browsing, storage disabled) — settings
    // still apply for the rest of this session, just won't persist.
  }
}

// Unit conversion for Report/PDF display only — input fields deliberately
// stay in mm/kg, matching CapePack's own separation between input entry and
// its Report Units dropdown (see the Settings modal's own note).
const MM_PER_IN = 25.4;
const KG_PER_LB = 0.45359237;

function fmtLength(mm) {
  return settings.units === "imperial" ? `${(mm / MM_PER_IN).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}
function fmtWeight(kg) {
  return settings.units === "imperial" ? `${(kg / KG_PER_LB).toFixed(2)} lb` : `${kg.toFixed(1)} kg`;
}

// Board Grade (ECT/Caliper) unit conversion — the McKee formula genuinely
// has two distinct forms (see compression.js), not just a display
// difference: real CapePack's own Strength Database has its own dedicated
// Imperial/Metric selector for exactly this reason (separate from the
// general Report Units dropdown, which only reformats display values). This
// app ties it to the same Report Units setting instead of adding a second
// toggle — a deliberate simplification, not a claim CapePack's own UI
// works this way. Standard unit conversion (1 lbf/in = 0.175127 kN/m per
// lbf=4.44822N, in=0.0254m; 1 mil = 0.0254mm) — not proprietary data.
const KNM_PER_LBIN = 0.175127;
const MM_PER_MIL = 0.0254;

// units defaults to the global setting, but takes an explicit override so
// the Settings form's own unit dropdown (which can change before Save is
// clicked, independent of the global) can convert against ITS OWN current
// choice rather than a stale global value.
function ectLbInToDisplay(ectLbIn, units = settings.units) {
  return units === "metric" ? ectLbIn * KNM_PER_LBIN : ectLbIn;
}
function caliperMilsToDisplay(caliperMils, units = settings.units) {
  return units === "metric" ? caliperMils * MM_PER_MIL : caliperMils;
}
// Inverse of the above — settings.strengthEct/strengthCaliper are always
// stored canonically in lb/in and mils (matching the board-grades library's
// own source units) regardless of Report Units, so a later unit switch
// never silently misinterprets an already-saved number.
function ectDisplayToLbIn(displayValue, units = settings.units) {
  return units === "metric" ? displayValue / KNM_PER_LBIN : displayValue;
}
function caliperDisplayToMils(displayValue, units = settings.units) {
  return units === "metric" ? displayValue / MM_PER_MIL : displayValue;
}

// strengthInternalSupportLb (and the report step's own internal-support
// field) are stored canonically in lb, same reasoning as ECT/Caliper above.
function weightLbToDisplay(lb, units = settings.units) {
  return units === "metric" ? lb * KG_PER_LB : lb;
}
function weightDisplayToLb(displayValue, units = settings.units) {
  return units === "metric" ? displayValue / KG_PER_LB : displayValue;
}

function updateStrengthUnitLabels() {
  const ectLabel = settings.units === "metric" ? "ECT (kN/m)" : "ECT (lb/in)";
  const calLabel = settings.units === "metric" ? "Caliper (mm)" : "Caliper (mils)";
  const supportLabel = settings.units === "metric" ? "Internal Support (kg)" : "Internal Support (lb)";
  for (const id of ["r-ect-label", "set-ect-label"]) $(id).textContent = ectLabel;
  for (const id of ["r-cal-label", "set-cal-label"]) $(id).textContent = calLabel;
  for (const id of ["r-internalsupport-label", "set-internalsupport-label"]) $(id).textContent = supportLabel;
}

// Two more physical conversions, same "standard, publicly documented,
// not proprietary" footing as KNM_PER_LBIN/MM_PER_MIL above — needed for
// Databases fields the rest of this app didn't have a unit-kind for yet:
// burst test (a pressure) and basis weight (a paper-industry areal
// density). Burst test: real CapePack's own Metric Formulae screen
// (user-supplied screenshot) reads "For up to 14 kg Burst Test" where
// the Imperial screen's own equivalent is "up to 200 lb" — 200 psi in
// kgf/cm² (the paper-industry's actual metric burst-test convention,
// not kPa as first guessed here) is 200 x 0.45359237/2.54² = 14.061,
// matching "14" exactly. 1 lb/1000ft² = 453.59237g / 92.90304m² =
// 4.88243 g/m² (gsm) — not directly confirmed by a real screen, but the
// standard paper-industry conversion.
const KGF_PER_CM2_PER_PSI = 0.070307;
const GSM_PER_LBMSF = 4.88243;

// Generic unit-kind registry for the Databases library tables/forms (see
// renderLibraryTable/showLibraryForm) — every schema field tagged with a
// `unitKind` gets its header/label suffix and its shown value converted
// automatically to whatever settings.units currently is, instead of
// always showing this app's own canonical storage unit regardless of the
// user's global preference (the actual bug report this was built for:
// Board Grades/Material Factors were Imperial-only with zero conversion,
// and pallets/trucks/stock-cases/etc. showed canonical mm/kg even under
// Imperial). Two families, matching how this app already stores each:
// - length/weight: this app's own general-purpose fields, canonically
//   mm/kg (matching fmtLength/fmtWeight above) — convert to in/lb.
// - edgeCrush/caliper/pressure/basisWeight: CapePack's own Strength/
//   Material Factors Database fields, canonically stored in their real
//   Imperial source units (lb/in, in, lb/in², lb/msf — see
//   ectLbInToDisplay's own note on why) — convert to kN/m/mm/kg·cm⁻²/g·m⁻².
const UNIT_KINDS = {
  length: {
    metricSuffix: "mm",
    imperialSuffix: "in",
    toDisplay: (mm, units) => (units === "imperial" ? mm / MM_PER_IN : mm),
    toCanonical: (v, units) => (units === "imperial" ? v * MM_PER_IN : v),
  },
  weight: {
    metricSuffix: "kg",
    imperialSuffix: "lb",
    toDisplay: (kg, units) => (units === "imperial" ? kg / KG_PER_LB : kg),
    toCanonical: (v, units) => (units === "imperial" ? v * KG_PER_LB : v),
  },
  edgeCrush: {
    metricSuffix: "kN/m",
    imperialSuffix: "lb/in",
    toDisplay: (lbIn, units) => (units === "metric" ? lbIn * KNM_PER_LBIN : lbIn),
    toCanonical: (v, units) => (units === "metric" ? v / KNM_PER_LBIN : v),
  },
  caliper: {
    metricSuffix: "mm",
    imperialSuffix: "in",
    toDisplay: (inches, units) => (units === "metric" ? inches * MM_PER_IN : inches),
    toCanonical: (v, units) => (units === "metric" ? v / MM_PER_IN : v),
  },
  pressure: {
    metricSuffix: "kg/cm²",
    imperialSuffix: "lb/in²",
    toDisplay: (psi, units) => (units === "metric" ? psi * KGF_PER_CM2_PER_PSI : psi),
    toCanonical: (v, units) => (units === "metric" ? v / KGF_PER_CM2_PER_PSI : v),
  },
  basisWeight: {
    metricSuffix: "g/m²",
    imperialSuffix: "lb/msf",
    toDisplay: (lbMsf, units) => (units === "metric" ? lbMsf * GSM_PER_LBMSF : lbMsf),
    toCanonical: (v, units) => (units === "metric" ? v / GSM_PER_LBMSF : v),
  },
};
function unitKindSuffix(unitKind, units = settings.units) {
  const k = UNIT_KINDS[unitKind];
  return units === "metric" ? k.metricSuffix : k.imperialSuffix;
}

// 999999 is this app's existing sentinel for "and over" on an open-ended
// bracket boundary (see storage-environment-factors.json's own days/
// overhang brackets, and efficiency-factors' own "Over 200 lb" row) — not
// a real physical quantity, so it must never be scaled by a unit
// conversion (999999 psi "converted" to kPa reads as a wildly different,
// meaningless number). Guards both directions symmetrically so a value
// showing as the sentinel also SAVES back as the sentinel, not a
// converted one.
function unitKindToDisplay(unitKind, canonicalValue, units = settings.units) {
  if (canonicalValue === 999999) return canonicalValue;
  return UNIT_KINDS[unitKind].toDisplay(canonicalValue, units);
}
function unitKindToCanonical(unitKind, displayValue, units = settings.units) {
  if (displayValue === 999999) return displayValue;
  return UNIT_KINDS[unitKind].toCanonical(displayValue, units);
}

// Maps our internal pattern-search strategy names to CapePack's own real
// Loading Patterns terminology (confirmed directly in a live Cape Pack
// account's "Loading Patterns" picker: Column, Interlock, Trilock, Spiral,
// Diagonal, Expanded Spiral). `interlockPattern` (added after a user
// supplied real Cape Pack output whose "Interlock" row this engine
// couldn't reach at all — see docs/ARCHITECTURE.md) reproduces that exact
// result, so it earns the real name. `guillotineSplitPattern` turned out
// NOT to be the same technique once interlockPattern existed to compare
// against — guillotine only fills genuine leftover scrap after maximizing
// the main grid, so it often ties column exactly (confirmed: identical
// 63/90%/84% output to column in the same verification) — relabeled to
// its own honest name rather than borrowing "Interlock".
//
// `pinwheelPattern` used to borrow "Spiral" here too (same rotating-
// quadrant idea, and no dedicated Spiral implementation existed yet) —
// same relabeling now that trilockPattern/spiralPattern/diagonalPattern/
// expandedSpiralPattern exist as their own real implementations (real
// diagrams found in Esko's own Cape Pack Quick Start Guide, "Select
// Pallet Pattern Styles Screen" — Esko's exact internal geometry for
// these 4 isn't publicly documented anywhere checked, so these are real,
// valid, disclosed good-faith implementations in that diagram's spirit,
// not verified reproductions — see each pattern file's own doc comment
// and packing-engine/docs/ARCHITECTURE.md). spiralPattern (pinwheel's own
// block plus real margin-filling) is the more complete bearer of the real
// "Spiral" name now, so plain pinwheelPattern gets its own honest label
// instead, same as guillotineSplitPattern did.
const PATTERN_DISPLAY_NAMES = {
  column: "Column",
  pinwheel: "Pinwheel",
  interlock: "Interlock",
  trilock: "Trilock",
  spiral: "Spiral",
  diagonal: "Diagonal",
  "expanded-spiral": "Expanded Spiral",
  "guillotine-split-length": "Guillotine Split (length)",
  "guillotine-split-width": "Guillotine Split (width)",
};
function patternLabel(strategy) {
  return PATTERN_DISPLAY_NAMES[strategy] ?? strategy;
}

// --- Zoom +/- buttons, shared by every 3D view in this file ----------------
// User ask: "implement zoom in zoom out buttons + - in all 3d views."
// Moves the camera along its current line to/from the OrbitControls
// target by a fixed scale factor, rather than reaching into OrbitControls'
// own (largely undocumented/version-fragile) internal dolly methods — a
// plain camera.position + controls.update() works identically regardless
// of the three.js version, and is exactly what scroll-to-zoom already
// does under the hood conceptually. One MIN_ZOOM_DISTANCE floor (in scene
// units, mm) stops repeated zoom-ins from ever collapsing the camera onto
// its own target.
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
const MIN_ZOOM_DISTANCE = 10;
function zoomCameraBy(camera, controls, factor) {
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(Math.max(offset.length() * factor, MIN_ZOOM_DISTANCE));
  camera.position.copy(controls.target).add(offset);
  controls.update();
}
// Appends a small "+"/"-" button pair into `container` (absolutely
// positioned in its bottom-right corner — container gets position:relative
// if it doesn't already have it, same non-visual-side-effect reasoning as
// this file's other min-width:0/box-sizing defensive tweaks). Safe to call
// every time a lazily-rebuilt scene (Fill Wizard, Layer Editor, ...) tears
// down and recreates its container's own innerHTML — this only ever runs
// right after that rebuild, so there's never a stale/duplicate pair left
// behind from a previous open.
function addZoomControls(container, camera, controls) {
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const wrap = document.createElement("div");
  wrap.className = "zoom-controls";
  const makeBtn = (label, ariaLabel, factor) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zoom-btn";
    btn.textContent = label;
    btn.setAttribute("aria-label", ariaLabel);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      zoomCameraBy(camera, controls, factor);
    });
    return btn;
  };
  wrap.appendChild(makeBtn("+", "Zoom in", ZOOM_IN_FACTOR));
  wrap.appendChild(makeBtn("−", "Zoom out", ZOOM_OUT_FACTOR));
  container.appendChild(wrap);
}

// --- three.js scene setup -------------------------------------------------
const wrap = document.getElementById("canvas-wrap");
const scene = new THREE.Scene();
// Was a light gray (0xeef1f5), then pure white (0xffffff, to match real
// CapePack's own plain white 3D backgrounds) — user follow-up: "I think it
// is better to make the background of 3D views in grey scale for better
// visibility," since white box faces/pallet parts/dimension-label pills
// were blending into a pure white background. Settled on a light neutral
// gray (0xdcdcdc) as a middle ground: enough contrast to tell white
// geometry apart from the background, still light/unobtrusive rather than
// a return to the original darker 0xeef1f5. Same change applied to all 8
// other Three.js scenes in this file (Case Detail, Truck Analysis, Master
// Pallet Base, Fill Wizard, Layer Editor, Graphic/Cases-and-Trays
// previews) plus the two matching CSS canvas-wrap backgrounds
// (index.html) for full consistency.
scene.background = new THREE.Color(0xdcdcdc);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
// preserveDrawingBuffer so the canvas can be captured via toDataURL() for
// the PDF report snapshot without needing to time it against the render loop.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.domElement.style.display = "none"; // hidden until a solution is calculated
wrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
addZoomControls(wrap, camera, controls);

// Real CapePack renders literal dimension numbers on the 3D view's own
// edges (user-supplied screenshots) — CSS2DRenderer overlays real HTML on
// top of the WebGL canvas, screen-projected from a 3D position, so labels
// track the camera as it orbits. pointerEvents:none keeps OrbitControls
// (bound to renderer.domElement, not this overlay) working untouched.
const cssRenderer = new CSS2DRenderer();
cssRenderer.domElement.style.position = "absolute";
cssRenderer.domElement.style.top = "0";
cssRenderer.domElement.style.left = "0";
cssRenderer.domElement.style.pointerEvents = "none";
cssRenderer.domElement.style.display = "none"; // mirrors renderer.domElement's own initial state above
wrap.appendChild(cssRenderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(1000, 1500, 1000);
scene.add(dir);

let palletGroup = new THREE.Group();
let boxesGroup = new THREE.Group();
let dimensionLabelsGroup = new THREE.Group();
scene.add(palletGroup, boxesGroup, dimensionLabelsGroup);

function resize() {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  cssRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(wrap);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  cssRenderer.render(scene, camera);
}

// Pallet-space (x=length, y=width, z=stack height) -> three.js (X, Y-up, Z depth)
function toScene(x, y, z) {
  return new THREE.Vector3(x, z, y);
}

// Shared by both the pallet view above and the Secondary Pack detail view
// below — a small styled label (see .dimension-label, index.html) wrapping
// plain text (fmtLength() output, never raw HTML) in a CSS2DObject.
function makeDimensionLabel(text) {
  const div = document.createElement("div");
  div.className = "dimension-label";
  div.textContent = text;
  return new CSS2DObject(div);
}

// A real dimension line: a line segment from `from` to `to`, with a short
// tick mark at each end perpendicular to the line (`tickDir`, a unit
// vector) — the standard architectural/CAD convention for "this line
// measures exactly this span," which a floating label alone doesn't
// convey. Shared by both 3D views below so every dimension line in the
// app looks and behaves the same way.
const DIMENSION_LINE_COLOR = 0x3b6fe0;
function makeDimensionLine(from, to, tickDir, tickLen) {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: DIMENSION_LINE_COLOR });
  const half = tickDir.clone().multiplyScalar(tickLen / 2);
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), mat));
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from.clone().sub(half), from.clone().add(half)]), mat));
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([to.clone().sub(half), to.clone().add(half)]), mat));
  return group;
}

// Secondary Pack (case) detail view — real CapePack shows this alongside
// the main pallet view (user-supplied screenshots), not merged into it: a
// dedicated look at ONE case with its primary-pack grid always visible
// inside, independent of the pallet view's own Box Opacity slider — this
// view's whole purpose is showing the interior, so it doesn't need a
// separate toggle to do so. Same persistent, resize-observed setup as the
// main scene above (not ensureCasesTraysScene's lazy-recreate-per-modal-
// open pattern, see that function's own comment) since both views need to
// stay visible together, not open one at a time.
const caseDetailWrap = document.getElementById("case-canvas-stage");
const caseDetailScene = new THREE.Scene();
caseDetailScene.background = new THREE.Color(0xdcdcdc);
const caseDetailCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
const caseDetailRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
caseDetailWrap.appendChild(caseDetailRenderer.domElement);
const caseDetailControls = new OrbitControls(caseDetailCamera, caseDetailRenderer.domElement);
caseDetailControls.target.set(0, 0, 0);
addZoomControls(caseDetailWrap, caseDetailCamera, caseDetailControls);
// No visibility-toggle mirroring needed here unlike the pallet view's own
// cssRenderer above — showCaseDetail() already hides the OUTER
// #case-canvas-wrap, and a hidden ancestor hides every descendant
// regardless of its own positioning.
const caseDetailCssRenderer = new CSS2DRenderer();
caseDetailCssRenderer.domElement.style.position = "absolute";
caseDetailCssRenderer.domElement.style.top = "0";
caseDetailCssRenderer.domElement.style.left = "0";
caseDetailCssRenderer.domElement.style.pointerEvents = "none";
caseDetailWrap.appendChild(caseDetailCssRenderer.domElement);
caseDetailScene.add(new THREE.AmbientLight(0xffffff, 0.8));
const caseDetailDirLight = new THREE.DirectionalLight(0xffffff, 0.7);
caseDetailDirLight.position.set(300, 400, 300);
caseDetailScene.add(caseDetailDirLight);
const caseDetailGroup = new THREE.Group();
caseDetailScene.add(caseDetailGroup);

function resizeCaseDetail() {
  const w = caseDetailWrap.clientWidth;
  const h = caseDetailWrap.clientHeight;
  if (w === 0 || h === 0) return;
  caseDetailRenderer.setSize(w, h);
  caseDetailCssRenderer.setSize(w, h);
  caseDetailCamera.aspect = w / h;
  caseDetailCamera.updateProjectionMatrix();
}
resizeCaseDetail();
new ResizeObserver(resizeCaseDetail).observe(caseDetailWrap);

function animateCaseDetail() {
  requestAnimationFrame(animateCaseDetail);
  caseDetailControls.update();
  caseDetailRenderer.render(caseDetailScene, caseDetailCamera);
  caseDetailCssRenderer.render(caseDetailScene, caseDetailCamera);
}
animateCaseDetail();

function renderPallet(pallet) {
  palletGroup.clear();
  // pallet.length/width may be overhang-widened for the box search (see
  // searchFootprintPallet) — the mesh itself should always be the TRUE
  // physical pallet size. Overhang is symmetric per axis, so the true
  // pallet's center coincides exactly with the (possibly wider) search
  // rectangle's center — only the box SIZE needs the true dims, not the
  // position.
  const trueLength = pallet.trueLength ?? pallet.length;
  const trueWidth = pallet.trueWidth ?? pallet.width;
  const geo = new THREE.BoxGeometry(trueLength, pallet.deckHeight || 10, trueWidth);
  const mat = new THREE.MeshStandardMaterial({ color: palletColor });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pallet.length / 2, (pallet.deckHeight || 10) / 2, pallet.width / 2);
  palletGroup.add(mesh);

  // THREE.GridHelper is built centered on its own local origin — the
  // pallet mesh above is NOT centered on the origin (it spans X:[0,length],
  // Z:[0,width], matching toScene()'s convention), so leaving the grid at
  // its default (0,0) position put half of it off in the wrong direction
  // and let it visibly run out before reaching the far side of the pallet/
  // load — confirmed live (screenshot showed the grid ending well short of
  // the box on 3 of its 4 sides). Re-centering on the pallet's own true
  // center fixes this without needing a bigger grid.
  // Colors darkened from their original 0xcccccc/0xe5e5e5 — user report:
  // "the gray surfaces and lines between the boxes disappear when
  // rotating the model." Thin, unlit GridHelper line geometry viewed at a
  // shallow/grazing angle is always harder to see than head-on (an
  // inherent property of 1px line rendering, not a z-fighting bug), and
  // the scene background just above went from a light gray (0xeef1f5) to
  // pure white per the same user's own prior request — that shrank the
  // grid's own contrast margin against its background, making the
  // existing shallow-angle weakness much more noticeable. A darker gray
  // keeps real, usable contrast against white at every angle.
  const grid = new THREE.GridHelper(Math.max(pallet.length, pallet.width) * 1.6, 24, 0x999999, 0xc2c2c2);
  grid.position.set(pallet.length / 2, -0.5, pallet.width / 2);
  palletGroup.add(grid);
}

// User-controlled via the "Box Opacity" slider over the 3D view — lets you
// see the interior stacking pattern instead of just the outer shell.
let boxOpacity = 1;

// Set by the Pack Type Library picker (see "open-packtype-library" below).
// Only meaningful for the "pallet" workflow, where the rendered boxes ARE
// the primary/secondary pack itself — every other workflow's boxes are a
// designed corrugated CASE, which is genuinely rectangular regardless of
// what shape is packed inside it, so "box" is always correct there.
let primaryPackBaseShape = "box";
// Set alongside primaryPackBaseShape ("custom") by a real Collada .ZAE
// import — { object, lengthMm, widthMm, heightMm } from parseZaeCollada, or
// null. The object is cloned once per box position in renderBoxes; the
// measured mm dims are the scale-1:1 reference, since a resize/multisize
// variant can ask for a different L/W/H than what was actually uploaded.
let primaryPackCustomShape = null;
// Case Content's own Fill Wizard pack type (Build a Pallet only) — a
// completely separate pick from primaryPackBaseShape above, which
// describes the OUTER Secondary Pack placed on the pallet; this
// describes whatever's declared to be INSIDE it, independently. Box vs
// cylinder only (no custom/Collada — see the plan's own Scope note).
let caseContentFillWizardShape = "box";
// Distinct from primaryPackBaseShape above: that one is a RENDERING
// grouping (any round-looking mesh, including Hex Jar and Oval Tube, which
// both carry baseShape "cylinder" in the shapes library despite not being
// round — see ROUND_BASE_SHAPES). This one gates the PACKING ENGINE's real
// hexagonal circle-packing (optimize.js box.shape: "cylinder"), which is
// only mathematically valid for a true circular footprint — so it's set
// from the shape library's own crossSection field ("circle" vs "hex"/
// "oval"), not from baseShape, and stays false for anything without a
// crossSection of exactly "circle" (custom/Collada shapes included, since
// those aren't guaranteed round even when the mesh looks cylindrical).
let primaryPackIsTrueCircle = false;

// CapePack's own "Custom Shapes" format (docs section 11.4/4.7: drag-and-
// drop a Collada .ZAE — a zipped .dae — into Databases > Custom Shapes, or
// inline from the Pack Type Library "if the required shape is not
// available"). Real geometry gets rendered; the packing math stays
// bounding-box based regardless, same as every other "planned" engineSupport
// shape already in this app — CapePack's own docs confirm this too (a
// Collada import still gets classified as one of its five base Shape Types).
// zaeBase64 here is the raw uploaded file, exactly as it'll be persisted —
// re-parsed on demand rather than caching a separate rendering-only format,
// so there's only ever one source of truth for what was actually uploaded.
async function parseZaeCollada(zaeBase64) {
  const JSZip = (await import("jszip")).default;
  const binStr = atob(zaeBase64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const zip = await JSZip.loadAsync(bytes);
  const daeName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".dae"));
  if (!daeName) throw new Error("No .dae file found inside this .zae archive.");
  const daeText = await zip.files[daeName].async("text");

  const collada = new ColladaLoader().parse(daeText, "");
  const box = new THREE.Box3().setFromObject(collada.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  // Collada scenes can be authored anywhere relative to their own origin —
  // recenter (in the model's own real-world-meter space, before the mm
  // rescale below) so it sits the same way the app's own procedural box/
  // cylinder meshes do: origin at the shape's own center, matching how
  // renderBoxes positions every mesh via its center point.
  collada.scene.position.sub(center);

  // ColladaLoader converts every file to real-world meters (confirmed live:
  // a 100mm-wide test box measured size.x === 0.1) — but this app's whole
  // 3D scene already uses raw mm values AS Three.js scene units (a 1200mm
  // pallet is a BoxGeometry of width 1200, not 1.2). Wrapping in a group
  // scaled ×1000 bridges that once, here, rather than as a special case
  // anywhere renderBoxes or the rest of the scene touches this object.
  const wrapper = new THREE.Group();
  wrapper.scale.setScalar(1000);
  wrapper.add(collada.scene);

  return {
    object: wrapper,
    // BoxGeometry(l, h, w) elsewhere in this file fixes the axis mapping:
    // X = Length, Y = Height (up), Z = Width.
    lengthMm: roundTo(size.x * 1000, 1),
    widthMm: roundTo(size.z * 1000, 1),
    heightMm: roundTo(size.y * 1000, 1),
  };
}

// STEP import (user ask: "in import option, we need to make .step is also
// possible as collada"). Uses occt-import-js — an Emscripten/WASM build of
// OpenCascade (the same engine real CAD tools use to read STEP) that runs
// entirely client-side, no server round-trip. Loaded from the SAME jsdelivr
// CDN this app's own importmap already uses for three/jszip, via the
// "/+esm" transform (occt-import-js itself ships as a plain UMD build with
// no ESM export path at all — confirmed live: a bare `import()` of its own
// dist file resolves to an empty module with nothing exported, since its
// only real export path is `module.exports`/AMD `define`, neither of which
// exist in a native ES module's own scope; jsdelivr's "+esm" endpoint
// re-wraps it into a real ES module, the same trick already relied on for
// jszip's own CDN import). Cached after first use (occtInstance) since
// initializing the WASM module has real, non-trivial cost — repeat STEP
// imports in one session reuse it rather than re-initializing from scratch
// every time.
//
// Known limitation, disclosed rather than silently assumed correct: STEP
// has no single universal up-axis convention the way Collada does (always
// Y-up) — some CAD systems author Z-up, and occt-import-js's own
// coordinate convention was only confirmed live against one real, roughly-
// cubic test fixture (a cube, where an axis swap wouldn't be visually
// detectable at all) — not a genuinely asymmetric real-world STEP export,
// so this app can't auto-detect which convention a given file used. Rather
// than guess, the "This file is Z-up" checkbox (Custom Shapes' own upload
// form) hands that judgment to the one person who can actually tell by
// looking at the result — the user — instead of leaving it silently wrong
// with no way to fix it.
let occtInstance = null;
async function getOcctInstance() {
  if (occtInstance) return occtInstance;
  const mod = await import("occt-import-js");
  const occtimportjs = mod.default;
  occtInstance = await occtimportjs({
    // occt-import-js's own WASM file lives beside its JS in the SAME dist
    // folder — locateFile tells the Emscripten loader where to fetch it
    // from, since it was loaded from jsdelivr's "+esm" transform URL, not
    // its own real package path, and can't infer this on its own.
    locateFile: (path) => `https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/${path}`,
  });
  return occtInstance;
}

async function parseStepFile(stepBase64, { zUp = false } = {}) {
  const binStr = atob(stepBase64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

  const occt = await getOcctInstance();
  const result = occt.ReadStepFile(bytes, null);
  if (!result.success || !result.meshes?.length) {
    throw new Error("No readable geometry found in this STEP file.");
  }

  // occt-import-js already triangulates every face for us (real B-rep
  // surfaces included, not just flat ones) — real-world-mm coordinates
  // confirmed live against a real STEP export (position values in the
  // hundreds, not fractional meters the way ColladaLoader's own output
  // is), so unlike parseZaeCollada above, no ×1000 rescale is needed here.
  const group = new THREE.Group();
  for (const mesh of result.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
    if (mesh.attributes.normal) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
    if (mesh.index) geometry.setIndex(Array.from(mesh.index.array));
    if (!mesh.attributes.normal) geometry.computeVertexNormals();
    const color = mesh.color ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]) : 0xb0b0b0;
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color })));
  }

  // User-driven Z-up correction (see this function's own doc comment above
  // for why this can't be auto-detected) — a plain -90° rotation about X,
  // the standard Z-up-to-Y-up conversion (what was the model's own Z axis
  // becomes this app's Y/Height axis). Applied BEFORE measuring the
  // bounding box below, so lengthMm/widthMm/heightMm reflect the corrected
  // orientation, not the raw uncorrected one.
  if (zUp) group.rotation.x = -Math.PI / 2;
  group.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  group.position.sub(center); // same "origin at the shape's own center" convention as parseZaeCollada above

  return {
    object: group,
    lengthMm: roundTo(size.x, 1),
    widthMm: roundTo(size.z, 1),
    heightMm: roundTo(size.y, 1),
  };
}

// Format-agnostic entry point every call site below uses instead of calling
// parseZaeCollada/parseStepFile directly — dispatches on the stored
// filename's own extension, so existing saved items (always .zae, from
// before STEP import existed) keep working unchanged with no stored
// "format" field needed. zUp only ever matters for the STEP branch —
// Collada already has one fixed, reliable up-axis convention, nothing to
// correct.
function parseCustomShapeFile(base64, filename, { zUp = false } = {}) {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".step") || lower.endsWith(".stp")) return parseStepFile(base64, { zUp });
  return parseZaeCollada(base64);
}

// renderInfo.shape: "box" | "cylinder" | "custom" — cylinder draws a round mesh
// inscribed in the same L x W x H bounding box the packing math actually
// uses (packing still treats it as its bounding box, per the shapes
// library's honest bounding-box-approximation note; this only changes what
// gets drawn). renderInfo.innerGrid, when present, draws a small nx x ny x
// nz grid of primary-pack meshes INSIDE each outer box — used for
// case-based workflows (Create a Case / Fill a Stock Case / Resize) where
// the boxes on the pallet are cases and the primary pack (e.g. bottles)
// lives inside them; only worth the extra geometry once boxes are actually
// see-through, so it's skipped entirely at full opacity.
const MAX_INNER_MESHES = 6000; // perf guard for very large loads

// Shared by renderBoxes' per-case inner-grid preview (main pallet view,
// many cases) and renderCaseDetail's own (dedicated Secondary Pack view,
// one case) — the box-vs-cylinder inner shape choice and cell-sizing math
// is identical in both places; only the positioning loop differs.
function innerGridCellGeometry(innerGrid, caseL, caseW, caseH) {
  const { nx, ny, nz } = innerGrid;
  const cellL = caseL / nx;
  const cellW = caseW / ny;
  const cellH = caseH / nz;
  const radius = (Math.min(cellL, cellW) / 2) * 0.82; // slight inset so round packs don't touch the case walls
  const geo =
    innerGrid.shape === "cylinder"
      ? new THREE.CylinderGeometry(radius, radius, cellH * 0.92, 12)
      : new THREE.BoxGeometry(cellL * 0.92, cellH * 0.92, cellW * 0.92);
  return { geo, cellL, cellW, cellH };
}

function renderBoxes(boxes, renderInfo = { shape: "box" }) {
  boxesGroup.clear();
  const isTransparent = boxOpacity < 1;
  // Checkerboard coloring (docs 4.8-adjacent): real Cape Pack Cloud
  // alternates two colors between neighboring boxes — purely so
  // individual boxes are visually distinguishable, offset between layers
  // in a brick-like pattern. This is NOT a rotation indicator (an earlier
  // guess, since corrected). checker===0 keeps using the existing "Change
  // Color" boxColor; checker===1 always gets this fixed accent color.
  // Two real screenshots have now shown two DIFFERENT "default" pairs at
  // different points in this app's history — dark charcoal gray + olive/
  // lime green first, then (this session, Create a Case's own Solution
  // Report) a distinctly blue + magenta pair — user: "the color scheme in
  // ours makes it a bit difficult to understand," explicitly asked to
  // switch to the newer blue/magenta pair (a visual approximation of the
  // real screenshot's own hues, not a pixel-sampled exact match — nothing
  // in this app's own data currently carries a real hex value to sample).
  const CHECKER_COLOR = 0xc0328c; // magenta accent — matches this app's own existing convention (innerGrid cells below)
  // User report: "the lines in the 3d when looking from top are
  // flickering." Real z-fighting, not the earlier lit-material issue
  // (already fixed, see matTop below): each box's own EdgesGeometry
  // outline sits at the EXACT same position as its face mesh, so from
  // near-directly-overhead — where many boxes' top faces all become
  // coplanar from the camera's own point of view — the GPU's depth
  // buffer can't reliably decide which of the two coincident surfaces
  // (face polygon vs. line) wins per pixel, and flips frame to frame.
  // polygonOffset pushes every FACE material's fragments a hair further
  // from the camera than their true depth, so the coincident line
  // geometry always wins the depth test outright — standard fix for a
  // Mesh + matching EdgesGeometry outline pair, applied to every face
  // material below (mat/matChecker/matTop, plus the graphic-texture
  // material in buildBoxMaterials further down) since all of them sit
  // under this same per-box edges line.
  const POLYGON_OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const mat = new THREE.MeshStandardMaterial({
    color: boxColor, // "Change Color" (docs 4.8) — defaults to Cape Pack Cloud's own dark charcoal gray, see boxColor's own comment
    transparent: isTransparent,
    opacity: boxOpacity,
    depthWrite: !isTransparent, // avoids z-fighting/sorting artifacts between overlapping transparent boxes
    ...POLYGON_OFFSET,
  });
  const matChecker = new THREE.MeshStandardMaterial({
    color: CHECKER_COLOR,
    transparent: isTransparent,
    opacity: boxOpacity,
    depthWrite: !isTransparent,
    ...POLYGON_OFFSET,
  });
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321, transparent: isTransparent, opacity: Math.max(boxOpacity, 0.35) });
  // User report (real CapePack screenshot): "ours... consists of same
  // colors and dark" — real CapePack leaves the TOP face of every box
  // plain white/light, only alternating the checker color on the sides;
  // this app used to paint the top the same busy checker color as
  // everywhere else. FACE_TOP mirrors BoxGeometry's own default face-
  // group order (2=+Y/top, see the comment on activeGraphic below).
  // Follow-up user report, reproduced live: from close to directly
  // overhead the top faces (and the edge lines between them) "disappear"
  // — a real bug, not the intended look. Root cause: a LIT
  // MeshStandardMaterial's rendered brightness depends on the angle
  // between its surface normal and the scene's DirectionalLight, which
  // here shines mostly from the side/front for a nicer 3/4-view look —
  // top-facing normals catch little of it, so "white" rendered as a dim
  // gray, and since the checker color only ever shows on the SIDES
  // (invisible from directly above), a top-down view was left with
  // almost nothing to distinguish individual boxes at all. MeshBasicMaterial
  // is unlit — it ignores scene lighting entirely and always shows this
  // exact color, so the top reads as true, consistent white (and the
  // dark edge lines keep their contrast against it) from every angle,
  // not just the one the light happens to favor.
  const FACE_TOP = 2;
  const matTop = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: isTransparent,
    opacity: boxOpacity,
    depthWrite: !isTransparent,
    ...POLYGON_OFFSET,
  });

  // "Add Graphics" (docs 4.9/11.8) — built once, shared by every box, same
  // as mat/edgesMat/innerMat below (every box on the pallet is identical,
  // so there's nothing per-instance about which faces carry the texture).
  // Scoped to the plain box render only: BoxGeometry's own 6 default face
  // groups are what the material-array trick below relies on; cylinder and
  // custom (Collada) shapes don't have that same clean per-face structure.
  // Always builds a 6-material array now (not just when activeGraphic is
  // set) so the plain-white top face above applies unconditionally too.
  const buildBoxMaterials = (sideMat) =>
    renderInfo.shape === "box"
      ? [0, 1, 2, 3, 4, 5].map((i) =>
          activeGraphic && activeGraphic.faces.has(i)
            ? new THREE.MeshStandardMaterial({ map: activeGraphic.texture, transparent: isTransparent, opacity: boxOpacity, depthWrite: !isTransparent, ...POLYGON_OFFSET })
            : i === FACE_TOP
              ? matTop
              : sideMat
        )
      : sideMat;
  const boxMaterials = buildBoxMaterials(mat);
  const boxMaterialsChecker = buildBoxMaterials(matChecker);

  const innerGrid = renderInfo.innerGrid;
  const innerMat = innerGrid
    ? new THREE.MeshStandardMaterial({ color: 0xc0328c, transparent: true, opacity: Math.min(boxOpacity + 0.4, 1) })
    : null;
  const showInner = innerGrid && isTransparent && boxes.length * innerGrid.nx * innerGrid.ny * innerGrid.nz <= MAX_INNER_MESHES;

  for (const b of boxes) {
    // "custom" (an imported Collada .ZAE) is real, possibly multi-mesh
    // geometry — doesn't fit the single-BufferGeometry BoxGeometry/
    // CylinderGeometry + shared-material + EdgesGeometry path below at all,
    // so it's a separate branch: clone the parsed template once per box
    // position, rescale it from its own originally-measured mm dimensions
    // to this box's actual l/h/w (identical unless a resize/multisize
    // variant asked for a different size than what was uploaded), and push
    // the opacity slider onto its own material(s) directly since there's no
    // single shared `mat` to reuse across an arbitrary imported mesh.
    if (renderInfo.shape === "custom" && renderInfo.customObject) {
      const clone = renderInfo.customObject.clone(true);
      const dims = renderInfo.customDims;
      clone.scale.set((b.l / dims.lengthMm) * 1000, (b.h / dims.heightMm) * 1000, (b.w / dims.widthMm) * 1000);
      clone.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        for (const m of Array.isArray(child.material) ? child.material : [child.material]) {
          m.transparent = isTransparent;
          m.opacity = boxOpacity;
          m.depthWrite = !isTransparent;
        }
      });
      clone.position.copy(toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2));
      boxesGroup.add(clone);
      continue;
    }

    const geo =
      renderInfo.shape === "cylinder"
        ? new THREE.CylinderGeometry(Math.min(b.l, b.w) / 2, Math.min(b.l, b.w) / 2, b.h, 24)
        : new THREE.BoxGeometry(b.l, b.h, b.w);
    // Cylinders always render as radius=min(l,w) regardless of grid
    // position (the geometry itself carries no per-box adjacency cue —
    // every cylinder in a row looks identical), so checkerboard coloring
    // is scoped to the box shape only — a judgment call, see
    // docs/ARCHITECTURE.md.
    const materials = renderInfo.shape === "cylinder" ? mat : b.checker ? boxMaterialsChecker : boxMaterials;
    const mesh = new THREE.Mesh(geo, materials);
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2);
    mesh.position.copy(center);
    boxesGroup.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    boxesGroup.add(edges);

    if (showInner) {
      const { nx, ny, nz } = innerGrid;
      const { geo: innerGeo, cellL, cellW, cellH } = innerGridCellGeometry(innerGrid, b.l, b.w, b.h);
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          for (let k = 0; k < nz; k++) {
            const innerMesh = new THREE.Mesh(innerGeo, innerMat);
            innerMesh.position.copy(
              toScene(b.x + (i + 0.5) * cellL, b.y + (j + 0.5) * cellW, b.z + (k + 0.5) * cellH)
            );
            boxesGroup.add(innerMesh);
          }
        }
      }
    }
  }
}

// User report: "3d preview is too long but the 3d area is smaller" —
// every one of this file's 7 secondary preview panels (Format Load,
// Layer Editor, Master Pallet Base, Truck Analysis, Graphics, Cases and
// Trays, Fill Wizard) sizes its own renderer/camera ONCE, right when its
// scene is first created, from `container.clientWidth/clientHeight || a
// hardcoded fallback` — and never again afterward (each scene is only
// re-created if the canvas gets detached from its container entirely).
// If that first creation happens while the container is still hidden/
// unlaid-out (clientHeight reads 0 - e.g. its own Utility tab not active
// yet), the fallback number gets baked into the renderer's own pixel
// size PERMANENTLY, even once the real container is later shown at its
// real (larger) CSS height — reproduced live: a #fl-preview container
// genuinely laid out at 418px still had its own <canvas> stuck at a flat
// 220px, the exact old fallback number, with the rest of the container's
// own visible height just empty background around it. Every affected
// preview already runs its own rAF loop already (see each one's own
// `loop`), so self-healing this only needs one extra, cheap check per
// frame — no need to hunt down every call site that might trigger the
// original, one-time creation at the wrong moment.
function syncPreviewSize(container, renderer, camera) {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return; // still hidden/unlaid-out this frame - leave whatever size it already has, try again next frame
  const current = renderer.getSize(new THREE.Vector2());
  if (current.width === w && current.height === h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Shared by frameCamera (main pallet view) below and renderCaseDetail's own
// camera setup — positions `cam` along `direction` from `center` at
// whatever distance is needed for a bounding sphere of `radius` to fully
// fit within `cam`'s own CURRENT aspect ratio, so the object stays
// centered and well-framed regardless of how wide/narrow its container
// is. The case-detail view originally used a fixed maxDim-based offset
// instead (no aspect-ratio awareness) — looked off-center, user report,
// once the two 3D panels' widths stopped matching each other 1:1.
function fitCameraToSphere(cam, ctrl, center, radius, direction) {
  const vFov = (cam.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
  const distance = (radius / Math.min(Math.sin(vFov / 2), Math.sin(hFov / 2))) * 1.25;
  cam.position.copy(center).addScaledVector(direction, distance);
  ctrl.target.copy(center);
  cam.near = Math.max(distance / 100, 1);
  cam.far = distance * 10;
  cam.updateProjectionMatrix();
}

const CAMERA_DIRECTION = new THREE.Vector3(0.9, 0.85, 1.3).normalize();

function frameCamera(pallet, loadHeight) {
  const center = new THREE.Vector3(pallet.length / 2, loadHeight / 2, pallet.width / 2);
  const radius = 0.5 * Math.sqrt(pallet.length ** 2 + pallet.width ** 2 + loadHeight ** 2);
  fitCameraToSphere(camera, controls, center, radius, CAMERA_DIRECTION);
}

// Real CapePack's own pallet-view labels (user-supplied screenshots):
// total stack height (deck-INCLUSIVE — loadHeight itself, distinct from
// the Quick Report's own load-only Product Height fixed earlier the same
// day; a physical 3D view legitimately needs total clearance height,
// already independently confirmed against a real export showing both
// numbers side by side) plus the pallet's own length/width. Positions
// verified by simulating frameCamera's real projection math across
// several pallet aspect ratios — height lands top-right, length
// bottom-center, width bottom-left, matching the real screenshot.
function renderPalletDimensionLabels(pallet, loadHeight) {
  dimensionLabelsGroup.clear();
  // Each line runs along its own axis just outside the load's actual edge
  // (not ON the edge itself, which was hard to tell apart from the box's
  // own edge lines) — offset by a fixed fraction of the load's footprint,
  // same corner-based layout as before (height on the front-right vertical
  // edge, length along the front-bottom edge, width along the left-bottom
  // edge) but now with a real line + end ticks + an axis-prefixed label
  // sitting on the line itself, so "which dimension is this" is no longer
  // a guess from position alone.
  const offset = 0.2 * Math.max(pallet.length, pallet.width, loadHeight);
  const tick = 0.03 * Math.max(pallet.length, pallet.width, loadHeight);

  const hFrom = toScene(pallet.length + offset, 0, 0);
  const hTo = toScene(pallet.length + offset, 0, loadHeight);
  dimensionLabelsGroup.add(makeDimensionLine(hFrom, hTo, new THREE.Vector3(1, 0, 0), tick));
  const h = makeDimensionLabel(`Height: ${fmtLength(loadHeight)}`);
  h.position.lerpVectors(hFrom, hTo, 0.5);
  dimensionLabelsGroup.add(h);

  const lenFrom = toScene(0, -offset, 0);
  const lenTo = toScene(pallet.length, -offset, 0);
  dimensionLabelsGroup.add(makeDimensionLine(lenFrom, lenTo, new THREE.Vector3(0, 0, 1), tick));
  const len = makeDimensionLabel(`Length: ${fmtLength(pallet.length)}`);
  len.position.lerpVectors(lenFrom, lenTo, 0.5);
  dimensionLabelsGroup.add(len);

  const widFrom = toScene(-offset, 0, 0);
  const widTo = toScene(-offset, pallet.width, 0);
  dimensionLabelsGroup.add(makeDimensionLine(widFrom, widTo, new THREE.Vector3(1, 0, 0), tick));
  const wid = makeDimensionLabel(`Width: ${fmtLength(pallet.width)}`);
  wid.position.lerpVectors(widFrom, widTo, 0.5);
  dimensionLabelsGroup.add(wid);
}

function draw(solution, pallet, renderInfo = { shape: "box" }) {
  renderPallet(pallet);
  const boxes = buildBoxLayout(solution, pallet, { alternateLayers });
  renderBoxes(boxes, renderInfo);
  frameCamera(pallet, solution.loadHeight);
  renderPalletDimensionLabels(pallet, solution.loadHeight);
}

// Load Multi-Sized Products: each zone is a different product, colored
// distinctly so the zones are visually obvious — the single-shape
// renderBoxes()/buildRenderInfo() path doesn't apply since there's no one
// "the primary pack" here.
const MULTISIZE_COLORS = [0xd9a441, 0x6b8fd9, 0x8fae3f, 0xd96b8f, 0xa46bd9, 0x4ac9c0, 0xd97a41, 0x7a41d9];
function renderMultiSizeBoxes(boxes) {
  boxesGroup.clear();
  const isTransparent = boxOpacity < 1;
  const productNames = [...new Set(boxes.map((b) => b.product))];
  // Same coincident face-vs-edges z-fighting fix as the main pallet
  // view's own POLYGON_OFFSET (renderBoxes) — every box here gets its
  // own edges LineSegments at the exact same position too.
  const materials = new Map(
    productNames.map((name, i) => [
      name,
      new THREE.MeshStandardMaterial({
        color: MULTISIZE_COLORS[i % MULTISIZE_COLORS.length],
        transparent: isTransparent,
        opacity: boxOpacity,
        depthWrite: !isTransparent,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    ])
  );
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x333333, transparent: isTransparent, opacity: Math.max(boxOpacity, 0.35) });

  for (const b of boxes) {
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mesh = new THREE.Mesh(geo, materials.get(b.product));
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2);
    mesh.position.copy(center);
    boxesGroup.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    boxesGroup.add(edges);
  }
}

function drawMultiSize(result, pallet) {
  renderPallet(pallet);
  const boxes = buildMultiSizeBoxLayout(result, pallet);
  renderMultiSizeBoxes(boxes);
  frameCamera(pallet, result.loadHeight);
  renderPalletDimensionLabels(pallet, result.loadHeight);
}

// Case-based workflows (Create a Case / Fill a Stock Case / Resize) place a
// designed CASE on the pallet, not the primary pack directly — the case
// itself is always a rectangular box, but when the primary pack is a
// cylinder (bottle/can), show the actual nx x ny x nz grid of bottles
// packed inside it once boxes are see-through. Reads the grid straight from
// each workflow's own result shape (optimizeCase's primaryGrid /
// fillStockCase's orientation.grid) rather than recomputing it.
function buildRenderInfo(ctx) {
  if (!ctx) return { shape: "box" };
  if (ctx.workflow === "pallet") {
    // A custom (Collada) shape only renders as real geometry directly on
    // the pallet — case-based workflows below always draw a rectangular
    // case regardless of baseShape (same as cylinder), and extending the
    // inner-grid preview (see below) to real custom meshes too is a
    // disclosed gap, not silently dropped: see docs/ARCHITECTURE.md.
    if (primaryPackBaseShape === "custom" && primaryPackCustomShape) {
      return { shape: "custom", customObject: primaryPackCustomShape.object, customDims: primaryPackCustomShape };
    }
    return { shape: primaryPackBaseShape };
  }

  // Inner Pack (this app's own feature — see optimizeCaseWithInnerPack.js):
  // the outer boxes on the main pallet view are CASES containing INNER
  // PACKS, not primary packs directly, once it's active — reveal THOSE
  // when opacity drops, using the case-level grid (inner packs per case,
  // always box-shaped — an inner pack is never a cylinder). Takes
  // priority over the primary-pack grid below, which would otherwise show
  // the wrong count (primary units per inner pack, not per case).
  if (ctx.caseInfo?.innerPack) {
    const { nx, ny, nz } = ctx.caseInfo.primaryGrid; // case-level grid, in terms of inner packs
    return { shape: "box", innerGrid: { nx, ny, nz, shape: "box" } };
  }

  // User ask: "I want to see the objects, small cases in the larger
  // packages when I decrease the box opacity" — previously gated to
  // primaryPackBaseShape === "cylinder" only (a real, disclosed gap: box-
  // shaped primaries never got this reveal at all, even though
  // innerGridCellGeometry already supports box-shaped cells just as well
  // as cylinder ones — see its own shape ternary). Generalized: any
  // case-based workflow with a real primary-pack grid gets the reveal,
  // shaped like the actual primary pack.
  const grid = ctx.caseInfo?.primaryGrid ?? ctx.fillInfo?.orientation?.grid ?? ctx.resizeInfo?.caseResult?.primaryGrid;
  if (!grid) return { shape: "box" };
  return {
    shape: "box",
    innerGrid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, shape: primaryPackBaseShape === "cylinder" ? "cylinder" : "box" },
  };
}

// Case OD + primary-pack grid for the dedicated Secondary Pack detail
// view (see renderCaseDetail below) — same three result shapes
// buildRenderInfo already reads from, plus each one's own case OD.
// fillcase's OD isn't on fillInfo itself (fillStockCase's result never
// echoes back the fixed stock case it was given) — currentContext.stockCase
// carries it instead, threaded through selectFillCaseSolution/
// showFillCaseSolutions alongside fillInfo for exactly this reason.
function getCaseDetailInfo(ctx) {
  if (!ctx) return null;
  if (ctx.caseInfo) return { od: ctx.caseInfo.caseDimensions, grid: ctx.caseInfo.primaryGrid };
  if (ctx.fillInfo && ctx.stockCase) return { od: ctx.stockCase, grid: ctx.fillInfo.orientation.grid };
  if (ctx.resizeInfo) return { od: ctx.resizeInfo.caseResult.caseDimensions, grid: ctx.resizeInfo.caseResult.primaryGrid };
  // Build a Pallet's own Case Content > Fill Wizard: a MANUALLY declared
  // grid (no computed search — Build a Pallet's box is fixed either way),
  // purely for this view. od is the outer Secondary Pack's own dims
  // (ctx.primary, threaded through selectPalletSolution/
  // showPalletSolutions the same way primary/stockCase already are for
  // case/fillcase) — grid.shape carries Fill Wizard's OWN independently-
  // picked inner shape, which may differ from the outer pack's shape.
  if (ctx.workflow === "pallet" && ctx.primary && ctx.caseContent?.mode === "fillWizard") {
    const { length, width, height } = ctx.caseContent.fillWizard.arrangement;
    return { od: ctx.primary, grid: { nx: length, ny: width, nz: height, shape: ctx.caseContent.fillWizard.shape } };
  }
  return null;
}

// Draws ONE case (OD, translucent) with its primary-pack grid inside —
// always visible, independent of the main pallet view's own Box Opacity
// slider (see the scene setup's own comment above toScene). Mirrors
// renderCasesTraysPreview's OD-box technique (main.js ~7080) but fills
// the interior with the real nx*ny*nz grid (innerGridCellGeometry, shared
// with renderBoxes' own per-case inner preview) instead of a plain ID
// wireframe, since the grid IS the "what's inside" this view exists for.
function renderCaseDetail(od, grid) {
  caseDetailGroup.clear();
  const l = Math.max(od.length, 1);
  const w = Math.max(od.width, 1);
  const h = Math.max(od.height, 1);

  const odGeo = new THREE.BoxGeometry(l, h, w);
  caseDetailGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(odGeo), new THREE.LineBasicMaterial({ color: 0x5c4321 })));
  // User report (real CapePack screenshot): "especially for the case, it
  // consists of same colors and dark" — this shell used to ALWAYS render
  // as a solid, translucent (0.55 opacity) boxColor fill on top of the
  // inner grid below, tinting every cell the same muddy blue regardless
  // of its own real color — real CapePack draws no such tint at all, just
  // this thin outline, letting the individual primary packs inside show
  // their own true (alternating) color at full opacity. Only skipped when
  // there's no grid to reveal (nothing to tint would matter anyway) —
  // falls back to the original solid, semi-transparent case shell so a
  // plain "just the case, no breakdown" view still reads as a real box.
  if (!grid) {
    // Same coincident-geometry z-fighting risk as the main pallet view's
    // own POLYGON_OFFSET (see renderBoxes) — this fill sits exactly under
    // the odGeo outline added just above.
    const odMat = new THREE.MeshStandardMaterial({
      color: boxColor,
      transparent: true,
      opacity: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    caseDetailGroup.add(new THREE.Mesh(odGeo, odMat));
  }

  // Real CapePack's own case-view labels (user-supplied screenshots) — od's
  // own raw length/width/height for the TEXT (so a genuinely-zero OD reads
  // honestly, matching the caption text below), the clamped l/w/h locals
  // for POSITION (keeps labels aligned with the actually-rendered mesh).
  // Positions verified against this scene's real camera setup (maxDim ×
  // 1.3/1.1/1.3, origin target) across several case shapes.
  // Same offset-line-plus-axis-prefixed-label treatment as the main pallet
  // view's renderPalletDimensionLabels — the OD box here is centered on
  // the scene origin (unlike the pallet view's own 0-to-length/width
  // convention), so each line is offset outward from that center instead.
  const offset = 0.1 * Math.max(l, w, h);
  const tick = 0.04 * Math.max(l, w, h);

  const hFrom = new THREE.Vector3(l / 2 + offset, -h / 2, -w / 2);
  const hTo = new THREE.Vector3(l / 2 + offset, h / 2, -w / 2);
  caseDetailGroup.add(makeDimensionLine(hFrom, hTo, new THREE.Vector3(0, 0, 1), tick));
  const hLabel = makeDimensionLabel(`Height: ${fmtLength(od.height)}`);
  hLabel.position.lerpVectors(hFrom, hTo, 0.5);

  const lenFrom = new THREE.Vector3(-l / 2, -h / 2 - offset, -w / 2);
  const lenTo = new THREE.Vector3(l / 2, -h / 2 - offset, -w / 2);
  caseDetailGroup.add(makeDimensionLine(lenFrom, lenTo, new THREE.Vector3(0, 0, 1), tick));
  const lenLabel = makeDimensionLabel(`Length: ${fmtLength(od.length)}`);
  lenLabel.position.lerpVectors(lenFrom, lenTo, 0.5);

  const widFrom = new THREE.Vector3(-l / 2 - offset, -h / 2, -w / 2);
  const widTo = new THREE.Vector3(-l / 2 - offset, -h / 2, w / 2);
  caseDetailGroup.add(makeDimensionLine(widFrom, widTo, new THREE.Vector3(1, 0, 0), tick));
  const widLabel = makeDimensionLabel(`Width: ${fmtLength(od.width)}`);
  widLabel.position.lerpVectors(widFrom, widTo, 0.5);

  caseDetailGroup.add(hLabel, lenLabel, widLabel);

  if (grid) {
    // grid.shape wins when the caller set one (Case Content's own Fill
    // Wizard picks its inner pack independently of the outer Secondary
    // Pack) — falls back to primaryPackBaseShape for the 3 pre-existing
    // callers (caseInfo/fillInfo/resizeInfo), none of which ever set
    // grid.shape themselves, so this is a no-op for all of them.
    const shape = grid.shape ?? (primaryPackBaseShape === "cylinder" ? "cylinder" : "box");
    const { nx, ny, nz } = grid;
    const { geo: innerGeo, cellL, cellW, cellH } = innerGridCellGeometry({ nx, ny, nz, shape }, l, w, h);
    // Same "same colors and dark" report as the shell fix above: every
    // cell used to share one flat color, no alternation at all — real
    // CapePack's own screenshot shows individual packs alternating (same
    // checkerboard convention as the main pallet view's own renderBoxes),
    // plain white tops, and a real per-pack outline. FACE_TOP mirrors
    // BoxGeometry's own default face-group order (2=+Y/top) — only
    // meaningful for the box shape; a cylinder cell's top is its round cap
    // face group, not a comparable flat rectangle, so it keeps one color
    // all over rather than forcing a mismatched white disc.
    // innerMatTop is unlit (MeshBasicMaterial) — same fix, same reason,
    // as the main pallet view's own matTop: a LIT white material dims
    // toward gray whenever the viewing/light angle doesn't favor
    // top-facing normals (worst near-directly-overhead, exactly where a
    // user reported the top "disappearing"), while an unlit material
    // always renders this exact color regardless of angle.
    // User report: "the lines in the 3d when looking from top are
    // flickering" — same fix, same reason, as the main pallet view's own
    // POLYGON_OFFSET (renderBoxes): each cell's face mesh sits exactly
    // coincident with its own cellEdges outline below, so a near-
    // overhead view (where many cells' tops are coplanar from the
    // camera's point of view) z-fights between the two. Pushing every
    // cell face material back a hair lets the line always win.
    const CELL_POLYGON_OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    const FACE_TOP = 2;
    const innerMat = new THREE.MeshStandardMaterial({ color: boxColor, ...CELL_POLYGON_OFFSET });
    const innerMatChecker = new THREE.MeshStandardMaterial({ color: 0xc0328c, ...CELL_POLYGON_OFFSET });
    const innerMatTop = new THREE.MeshBasicMaterial({ color: 0xffffff, ...CELL_POLYGON_OFFSET });
    const innerEdgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321 });
    const facesFor = (sideMat) => (shape === "box" ? [sideMat, sideMat, innerMatTop, sideMat, sideMat, sideMat] : sideMat);
    const innerMaterials = facesFor(innerMat);
    const innerMaterialsChecker = facesFor(innerMatChecker);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++) {
          const checker = (i + j + k) % 2 === 1;
          const mesh = new THREE.Mesh(innerGeo, checker ? innerMaterialsChecker : innerMaterials);
          // BoxGeometry is centered at its own local origin — offset each
          // cell by half the OD so the whole grid centers inside odMesh.
          mesh.position.set((i + 0.5) * cellL - l / 2, (k + 0.5) * cellH - h / 2, (j + 0.5) * cellW - w / 2);
          caseDetailGroup.add(mesh);
          const cellEdges = new THREE.LineSegments(new THREE.EdgesGeometry(innerGeo), innerEdgesMat);
          cellEdges.position.copy(mesh.position);
          caseDetailGroup.add(cellEdges);
        }
      }
    }
  }

  const radius = 0.5 * Math.sqrt(l ** 2 + w ** 2 + h ** 2);
  fitCameraToSphere(caseDetailCamera, caseDetailControls, new THREE.Vector3(0, 0, 0), radius, CAMERA_DIRECTION);
  caseDetailControls.update();
}

// Which of the (up to) 2 nested levels the Case Detail 3D view currently
// shows — only relevant when Inner Pack is active (ctx.caseInfo.innerPack
// present); reset to "case" on every new selection so switching solutions
// never silently leaves a stale "innerPack" view showing the wrong data.
let caseDetailView = "case";

// Shows/hides #case-canvas-wrap and (re)renders it for the current
// selection — called unconditionally after every draw()/drawMultiSize()
// call; getCaseDetailInfo's own null return (pallet/kdf/multisize, none
// of which have a secondary pack) is what actually hides it, so callers
// don't need their own workflow check.
function showCaseDetail(ctx) {
  const info = getCaseDetailInfo(ctx);
  const wrapEl = $("case-canvas-wrap");
  if (!info) {
    wrapEl.hidden = true;
    return;
  }
  wrapEl.hidden = false;

  // Inner Pack (this app's own feature — see optimizeCaseWithInnerPack.js)
  // adds a second nested level to show here: the SAME renderCaseDetail
  // function, reused unchanged, just called with the inner pack's own OD/
  // grid instead of the case's own — zero new Three.js code.
  const innerPack = ctx.caseInfo?.innerPack;
  $("case-canvas-tabs").style.display = innerPack ? "flex" : "none";
  if (!innerPack) caseDetailView = "case";
  $("case-canvas-tab-case").classList.toggle("active", caseDetailView === "case");
  $("case-canvas-tab-innerpack").classList.toggle("active", caseDetailView === "innerpack");

  const showInner = innerPack && caseDetailView === "innerpack";
  const od = showInner ? innerPack.dimensions : info.od;
  const grid = showInner ? innerPack.primaryGrid : info.grid;
  renderCaseDetail(od, grid);
  const label = showInner ? "Inner Pack" : "Case";
  // The case-level grid's own nx/ny/nz mean "inner packs per case" once
  // Inner Pack is active (not primary packs — see optimizeCaseWithInnerPack.js),
  // so the caption's own unit label must switch too, independent of which
  // tab is currently shown.
  const gridUnit = showInner ? "primary packs/inner pack" : innerPack ? "inner packs/case" : "primary packs/case";
  const gridLabel = grid ? ` - ${grid.nx} × ${grid.ny} × ${grid.nz} ${gridUnit}` : "";
  $("case-canvas-caption").textContent =
    `${label} OD: ${fmtLength(od.length)} × ${fmtLength(od.width)} × ${fmtLength(od.height)}${gridLabel}`;
  resizeCaseDetail();
}

function redraw() {
  if (!currentContext) return;
  if (currentContext.multiSizeResult) {
    drawMultiSize(currentContext.multiSizeResult, currentContext.pallet);
    return;
  }
  draw(currentContext.solution, currentContext.pallet, buildRenderInfo(currentContext));
}

// --- wizard step navigation -------------------------------------------------
// New Analysis / Details / Solutions / Report used to be 4 separate
// horizontal steps; per user request they're now one continuous page under
// a single "New Analysis" tab (vertical tabs alongside Analyses/Databases —
// see .stepper CSS). STEPS still names the 4 panels bundled under that tab
// (openAnalysesTab/openDatabases hide all of them at once when switching
// away). There's no more gating on which top-level TAB is clickable — every
// tab is always clickable — but within New Analysis itself, user feedback:
// "before clicking on next, the other steps should be kind of invisible or
// disabled" — so a section only appears once its own trigger (Next/
// Calculate/View Report) has actually fired at least once. maxReachedStep
// tracks that high-water mark for the CURRENT pass through the form.
// Follow-up feedback — "When I click on New tab, all steps are still
// active. It should be step by step." — means this does NOT persist across
// leaving and re-entering "new" the way currentContext does: every arrival
// at "new" (the top-level tab, a "Back to New Analysis" link, or the New/
// Recent sub-tab pill — all of them funnel through goToStep("new")) resets
// it to 0, so the page always starts step-by-step again. Calculate/View
// Report/Import/Rerun still advance it forward from there within that pass,
// same as before.
const STEPS = ["new", "input", "solutions", "report"];
let maxReachedStep = 0;
const $ = (id) => document.getElementById(id);
const num = (id) => Number($(id).value);

// User request: "I can still write minus values in the boxes as
// dimensions." A number input's `min="0"` HTML attribute (already present
// on every dimension/weight field in this app bar the 2 that genuinely
// need negative values, see below) only affects the native spinner and
// the field's own validityState — it never stops a minus sign from being
// TYPED. One delegated pair of listeners on `document`, not per-field
// wiring across this app's own 147 min-bearing number inputs: `keydown`
// blocks the "-" key outright on any `<input type="number">` that
// declares a `min` (so typing never even gets a chance to go negative —
// no mid-type jank from clamping after the fact); `input` is a fallback
// for the one path keydown can't see, a paste, clamping the value up to
// its own `min` if it somehow landed below it. Deliberately keyed off the
// `min` ATTRIBUTE being present, not a hardcoded field list or a blanket
// "no minus anywhere" rule — Pallet's own Overhang/Underhang Length/Width
// fields have NO `min` attribute at all, by design (their own label:
// "Positive = load intentionally allowed to overhang the pallet edge...
// negative = load kept inset from the edge"), so both listeners leave
// them untouched.
document.addEventListener("keydown", (e) => {
  if (e.key !== "-" && e.key !== "Subtract") return;
  const el = e.target;
  if (el.tagName !== "INPUT" || el.type !== "number" || el.min === "") return;
  e.preventDefault();
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.tagName !== "INPUT" || el.type !== "number" || el.min === "") return;
  if (el.value !== "" && Number(el.value) < Number(el.min)) el.value = el.min;
});

function goToStep(stepId) {
  // Refreshes the Storage Environment dropdowns/table from the live database
  // whenever the Report section is reached, so an edit made in Databases
  // takes effect promptly rather than only on the next full page load.
  if (stepId === "report") {
    loadStorageEnvironmentFactors();
    loadEfficiencyFactors();
  }
  // Databases and Analyses are standalone tabs of their own — always reset
  // them when the New Analysis tab is (re)selected. Settings is a modal now
  // (folded into Databases, see openSettingsView), so it needs no such reset.
  $("panel-databases").hidden = true;
  $("tab-databases").classList.remove("active");
  $("panel-analyses").hidden = true;
  $("tab-analyses").classList.remove("active");
  $("analyses-table-wrap").hidden = true;

  if (stepId === "new") maxReachedStep = 0;
  maxReachedStep = Math.max(maxReachedStep, STEPS.indexOf(stepId));
  for (const s of STEPS) $(`panel-${s}`).hidden = STEPS.indexOf(s) > maxReachedStep;
  // #calculate-preview/#preview-3d-row live inside #panel-solutions now
  // (see index.html's own comment there — "solution alternatives and the
  // 3d should be a part of solution"), so panel-solutions's own hidden
  // state above already covers them — these two explicit toggles are
  // redundant now, kept only because they're harmless and this function
  // already sets them everywhere else too.
  $("calculate-preview").hidden = maxReachedStep < STEPS.indexOf("solutions");
  $("preview-3d-row").hidden = maxReachedStep < STEPS.indexOf("solutions");

  document.querySelectorAll(".stepper .step").forEach((el) => el.classList.remove("active"));
  $("tab-new").classList.add("active");

  // New Analysis has its own New/Recent sub-tabs (see subtab-new-form/
  // subtab-recent) — always land on the form, not a stale Recent table,
  // whenever arriving here via Calculate/View Report/Rerun/etc.
  $("subtab-recent").classList.remove("active");
  $("subtab-new-form").classList.add("active");
  $("new-form-section").hidden = false;
  $("recent-section").hidden = true;

  // The 3D preview (and the solution-picker table below it) only makes
  // sense once a solution actually exists — tied to currentContext now
  // rather than to "being on" a particular step, since every section is
  // visible together.
  const show3D = !!currentContext;
  renderer.domElement.style.display = show3D ? "block" : "none";
  cssRenderer.domElement.style.display = show3D ? "block" : "none";
  $("canvas-placeholder").style.display = show3D ? "none" : "flex";
  $("canvas-controls").style.display = show3D ? "flex" : "none";
  $("results").hidden = !show3D;

  // #calculate-preview (the 3D view) sits between panel-input and
  // panel-solutions now, not inside panel-solutions — scroll there instead
  // so Calculate lands the user right on the preview, not past it.
  const scrollTargetId = stepId === "solutions" ? "calculate-preview" : `panel-${stepId}`;
  $(scrollTargetId).scrollIntoView({ behavior: "smooth", block: "start" });
}

// A fully custom slider (see .slider/.slider-track/.slider-fill/.slider-thumb
// CSS) — every earlier attempt styled the NATIVE range thumb and tried to
// predict/compensate for where the browser would actually render it, which
// kept drifting out of sync with the displayed percentage (a native thumb's
// position is set by the browser's own internal box measurement, not
// reliably matchable from CSS/JS — the exact "slider looks like 85% but says
// 100%" symptom). Now there's exactly one number, pct, computed straight
// from the real <input>'s value/min/max. Thumb/fill position is then worked
// out in real pixels (not a raw pct%) so the round thumb's own radius is
// inset from the track: at pct=100 a raw `left:100%` would center the thumb
// ON the track's right edge, overhanging it by half the thumb's width (the
// track's rounded corner then visibly pokes into the middle of the thumb) —
// insetting by thumbWidth/2 on each side keeps the thumb fully within the
// track at both ends, same as how native range sliders inset their own
// thumb travel. The real <input> stays in the DOM (transparent, on top)
// purely so dragging, clicking, and keyboard arrows keep working with full
// native accessibility.
function updateSliderFill(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  const track = el.parentElement.querySelector(".slider-track");
  const thumb = el.parentElement.querySelector(".slider-thumb");
  const trackWidth = track.getBoundingClientRect().width;
  const thumbWidth = thumb.getBoundingClientRect().width || 16;
  const usable = Math.max(trackWidth - thumbWidth, 0);
  const thumbLeftPx = thumbWidth / 2 + (pct / 100) * usable;
  $("canvas-opacity-fill").style.width = `${thumbLeftPx}px`;
  thumb.style.left = `${thumbLeftPx}px`;
}

updateSliderFill($("canvas-opacity"));
// User report: "it shows 100% but the slider is at the far left side."
// Root cause: the call just above runs at page load, while #canvas-wrap
// (and this slider inside it) is still hidden — every element inside it
// measures 0 width via getBoundingClientRect() at that moment, so
// updateSliderFill's own usable-travel math collapses to 0 and permanently
// bakes in "thumb at the left edge" regardless of the real value. It only
// ever got recomputed again on a real "input" event (the user actually
// dragging it) — until then, the visual stayed stuck at that wrong initial
// position even though the underlying value (and the "100%" label next to
// it) were always correct. Fix: re-run the same layout-dependent math via
// ResizeObserver on the track itself, so the moment it's actually shown
// (width goes from 0 to real) the thumb/fill snap to match the real value
// — no dependency on the user touching the slider first.
new ResizeObserver(() => updateSliderFill($("canvas-opacity"))).observe(
  $("canvas-opacity").parentElement.querySelector(".slider-track")
);
$("canvas-opacity").addEventListener("input", () => {
  boxOpacity = Number($("canvas-opacity").value);
  $("canvas-opacity-value").textContent = `${Math.round(boxOpacity * 100)}%`;
  updateSliderFill($("canvas-opacity"));
  redraw();
});

$("tab-new").addEventListener("click", () => goToStep("new"));

// Product Name is the only required field on the New Analysis form — user
// ask: "product name should be mandatory for creating a new project." Without
// it, saved analyses show up as "(untitled)" in the Analyses table with
// nothing to tell them apart. Checked both where a fresh analysis starts
// (Next) and where one actually gets persisted (Save Analysis, in case a
// Rerun loaded an old untitled one and skipped Next entirely).
function requireProductName() {
  const ok = $("meta-product").value.trim().length > 0;
  $("meta-product-error").style.display = ok ? "none" : "block";
  if (!ok) {
    $("meta-product").scrollIntoView({ behavior: "smooth", block: "center" });
    $("meta-product").focus();
  }
  return ok;
}
$("meta-product").addEventListener("input", () => {
  if ($("meta-product").value.trim().length > 0) $("meta-product-error").style.display = "none";
});

$("to-input").addEventListener("click", () => {
  if (!requireProductName()) return;
  goToStep("input");
});

// --- Analyses tab: full saved-analyses table (docs section, user ask: "Create
// another tab for the recent analyses like a table before 1 New") ----------
// Always reachable/clickable, unlike the 4 linear STEPS — it's a browsing/
// management view, not part of the New -> Details -> Solutions -> Report flow.
function openAnalysesTab() {
  for (const s of STEPS) $(`panel-${s}`).hidden = true;
  $("panel-databases").hidden = true;
  $("panel-analyses").hidden = false;
  document.querySelectorAll(".stepper .step").forEach((el) => el.classList.remove("active"));
  $("tab-analyses").classList.add("active");
  $("calculate-preview").hidden = true; // inline now, not a permanent side column — only relevant within New Analysis
  $("preview-3d-row").hidden = true;
  // insertBefore, not appendChild — the Export/Import buttons now live
  // below the table (#analyses-io-section, see index.html's own comment
  // there), so simply appending would drop the table back past them
  // every time this tab is reopened, undoing that move.
  $("panel-analyses").insertBefore($("analyses-table-wrap"), $("analyses-io-section")); // move back in case Recent sub-tab last claimed it
  $("analyses-table-wrap").hidden = false;
  renderAnalysesTable();
}
$("tab-analyses").addEventListener("click", openAnalysesTab);

function fmtPackDims(dims) {
  if (!dims) return "-";
  return dims.height !== undefined
    ? `${dims.length} × ${dims.width} × ${dims.height} mm`
    : `${dims.length} × ${dims.width} mm`;
}

// Primary/secondary pack size isn't a uniform field across workflows (see
// buildComputeInput) — this mirrors the app's own dynamic Primary/Secondary
// Pack heading logic (updateHeadingForWorkflow): "pallet" has no primary/
// secondary split (one box goes straight on the pallet, shown as the
// Secondary Pack per that same heading logic); "case"/"resize" compute their
// case size at solve time rather than storing it as an input, so it's
// honestly labeled "(computed)" rather than fabricated from nothing stored.
function extractPackSizes(workflow, input) {
  if (workflow === "pallet") return { primary: "-", secondary: fmtPackDims(input.box) };
  if (workflow === "fillcase") return { primary: fmtPackDims(input.primary), secondary: fmtPackDims(input.stockCase) };
  if (workflow === "resize")
    return { primary: fmtPackDims(input.primary), secondary: "(computed - resized case, see report)" };
  if (workflow === "foldedcarton") {
    return {
      primary: fmtPackDims(input.carton),
      secondary: input.caseType === "stock" ? fmtPackDims(input.stockCase) : "(computed - new case, see report)",
    };
  }
  if (workflow === "kdf") return { primary: fmtPackDims(input.flatblank), secondary: "-" };
  if (workflow === "multisize") {
    const n = input.products?.length ?? 0;
    return { primary: n ? `${n} product${n === 1 ? "" : "s"} (mixed sizes)` : "-", secondary: "-" };
  }
  // "case" and any other primary+pallet-shaped workflow
  return { primary: fmtPackDims(input.primary), secondary: "(computed - new case, see report)" };
}

// Real Cape Pack Cloud splits saved solutions into separate "Single Size"
// and "Multi-Size" list views (own sidebar entries, own tables) — user ask:
// "we can filter the saved analyses also like single size and multi size as
// capepack." We keep one shared table (rather than splitting into separate
// pages) and add an equivalent filter instead — same distinction (multisize
// workflow vs. every other workflow), applied before any limit slicing so
// e.g. Recent's "5 most recent" still means 5 most recent WITHIN the filter.
let analysesFilter = "all";
// User ask (follow-up): "we don't see if it is single or multi size.
// also bring more filter like workflow." Same shape as analysesFilter
// above, independent of it — both apply together (AND, not OR), so
// "Multi-Size" + "Load Multi-Sized Products" together is a no-op
// narrowing (nothing else can be multisize anyway) while "Single Size"
// + "Create a Case" usefully combines the two. Options for the real
// select element are populated once WORKFLOW_LABELS itself exists
// further down this file (see right after WORKFLOW_LABELS's own
// definition) — can't build them here, this runs first.
let analysesWorkflowFilter = "all";
let lastAnalysesLimit = null;

function matchesAnalysesFilter(workflow) {
  if (analysesFilter === "multi" && workflow !== "multisize") return false;
  if (analysesFilter === "single" && workflow === "multisize") return false;
  if (analysesWorkflowFilter !== "all" && workflow !== analysesWorkflowFilter) return false;
  return true;
}

$("analyses-filter").addEventListener("change", () => {
  analysesFilter = $("analyses-filter").value;
  renderAnalysesTable({ limit: lastAnalysesLimit });
});
$("analyses-workflow-filter").addEventListener("change", () => {
  analysesWorkflowFilter = $("analyses-workflow-filter").value;
  renderAnalysesTable({ limit: lastAnalysesLimit });
});

// Shared by the Analyses tab (full list) and New Analysis's own Recent
// sub-tab (limit: RECENT_ANALYSES_LIMIT) — same table, same action either
// way: Rerun loads the analysis back into the form AND immediately
// recalculates (see rerunAnalysis below), landing on the Solution section.
async function renderAnalysesTable({ limit = null } = {}) {
  lastAnalysesLimit = limit;
  $("analyses-filter").value = analysesFilter;
  $("analyses-workflow-filter").value = analysesWorkflowFilter;
  const tbody = $("analyses-table-body");
  tbody.innerHTML = `<tr><td colspan="9" style="color:var(--muted)">Loading…</td></tr>`;

  try {
    const res = await fetch(`${API_BASE}/api/analyses`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    let { analyses } = await res.json();
    const hadAny = analyses.length > 0;
    analyses = analyses.filter((a) => matchesAnalysesFilter(a.workflow));
    if (limit != null) analyses = analyses.slice(0, limit);

    if (!analyses.length) {
      const filtered = analysesFilter !== "all" || analysesWorkflowFilter !== "all";
      tbody.innerHTML = `<tr><td colspan="9" style="color:var(--muted)">${
        hadAny && filtered ? "No saved analyses match this filter." : "No saved analyses yet."
      }</td></tr>`;
      return;
    }

    // Sizes live in each record's own input_json, not the list endpoint's
    // summary row — fetch every full record in parallel (fine at this scale;
    // this is a personal-catalog tool, not a paginated multi-tenant list).
    const fullRecords = await Promise.all(
      analyses.map((a) => fetch(`${API_BASE}/api/analyses/${a.id}`).then((r) => (r.ok ? r.json() : null)))
    );

    tbody.innerHTML = "";
    analyses.forEach((a, i) => {
      const full = fullRecords[i];
      const { primary, secondary } = full ? extractPackSizes(full.workflow, full.input) : { primary: "-", secondary: "-" };

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${new Date(a.createdAt).toLocaleString()}</td>
        <td>${a.productName || "(untitled)"}</td>
        <td>${a.productCode || "-"}</td>
        <td>${primary}</td>
        <td>${secondary}</td>
        <td>mm / kg</td>
        <td>${WORKFLOW_LABELS[a.workflow] ?? a.workflow}</td>
        <td>${a.workflow === "multisize" ? "Multi-Size" : "Single Size"}</td>
      `;

      // User report: "the line under rerun and delete is not combined
      // with the line under. it is cut." Root cause: display:flex set
      // directly on a <td> takes it out of normal table-cell layout (its
      // computed display is no longer table-cell), so the table's own
      // row-height/border-collapse math no longer lines this cell's
      // bottom border up with its siblings' — a real, visible gap/offset
      // in the row's own separator line. Fix: keep the <td> itself a
      // plain table cell (default display, participates in the row
      // normally) and put display:flex on a wrapper <div> inside it
      // instead — same visual button layout, no more layout escape.
      const actionTd = document.createElement("td");
      const actionWrap = document.createElement("div");
      actionWrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      actionTd.appendChild(actionWrap);

      const rerunBtn = document.createElement("button");
      rerunBtn.textContent = "Rerun";
      rerunBtn.className = "secondary";
      rerunBtn.style.cssText = "width:auto;margin:0;padding:4px 10px;font-size:11px";
      rerunBtn.addEventListener("click", () => rerunAnalysis(a.id));
      actionWrap.appendChild(rerunBtn);

      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "secondary";
      delBtn.style.cssText = "width:auto;margin:0;padding:4px 10px;font-size:11px";
      delBtn.addEventListener("click", async () => {
        await fetch(`${API_BASE}/api/analyses/${a.id}`, { method: "DELETE" });
        renderAnalysesTable({ limit });
      });
      actionWrap.appendChild(delBtn);

      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--muted)">Couldn't reach the API server - is it running? (node packages/api/src/server.js)</td></tr>`;
  }
}

// --- Export / Import Saved Analyses as JSON --------------------------------
// User ask: "one more json import export would be needed. under saved
// analyses." Same additive-merge idea as Manage Settings and Databases —
// POSTs each analysis as a new row (saveAnalysis, packages/api/src/db.js,
// always assigns a fresh id/createdAt), never replacing what's already
// saved. Distinct from the old single-draft Export/Import Analysis
// (removed earlier this session): this exports the FULL saved collection
// (input + solution, the way Rerun needs it), not one unsaved form's
// inputs. No per-user filtering — this app has no login/accounts, so
// "Saved Analyses" is one shared list for whoever hits this API server;
// exporting here exports everyone's, same disclosed tradeoff discussed
// with the user before building this.
$("export-analyses").addEventListener("click", async () => {
  $("analyses-io-status").textContent = "Exporting…";
  try {
    const res = await fetch(`${API_BASE}/api/analyses`);
    const { analyses } = await res.json();
    const fullRecords = (
      await Promise.all(analyses.map((a) => fetch(`${API_BASE}/api/analyses/${a.id}`).then((r) => (r.ok ? r.json() : null))))
    ).filter(Boolean);

    const payload = { exportedAt: new Date().toISOString(), analyses: fullRecords };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "simpallet-saved-analyses.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    $("analyses-io-status").textContent = `Exported ${fullRecords.length} saved analyses.`;
  } catch (err) {
    $("analyses-io-status").textContent = `Export failed: ${err.message}. Is the API server running?`;
  }
});

const importAnalysesFileInput = document.createElement("input");
importAnalysesFileInput.type = "file";
importAnalysesFileInput.accept = ".json";
importAnalysesFileInput.style.display = "none";
document.body.appendChild(importAnalysesFileInput);

importAnalysesFileInput.addEventListener("change", async () => {
  const file = importAnalysesFileInput.files[0];
  importAnalysesFileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    alert(`Couldn't parse ${file.name} as JSON. (${err.message})`);
    return;
  }
  if (!payload || !Array.isArray(payload.analyses)) {
    alert(`${file.name} doesn't look like an exported Saved Analyses file (missing analyses).`);
    return;
  }

  $("analyses-io-status").textContent = "Importing…";
  try {
    let count = 0;
    for (const a of payload.analyses) {
      if (!a.workflow || !a.input || !a.solution) continue; // saveAnalysis requires all three
      await fetch(`${API_BASE}/api/analyses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: a.workflow, meta: a.meta ?? {}, input: a.input, solution: a.solution }),
      });
      count++;
    }
    $("analyses-io-status").textContent = `Imported ${count} saved analyses.`;
    renderAnalysesTable();
  } catch (err) {
    $("analyses-io-status").textContent = `Import failed: ${err.message}. Is the API server running?`;
  }
});

$("import-analyses").addEventListener("click", () => importAnalysesFileInput.click());

// User ask: "i would like to have explanations for the analysis types, so
// the user knows what they mean." One line each, describing what the
// analysis actually does/computes - not the app's own scope or
// implementation status (see the memory note on why that's kept out of
// UI copy entirely).
const WORKFLOW_DESCRIPTIONS = {
  pallet: "Arrange your product directly on a pallet - no case or carton involved.",
  case: "Design a new case around your product, then palletize the cases.",
  fillcase: "Fit your product into a case you already have, then palletize it.",
  resize: "Vary your product's own dimensions within a tolerance to find the size that palletizes best.",
  foldedcarton: "Bundle folded cartons, pack the bundles into a case, then palletize.",
  kdf: "Stack flat, unassembled (knocked-down) cases into bundles and load them directly onto a pallet.",
  multisize: "Load several different product sizes onto one shared pallet.",
};

// --- terminology follows Cape Pack: the workflow decides which pack is which
function updateHeadingForWorkflow() {
  const workflow = $("workflow").value;
  $("workflow-description").textContent = WORKFLOW_DESCRIPTIONS[workflow] ?? "";
  const isFolded = workflow === "foldedcarton";
  const isKdf = workflow === "kdf";
  const isMultisize = workflow === "multisize";
  const foldedCaseType = $("fc-casetype").value; // "new" | "stock"

  $("primary-heading").textContent =
    workflow === "pallet" ? "Secondary Pack (placed on the pallet)" : "Primary Pack";
  $("primary-pack-block").style.display = isFolded || isKdf || isMultisize ? "none" : "block";
  updateCaseContentAvailability();
  $("foldedcarton-options").style.display = isFolded ? "block" : "none";
  $("kdf-options").style.display = isKdf ? "block" : "none";
  $("multisize-options").style.display = isMultisize ? "block" : "none";
  // Folded Cartons/KDF/Multi-Sized hide the Pack Type picker entirely (their
  // "primary" is a folded-carton bundle, flatblank, or a list of products —
  // never a single selectable shape) — clear any cylinder shape left over
  // from a previous analysis so it doesn't incorrectly draw bottles inside
  // what's actually a carton bundle.
  if (isFolded || isKdf || isMultisize) {
    primaryPackBaseShape = "box";
    primaryPackCustomShape = null;
    primaryPackIsTrueCircle = false;
  }

  // Resize also designs a case around each candidate size, and Pack Folded
  // Cartons' "New Case" sub-workflow does too — all three share the Case
  // Search panel. Folded Cartons' "Stock Case" sub-workflow shares the
  // Stock Case panel the same way Fill a Stock Case does.
  const wantsCaseSearch = workflow === "case" || workflow === "resize" || (isFolded && foldedCaseType === "new");
  const wantsStockCase = workflow === "fillcase" || (isFolded && foldedCaseType === "stock");
  $("case-options").style.display = wantsCaseSearch ? "block" : "none";
  $("fillcase-options").style.display = wantsStockCase ? "block" : "none";
  $("resize-options").style.display = workflow === "resize" ? "block" : "none";
}
$("workflow").addEventListener("change", updateHeadingForWorkflow);
$("fc-casetype").addEventListener("change", updateHeadingForWorkflow);
updateHeadingForWorkflow();

// --- Load Multi-Sized Products: dynamic product rows -------------------------
// CapePack's own "Palletize Multiple size packages" — each row is one
// product size sharing the pallet (see multiSizeLoad.js's zone-split
// heuristic). Rows are built with plain DOM methods (not innerHTML string
// interpolation) since product names are free text a user types in.
let multisizeRowCount = 0;
function addMultisizeProductRow(defaults = {}) {
  const idx = multisizeRowCount++;
  const row = document.createElement("div");
  row.className = "ms-product-row";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Product Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "ms-name";
  nameInput.value = defaults.name ?? `Product ${idx + 1}`;

  function dimRow(fields) {
    const row2 = document.createElement("div");
    row2.className = "row";
    for (const { label, className, value, step } of fields) {
      const wrap = document.createElement("div");
      const l = document.createElement("label");
      l.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.className = className;
      input.value = value;
      input.min = "0"; // every field here is a dimension/weight/count — never legitimately negative
      if (step) input.step = step;
      wrap.append(l, input);
      row2.appendChild(wrap);
    }
    return row2;
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary ms-remove";
  removeBtn.textContent = "Remove Product";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(
    nameLabel,
    nameInput,
    dimRow([
      { label: "Length (mm)", className: "ms-length", value: defaults.length ?? 300 },
      { label: "Width (mm)", className: "ms-width", value: defaults.width ?? 300 },
    ]),
    dimRow([
      { label: "Height (mm)", className: "ms-height", value: defaults.height ?? 200 },
      { label: "Weight (kg)", className: "ms-weight", value: defaults.weight ?? 5, step: "0.1" },
    ]),
    dimRow([
      { label: "Absolute Maximum (optional)", className: "ms-absmax", value: defaults.absoluteMax ?? "" },
      { label: "Desired Minimum (optional)", className: "ms-desiredmin", value: defaults.desiredMin ?? "" },
    ]),
    removeBtn
  );
  $("multisize-products").appendChild(row);
}
$("multisize-add-product").addEventListener("click", () => addMultisizeProductRow());
// Seed two starter rows so the workflow isn't empty on first use.
addMultisizeProductRow({ name: "Product A" });
addMultisizeProductRow({ name: "Product B", length: 200, width: 200, height: 150, weight: 2 });

function readMultiSizeProducts() {
  return [...document.querySelectorAll("#multisize-products .ms-product-row")].map((row) => {
    const absMax = row.querySelector(".ms-absmax").value;
    const desiredMin = row.querySelector(".ms-desiredmin").value;
    return {
      name: row.querySelector(".ms-name").value.trim() || "Product",
      length: Number(row.querySelector(".ms-length").value),
      width: Number(row.querySelector(".ms-width").value),
      height: Number(row.querySelector(".ms-height").value),
      weight: Number(row.querySelector(".ms-weight").value),
      absoluteMax: absMax === "" ? undefined : Number(absMax),
      // Captured for round-trip only — not enforced by the engine, see
      // multiSizeLoad.js's own doc comment.
      desiredMin: desiredMin === "" ? undefined : Number(desiredMin),
    };
  });
}

function readAllowedVertical() {
  const allowed = [];
  if ($("p-vert-length").checked) allowed.push("length");
  if ($("p-vert-width").checked) allowed.push("width");
  if ($("p-vert-height").checked) allowed.push("height");
  return allowed.length ? allowed : ["height"]; // never allow an empty set
}

// CapePack's own "Dimensions: Inside / Outside" toggle — when the pack
// details you have on hand are the case's INSIDE cavity (e.g. from a
// structural design file), entering Board Thickness derives the OUTSIDE
// dims actually used for pallet-footprint math, x2 per axis. Thickness
// defaults to 0, so "Inside" mode is a no-op until a real thickness is
// entered — same honesty pattern as optimizeCase's caseThickness.
function readPrimary() {
  const mode = $("p-dims-mode").value;
  const t = mode === "inside" ? num("p-dims-thickness") : 0;
  return {
    length: num("p-length") + 2 * t,
    width: num("p-width") + 2 * t,
    height: num("p-height") + 2 * t,
    weight: num("p-weight"),
    netWeight: $("p-netweight").value ? num("p-netweight") : undefined, // informational only — engine ignores this
    allowedVertical: readAllowedVertical(),
    // Only optimizePallet reads this (see its own docstring) — every other
    // workflow ignores the extra property, so it's safe to always include
    // it here rather than threading a workflow check through readPrimary.
    shape: primaryPackIsTrueCircle ? "cylinder" : undefined,
  };
}

function updatePrimaryDimsMode() {
  const mode = $("p-dims-mode").value;
  $("p-thickness-row").style.display = mode === "inside" ? "grid" : "none";
  const derived = $("p-dims-derived");
  if (mode === "inside") {
    const t = num("p-dims-thickness");
    const l = num("p-length") + 2 * t;
    const w = num("p-width") + 2 * t;
    const h = num("p-height") + 2 * t;
    derived.textContent = `Outside dimensions used for calculation: ${l} × ${w} × ${h} mm`;
    derived.style.display = "block";
  } else {
    derived.style.display = "none";
  }
}
["p-dims-mode", "p-dims-thickness", "p-length", "p-width", "p-height"].forEach((id) =>
  $(id).addEventListener("input", updatePrimaryDimsMode)
);
updatePrimaryDimsMode();

// Volume to Net Weight Conversion (CapePack's own "More Settings" tool) —
// basic physics (weight = volume x specific gravity, where 1.0 SG = water's
// 1kg/L), not a proprietary CapePack formula, so safe to reproduce directly.
$("p-volweight-toggle").addEventListener("click", () => {
  const panel = $("p-volweight-panel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

function updateVolWeightResult() {
  const volume = num("p-volume");
  const sg = num("p-specificgravity");
  const result = $("p-volweight-result");
  if (!volume || !sg) {
    result.textContent = "";
    return;
  }
  result.textContent = `Net Weight: ${(volume * sg).toFixed(4)} kg`;
}
["p-volume", "p-specificgravity"].forEach((id) => $(id).addEventListener("input", updateVolWeightResult));

$("p-volweight-apply").addEventListener("click", () => {
  const volume = num("p-volume");
  const sg = num("p-specificgravity");
  if (!volume || !sg) return;
  $("p-netweight").value = Math.round(volume * sg * 10000) / 10000;
});

// Set by pickStockCase whenever a real Cases and Trays entry is picked —
// its own real per-axis Case/Tray (ID) dimensions (not always a uniform
// wallThickness x2 relationship to the OD shown in sc-length/width/height,
// see fillStockCase's own updated doc comment), fed into fillStockCase's
// insideLength/insideWidth/insideHeight override. Cleared whenever the
// pick itself is cleared (manually-typed dimensions fall back to the
// simpler uniform sc-thickness x2 model, unchanged from before).
let pickedStockCaseInsideDims = null;

function readStockCase() {
  const maxWeightRaw = $("sc-maxweight").value.trim();
  return {
    length: num("sc-length"),
    width: num("sc-width"),
    height: num("sc-height"),
    weight: num("sc-weight"),
    wallThickness: num("sc-thickness") || 0,
    ...(pickedStockCaseInsideDims ?? {}),
    maxWeight: maxWeightRaw === "" ? undefined : Number(maxWeightRaw),
    allowedVertical: readStockCaseAllowedVertical(),
  };
}

function currentResizeVolumeMode() {
  return [...document.getElementsByName("rz-volume-mode")].find((el) => el.checked)?.value ?? "fixed";
}
// volumeMode/varyVolumeBy round-trip alongside the per-axis variance
// (real CapePack's own "Vary Volume Settings" panel, user-supplied
// screenshot) but aren't read by resizePrimaryPack.js itself — only
// dependentAxis (derived below, at the one real call site) is. Increment
// is now fully per-axis (was one shared field) — see docs/ARCHITECTURE.md
// for why: real Dimensional Increment was 1/1/0, impossible to represent
// with a single shared number.
function readResizeVariance() {
  return {
    length: { minus: num("rz-length-minus"), plus: num("rz-length-plus"), increment: num("rz-length-increment") },
    width: { minus: num("rz-width-minus"), plus: num("rz-width-plus"), increment: num("rz-width-increment") },
    height: { minus: num("rz-height-minus"), plus: num("rz-height-plus"), increment: num("rz-height-increment") },
    volumeMode: currentResizeVolumeMode(),
    varyVolumeBy: num("rz-varyvolumeby"),
  };
}
function updateResizeVolumeModeUi(mode) {
  for (const el of document.getElementsByName("rz-volume-mode")) el.checked = el.value === mode;
  $("rz-varyvolumeby").disabled = mode !== "vary";
}
for (const el of document.getElementsByName("rz-volume-mode")) {
  el.addEventListener("change", () => updateResizeVolumeModeUi(el.value));
}
function setResizeVarianceFields(v = {}) {
  $("rz-length-minus").value = v.length?.minus ?? 0;
  $("rz-length-plus").value = v.length?.plus ?? 0;
  $("rz-length-increment").value = v.length?.increment ?? 5;
  $("rz-width-minus").value = v.width?.minus ?? 0;
  $("rz-width-plus").value = v.width?.plus ?? 0;
  $("rz-width-increment").value = v.width?.increment ?? 5;
  $("rz-height-minus").value = v.height?.minus ?? 0;
  $("rz-height-plus").value = v.height?.plus ?? 0;
  $("rz-height-increment").value = v.height?.increment ?? 5;
  updateResizeVolumeModeUi(v.volumeMode ?? "fixed");
  $("rz-varyvolumeby").value = v.varyVolumeBy ?? 0;
}
// Translates "Fixed Volume selected + exactly one axis at increment 0"
// into resizePrimaryPack's own explicit dependentAxis option — zero or
// 2+ zero-increment axes have no real evidence either way, so this falls
// back to undefined (today's plain independent-stepping behavior) rather
// than guessing which axis should be derived.
function resizeDependentAxis(variance) {
  if (variance.volumeMode !== "fixed") return undefined;
  const zeroAxes = ["length", "width", "height"].filter((a) => variance[a]?.increment === 0);
  return zeroAxes.length === 1 ? zeroAxes[0] : undefined;
}

// Dimensions Vertical (carton) — captured for round-trip fidelity only.
// buildFoldedCartonBundle() never reads this; it always hardcodes
// allowedVertical:["height"] (see its own doc comment — plugging the real
// "Width checked" value into a candidate bundle's own allowedVertical
// during design review got no closer to reproducing the real export).
function readFoldedCartonAllowedVertical() {
  const allowed = [];
  if ($("fc-vert-length").checked) allowed.push("length");
  if ($("fc-vert-width").checked) allowed.push("width");
  if ($("fc-vert-height").checked) allowed.push("height");
  return allowed;
}
function setFoldedCartonAllowedVertical(allowed = []) {
  $("fc-vert-length").checked = allowed.includes("length");
  $("fc-vert-width").checked = allowed.includes("width");
  $("fc-vert-height").checked = allowed.includes("height");
}

function readFoldedCartonPerCaseRange() {
  const range = {};
  const min = $("fc-percase-min").value.trim();
  const max = $("fc-percase-max").value.trim();
  if (min !== "") range.min = Number(min);
  if (max !== "") range.max = Number(max);
  return range;
}

function readFoldedCarton() {
  return {
    carton: {
      length: num("fc-length"),
      width: num("fc-width"),
      weight: num("fc-weight"),
      boardThickness: num("fc-thickness"),
      boardThickness2: num("fc-thickness2"), // captured only — see foldedCarton.js
      fluffFactor: num("fc-fluff"),
      allowedVertical: readFoldedCartonAllowedVertical(),
    },
    cartonsPerBundleRange: { min: num("fc-cartons-min"), max: num("fc-cartons-max") },
    // The old "Single Count" input mode (as opposed to Min/Max Count) had
    // no real effect — it always searched the Bundle Counts range above
    // regardless — so its own picker was removed from the UI; this always
    // searches that range now, same as it always actually behaved.
    bundleCountType: "minmax",
    // User ask ("fill in the gaps"): this used to be captured for round-
    // trip fidelity only, never actually enforced (optimizeFoldedCartonBundleCount
    // didn't accept it at all) — now a real search constraint, see that
    // function's own doc comment. Same "optional per side, blank means no
    // bound" convention as readCaseOptions' own odRange — num() on an
    // empty field returns 0, which would wrongly mean "cartonsPerCase must
    // be exactly 0" if left in unconditionally, not "no bound," so each
    // side is only included when the field actually has a value.
    cartonsPerCaseRange: readFoldedCartonPerCaseRange(),
    caseType: $("fc-casetype").value, // "new" | "stock"
  };
}

function readKdf() {
  return {
    flatblank: {
      length: num("kdf-length"),
      width: num("kdf-width"),
      weight: num("kdf-weight"),
      thickness: num("kdf-thickness"),
    },
    bundleCountRange: { min: num("kdf-min"), max: num("kdf-max") },
    heightFactor: num("kdf-heightfactor"),
    additionalStrapWeight: num("kdf-strapweight"),
    glueFlapMm: num("kdf-glueflap"),
    formulaId: $("kdf-formula").value || null,
  };
}

// readPallet() returns the TRUE physical pallet (used for 3D rendering and
// as the deck/weight-of-record) — never inflated by overhang, so the
// rendered pallet mesh always matches its real dimensions. Overhang/
// Underhang (CapePack's own Load Details field) only widens or narrows the
// FOOTPRINT used for pattern search; see searchFootprintPallet() below,
// used solely at the optimizePallet/truck/master-base call sites so boxes
// can legitimately be positioned to overhang the true pallet in the render.
function readPallet() {
  return {
    length: num("pl-length"),
    width: num("pl-width"),
    deckHeight: num("pl-deck"),
    maxHeight: num("pl-maxheight"),
    maxWeight: num("pl-maxweight"),
    weight: num("pl-weight"),
    material: $("pl-material").value,
    // Carried along purely so a saved analysis round-trips through
    // setPalletFields() — searchFootprintPallet() re-reads these fresh from
    // the DOM at Calculate time regardless, so unused by any engine call.
    overhangLength: num("pl-overhang-length"),
    overhangWidth: num("pl-overhang-width"),
  };
}

// The single pallet object used for search, buildBoxLayout (incl. its
// alternate-layer flip math), and rendering all need to agree on the SAME
// length/width, or flipped layers and box positions computed against a
// wider search footprint would be mirrored around the wrong (narrower)
// bound. So only one pallet object flows through the whole pipeline —
// overhang-widened — and the true physical dims ride along as
// trueLength/trueWidth purely for renderPallet()'s mesh geometry.
function searchFootprintPallet(pallet) {
  const overhangLength = num("pl-overhang-length");
  const overhangWidth = num("pl-overhang-width");
  if (overhangLength === 0 && overhangWidth === 0) return pallet;
  return {
    ...pallet,
    length: pallet.length + 2 * overhangLength,
    width: pallet.width + 2 * overhangWidth,
    trueLength: pallet.length,
    trueWidth: pallet.width,
  };
}

// currentContext holds whatever is currently drawn/selected, for both the
// Solutions step's summary card and the Report step's strength calculator.
let currentContext = null;

// User report: "sometimes, i get this: 'The primary pack doesn't fit
// inside this stock case...' but 3d and solutions are still available
// from the previous. clean the old analysis when a new created." Real
// bug: every showXxxSolutions function (showCaseSolutions,
// showFillCaseSolutions, ...) already replaces the results table/status
// text unconditionally, success or failure — but only calls
// selectXxxSolution (which is what actually redraws the 3D view and
// solution-summary card) when at least one result exists. On a genuine
// zero-results outcome, nothing ever told the 3D view or summary card
// that the PREVIOUS successful calculation's own currentContext was now
// stale, so they just kept showing it right next to the new "no
// solution" message. Called at the very top of the Calculate handler
// (before dispatching to any workflow) so every click starts from a
// guaranteed-clean slate — a successful outcome's own selectXxxSolution
// call immediately repopulates everything again right after, so there's
// no visible flicker for the common case, only for the genuine failure
// case this was missing for.
function clearSolutionView() {
  currentContext = null;
  renderer.domElement.style.display = "none";
  cssRenderer.domElement.style.display = "none";
  $("canvas-placeholder").style.display = "flex";
  $("canvas-controls").style.display = "none";
  $("results").hidden = true;
  $("case-canvas-wrap").hidden = true;
  $("solution-summary").innerHTML = "";
  $("report-summary").innerHTML = "";
}

// CapePack's own "Quick Report" — user-supplied field list; searched the
// downloaded user guide's extracted text for "Quick Report" and every
// field name here (Solution Number, Area Used, Cube Used, Per Layer) and
// found none of it — noted plainly rather than implied as independently
// verified. A compact summary of whichever solution is currently
// selected, prepended above the existing per-workflow summary below it
// (see renderSummary and the Report step's own summary assignment).
// Product Length/Width/Height/Gross Weight: real CapePack's own exports
// (user-supplied: Create a Case, Resize a Primary Pack, and later Build a
// Pallet) all confirm these are the LOAD's own numbers — pallet footprint
// × stack height, total weight — not any single pack's, for EVERY
// workflow that places something on a pallet, "pallet" included. This
// used to special-case "pallet" as "the live Pack & Load Details fields,
// unchanged since Calculate" on the theory that with no wrapping case,
// the primary pack IS what's placed — a reasonable-sounding guess that a
// real "Build a Pallet" export (400×300×200mm/1.5kg case, UK Standard
// pallet) directly disproved: real Product Length/Width/Height/Weight
// were 1200/1000/1400mm/105.0kg (the pallet's own full footprint at 100%
// area efficiency, 7 layers × 200mm load-only height, 70 × 1.5kg) — nowhere
// close to the box's own raw 400/300/200mm/1.5kg. optimizePallet's result
// shape (layerPositions/loadHeight/totalWeight) is identical regardless
// of what box was passed in, so there was never a structural reason
// "pallet" needed different handling. Verified by hand against 3 real
// exports independently: Create a Case's Product Gross Weight 198.0 =
// 1320 × 0.15 exactly, Resize's own Product Length/Width/Height/Weight
// (1185/992/1463.0057/216.0) and Build a Pallet's (1200/1000/1400/105.0
// above) both match this same load-level formula (bounding box of
// arranged units + stacked OD height + total weight) to within float
// rounding. Product Height is the load's own stacked height with the
// pallet's own deckHeight subtracted back out — solution.loadHeight
// itself is deck-INCLUSIVE by design (used elsewhere for 3D camera
// framing, see draw()), but real CapePack's own "Product Height" field
// is load-only: hand-verified against Create a Case's real export,
// 1452.0000mm = exactly 11 layers × 132mm case OD height, NOT 1452+150.
// loadLength/loadWidth reuse the exact formula optimize.js's own
// minLoadLength/minLoadWidth filter already uses on the same
// layerPositions shape — not a new formula. Left out entirely for kdf (a
// flat blank's own length/width/weight/thickness isn't a clean fit for
// "Product L×W×H + weight") and multisize (no single solution to
// summarize this way).
function quickReportHtml(ctx) {
  if (!ctx?.solution) return "";
  const { workflow, solution, solutionNumber, resizeInfo, caseInfo, fillInfo, pallet } = ctx;
  // kdf stays excluded on purpose (unchanged from before this fix): a flat
  // blank/bundle's own length/width/weight/thickness isn't a clean fit for
  // "Product L×W×H + weight" the way every other workflow's actual placed
  // unit is. multisize never reaches here at all (no ctx.solution, see the
  // guard above). Every workflow below shares the identical optimizePallet
  // result shape (layerPositions/loadHeight/totalWeight) regardless of
  // what box was passed in — "pallet" is NOT a special case: it was
  // wrongly treated as one before this fix (reading the raw primary-pack
  // form fields instead), an assumption a real CapePack "Build a Pallet"
  // export (user-supplied) disproved directly — Product Length/Width/
  // Height/Weight there are load-level (pallet footprint × stack height,
  // total weight), hand-verified exactly: 1200/1000/1400mm/105.0kg for a
  // 400×300×200mm/1.5kg case, 10/layer × 7 layers × 1.5kg = 105.0kg,
  // 7×200=1400mm (deck-excluded), matching the pallet's own full footprint
  // at 100% area efficiency.
  let product = null;
  if (workflow === "pallet" || workflow === "case" || workflow === "fillcase" || workflow === "foldedcarton" || workflow === "resize") {
    const loadLength = Math.max(...solution.layerPositions.map((p) => p.x + p.l));
    const loadWidth = Math.max(...solution.layerPositions.map((p) => p.y + p.w));
    const deckHeight = pallet?.deckHeight ?? 0;
    product = { length: loadLength, width: loadWidth, height: solution.loadHeight - deckHeight, weight: solution.totalWeight };
  }
  const layersLabel =
    solution.partialTopLayerCount > 0 ? `${solution.layers} + ${solution.partialTopLayerCount} partial` : `${solution.layers}`;
  // resize's primaryPerCase/totalPrimaryUnits live at a different nesting
  // level than case/fillcase's own (resizePrimaryPack.js's own return
  // shape puts primaryPerCase under caseResult but totalPrimaryUnits both
  // there and copied to the top level) — real asymmetry, not a typo.
  // Pack Folded Cartons "New Case" rows (caseInfo.cartonsPerCase/
  // totalCartons, set by optimizeFoldedCartonBundleCount) are CARTON
  // counts, not bundle counts — optimizeCase's own primaryPerCase/
  // totalPrimaryUnits mean bundles/case and total bundles there, since the
  // bundle (not the carton) is what optimizeCase treats as "primary".
  // Every other caller (Create a Case, Fill a Stock Case) has no
  // cartonsPerCase field, so this prefers the already-correct raw numbers
  // unchanged. Folded Carton's own Stock Case sub-workflow found live to
  // have the identical bundle-vs-carton gap (fillStockCase's own
  // "primary" is the bundle there too) — the calculate handler's own
  // foldedcarton/stock branch now attaches the same cartonsPerCase/
  // totalCartons fields onto fillInfo, so this checks fillInfo?.cartonsPerCase
  // too, not just caseInfo?.cartonsPerCase.
  // Inner Pack found live: caseInfo.primaryPerCase means INNER PACKS per
  // case there (optimizeCaseWithInnerPack.js keeps the case level's own
  // field name, see its doc comment), while caseInfo.totalPrimaryUnits is
  // already the real bottle count across the whole load — pairing them
  // unchanged silently broke the "primaryPerCase × Case/Load =
  // totalPrimaryUnits" identity every other workflow holds (4 inner
  // packs/case × 135 cases = 540, not the 3240 real bottles shown as
  // Carton/Load) — scale primaryPerCase up by the inner pack's own
  // primaryPerInnerPack so "Carton/Case" reports real primary units/case
  // (24) and the identity holds again (24 × 135 = 3240).
  const cartonInfo = resizeInfo
    ? { primaryPerCase: resizeInfo.caseResult.primaryPerCase, totalPrimaryUnits: resizeInfo.totalPrimaryUnits }
    : caseInfo?.cartonsPerCase != null
      ? { primaryPerCase: caseInfo.cartonsPerCase, totalPrimaryUnits: caseInfo.totalCartons }
      : caseInfo?.innerPack
        ? { primaryPerCase: caseInfo.primaryPerCase * caseInfo.innerPack.primaryPerInnerPack, totalPrimaryUnits: caseInfo.totalPrimaryUnits }
        : fillInfo?.cartonsPerCase != null
          ? { primaryPerCase: fillInfo.cartonsPerCase, totalPrimaryUnits: fillInfo.totalCartons }
          : (caseInfo ?? fillInfo);
  return `<div class="quick-report">
    <h2 style="margin-top:0">Quick Report</h2>
    <dl style="margin:0">
      ${
        product
          ? `<dt>Product Length</dt><dd>${fmtLength(product.length)}</dd>
      <dt>Product Width</dt><dd>${fmtLength(product.width)}</dd>
      <dt>Product Height</dt><dd>${fmtLength(product.height)}</dd>
      <dt>Product Gross Weight</dt><dd>${fmtWeight(product.weight)}</dd>`
          : ""
      }
      <dt>Solution Number</dt><dd>${solutionNumber ?? 1}</dd>
      <dt>Area Used</dt><dd>${(solution.areaEfficiency * 100).toFixed(1)}%</dd>
      <dt>Cube Used</dt><dd>${(solution.cubeEfficiency * 100).toFixed(1)}%</dd>
      <dt>Per Layer</dt><dd>${solution.perLayer}</dd>
      <dt>Layers</dt><dd>${layersLabel}</dd>
      <dt>Case/Load</dt><dd>${solution.totalCount}</dd>
      ${
        cartonInfo
          ? `<dt>Carton/Case</dt><dd>${cartonInfo.primaryPerCase}</dd>
      <dt>Carton/Load</dt><dd>${cartonInfo.totalPrimaryUnits}</dd>`
          : ""
      }
    </dl>
  </div>`;
}

function summaryHtml() {
  const { workflow, solution, caseInfo, fillInfo, resizeInfo, kdfInfo, pallet, multiSizeResult } = currentContext;
  const fmtDims3 = (l, w, h) => `${fmtLength(l)} × ${fmtLength(w)} × ${fmtLength(h)}`;

  if (multiSizeResult) {
    const palletWeight = pallet?.weight ?? 0;
    const rows = multiSizeResult.zones
      .map(
        (z) =>
          `<dt>${z.name}${z.infeasible ? " (doesn't fit)" : ""}</dt><dd>${z.totalCount} units, ${fmtWeight(z.totalWeight)}</dd>`
      )
      .join("");
    return `<dl style="margin:0">
      ${rows}
      <dt>Total count</dt><dd>${multiSizeResult.totalCount}</dd>
      <dt>Load weight</dt><dd>${fmtWeight(multiSizeResult.totalWeight)}</dd>
      ${palletWeight ? `<dt>Pallet weight</dt><dd>${fmtWeight(palletWeight)}</dd><dt>Gross weight (load + pallet)</dt><dd>${fmtWeight(multiSizeResult.totalWeight + palletWeight)}</dd>` : ""}
      <dt>Load height</dt><dd>${fmtLength(multiSizeResult.loadHeight)}</dd>
    </dl>`;
  }
  if (workflow === "pallet") {
    const palletWeight = pallet?.weight ?? 0;
    const layersLabel =
      solution.partialTopLayerCount > 0
        ? `${solution.layers} full + 1 partial (${solution.partialTopLayerCount})`
        : `${solution.layers}`;
    return `<dl style="margin:0">
      <dt>Strategy</dt><dd>${patternLabel(solution.strategy)}</dd>
      <dt>Per layer × layers</dt><dd>${solution.perLayer} × ${layersLabel}</dd>
      <dt>Total count</dt><dd>${solution.totalCount}</dd>
      <dt>Load weight</dt><dd>${fmtWeight(solution.totalWeight)}</dd>
      ${palletWeight ? `<dt>Pallet weight</dt><dd>${fmtWeight(palletWeight)}</dd><dt>Gross weight (load + pallet)</dt><dd>${fmtWeight(solution.totalWeight + palletWeight)}</dd>` : ""}
      <dt>Area / cube efficiency</dt><dd>${(solution.areaEfficiency * 100).toFixed(1)}% / ${(solution.cubeEfficiency * 100).toFixed(1)}%</dd>
    </dl>`;
  }
  if (workflow === "kdf") {
    const b = kdfInfo.bundle;
    return `<dl style="margin:0">
      <dt>Bundle count</dt><dd>${kdfInfo.bundleCount}</dd>
      <dt>Bundle (L×W×H)</dt><dd>${fmtDims3(b.length, b.width, b.height)}</dd>
      <dt>Bundles / pallet</dt><dd>${solution.totalCount}</dd>
      <dt>Total flat blanks</dt><dd>${kdfInfo.totalFlatblanks}</dd>
      <dt>Area / cube efficiency</dt><dd>${(solution.areaEfficiency * 100).toFixed(1)}% / ${(solution.cubeEfficiency * 100).toFixed(1)}%</dd>
    </dl>`;
  }
  // fillInfo presence (not the workflow string) decides the shape, since
  // Pack Folded Cartons reuses both "case" and "fillcase" contexts under
  // its own workflow label. The grid/fill-efficiency stay BUNDLE-level
  // (that's genuinely what's arranged inside the stock case) — only
  // "Primary / case"/"Total primary units" need the same carton-vs-bundle
  // fix as quickReportHtml's own cartonInfo above, for the same reason:
  // Folded Carton's Stock Case sub-workflow attaches cartonsPerCase/
  // totalCartons onto fillInfo (real carton counts), which every other
  // fillInfo caller (plain Fill a Stock Case) doesn't have.
  if (fillInfo) {
    const { nx, ny, nz } = fillInfo.orientation.grid;
    const primaryPerCase = fillInfo.cartonsPerCase ?? fillInfo.primaryPerCase;
    const totalPrimaryUnits = fillInfo.totalCartons ?? fillInfo.totalPrimaryUnits;
    return `<dl style="margin:0">
      <dt>Primary grid (nx × ny × nz)</dt><dd>${nx} × ${ny} × ${nz}</dd>
      <dt>Primary / case</dt><dd>${primaryPerCase}</dd>
      <dt>Case fill efficiency</dt><dd>${(fillInfo.fillEfficiency * 100).toFixed(1)}%</dd>
      <dt>Cases / pallet</dt><dd>${solution.totalCount}</dd>
      <dt>Total primary units</dt><dd>${totalPrimaryUnits}</dd>
      <dt>Pallet cube efficiency</dt><dd>${(solution.cubeEfficiency * 100).toFixed(1)}%</dd>
    </dl>`;
  }
  if (workflow === "resize") {
    const p = resizeInfo.primary;
    const d = resizeInfo.dimensionalChange;
    const c = resizeInfo.caseResult.caseDimensions;
    const fmtDelta = (v) => `${v >= 0 ? "+" : ""}${fmtLength(v)}`;
    return `<dl style="margin:0">
      <dt>Resized primary (L×W×H)</dt><dd>${fmtDims3(p.length, p.width, p.height)}</dd>
      <dt>Change vs. base</dt><dd>${fmtDelta(d.length)} / ${fmtDelta(d.width)} / ${fmtDelta(d.height)}</dd>
      <dt>Case OD (L×W×H)</dt><dd>${fmtDims3(c.length, c.width, c.height)}</dd>
      <dt>Primary / case</dt><dd>${resizeInfo.caseResult.primaryPerCase}</dd>
      <dt>Cases / pallet</dt><dd>${solution.totalCount}</dd>
      <dt>Total primary units</dt><dd>${resizeInfo.totalPrimaryUnits}</dd>
    </dl>`;
  }
  const { length, width, height } = caseInfo.caseDimensions;
  // Same carton-vs-bundle distinction as quickReportHtml's own cartonInfo
  // above — keeps this panel consistent with the Quick Report directly
  // above it instead of showing bundle counts under a "Primary / case"
  // label right next to a "Folded Carton/Case" count for the same row.
  // Same Inner Pack fix as quickReportHtml's own cartonInfo above:
  // caseInfo.primaryPerCase is inner-packs/case, not real primary/case,
  // once Inner Pack is active — scale it up so this panel's own "Primary
  // / case" × "Cases / pallet" still equals "Total primary units".
  const primaryPerCase = caseInfo.cartonsPerCase ?? (caseInfo.innerPack ? caseInfo.primaryPerCase * caseInfo.innerPack.primaryPerInnerPack : caseInfo.primaryPerCase);
  const totalPrimaryUnits = caseInfo.totalCartons ?? caseInfo.totalPrimaryUnits;
  return `<dl style="margin:0">
    <dt>Case OD (L×W×H)</dt><dd>${fmtDims3(length, width, height)}</dd>
    <dt>Primary / case</dt><dd>${primaryPerCase}</dd>
    <dt>Cases / pallet</dt><dd>${solution.totalCount}</dd>
    <dt>Total primary units</dt><dd>${totalPrimaryUnits}</dd>
    <dt>Cube efficiency</dt><dd>${(solution.cubeEfficiency * 100).toFixed(1)}%</dd>
  </dl>`;
}

// User ask ("fill in the gaps" -> CO2/cost): this app's own feature, no
// CapePack equivalent — same disclosure pattern as Inner Pack
// (optimizeCaseWithInnerPack.js). Deliberately NOT a fabricated freight/
// material-cost formula: multiplies the one gross-load-weight figure
// (product + case + pallet) by plain user-entered factors from Settings >
// General Settings. Both factors default to unset (null, not 0), so an
// analysis with neither configured renders nothing here at all rather than
// a misleading "$0.00 / 0kg CO2e" that looks calculated.
function co2CostEstimateHtml(grossWeightKg) {
  if (settings.costPerKg == null && settings.co2PerKg == null) return "";
  const rows = [];
  if (settings.costPerKg != null) {
    rows.push(`<dt>Estimated Cost</dt><dd>${(grossWeightKg * settings.costPerKg).toFixed(2)}</dd>`);
  }
  if (settings.co2PerKg != null) {
    rows.push(`<dt>Estimated CO2e</dt><dd>${(grossWeightKg * settings.co2PerKg).toFixed(2)} kg</dd>`);
  }
  return `<div class="quick-report">
    <h2 style="margin-top:0">CO2 &amp; Cost Estimate</h2>
    <p style="font-size:11px;color:var(--muted);margin:0 0 8px">This app's own feature, no CapePack equivalent — gross load weight (${fmtWeight(grossWeightKg)}) × your own Settings factors.</p>
    <dl style="margin:0">${rows.join("")}</dl>
  </div>`;
}

// Shared by every non-PDF-detailed call site (live Solution/Report Summary
// panels, the Multi-Size PDF path) — the one PDF path that models Format
// Load Additions (the pallet-style PDF, near loadGrossWeight) passes its
// own more accurate already-computed figure instead of calling this.
function grossLoadWeightKg(ctx) {
  const loadWeight = ctx.multiSizeResult ? ctx.multiSizeResult.totalWeight : ctx.solution.totalWeight;
  return loadWeight + (ctx.pallet?.weight ?? 0);
}

function renderSummary() {
  if (!currentContext) return;
  $("solution-summary").innerHTML = quickReportHtml(currentContext) + summaryHtml() + co2CostEstimateHtml(grossLoadWeightKg(currentContext));
  // Lives on the Solution step now, not Report — docs section 6: "Multi-
  // Dimensional analysis is only applicable to pallet groups." Tracks the
  // currently-shown solution directly (Calculate, a row click, or Rerun all
  // funnel through here) rather than only being set once when View Report
  // is clicked, so it can't show stale results from a previously-picked row.
  $("md-section").style.display = currentContext.workflow === "pallet" ? "block" : "none";
  $("md-results").style.display = "none";
  // Layer Editor (back in Utility's own #util-layers now — see that
  // section's comment) resets the same way — every workflow's own
  // solution-select path already funnels through this function, so this
  // stays the one reliable place to do it regardless of where the editor
  // itself lives on the page. Manage Layers assumes one shared box/case
  // and one shared layer count — doesn't cleanly apply to a mixed-size
  // load (each product zone has its own footprint and stack height).
  editedLayers = null;
  selectedBoxIdx = null; // Edit Pattern's own selection, same reasoning
  $("ml-editor").style.display = "none";
  $("ml-open").classList.remove("open"); // keep the toggle arrow in sync — a new solution collapses the editor even if it was left open
  const isMultisize = !!currentContext.multiSizeResult;
  $("manage-layers-section").style.display = isMultisize ? "none" : "block";
  $("manage-layers-unavailable-note").style.display = isMultisize ? "block" : "none";
  // Compression Strength (now Utility's own #util-strength — user: "compression
  // strength should be also be part of the utility") has the identical
  // Multisize limitation, plus its own: real CapePack's own Strength
  // program can't score cylinders/round bottles either ("This program is
  // not capable of calculating the compression strength of cylinders/round
  // bottles," from the user guide) — reproduced here rather than running
  // McKee against a diameter as if it were a rectangular case footprint,
  // which would silently fabricate a number CapePack itself refuses to
  // compute. #strength-calc-section (the real calculator) is gated
  // independently of #util-strength's own tab-switch visibility (see
  // index.html's own comment there).
  const isCylinder = !!currentContext.primaryIsTrueCircle;
  $("strength-calc-section").style.display = isMultisize || isCylinder ? "none" : "block";
  $("strength-unavailable-note").style.display = isMultisize ? "block" : "none";
  $("strength-unavailable-cylinder-note").style.display = isCylinder ? "block" : "none";
  // Format Load and Master Pallet Base have the identical Multisize
  // limitation — user, directly: "for multi size, the only available
  // utility is truck analysis in capepack." Gated the same way as
  // Compression Strength above (a wrapper section hidden/shown
  // independently of the tab itself, plus a sibling unavailable note).
  $("formatload-calc-section").style.display = isMultisize ? "none" : "block";
  $("formatload-unavailable-note").style.display = isMultisize ? "block" : "none";
  $("masterpallet-calc-section").style.display = isMultisize ? "none" : "block";
  $("masterpallet-unavailable-note").style.display = isMultisize ? "block" : "none";
  // Format Load is the default-active Utility tab (see UTILITY_TABS'
  // own order) — landing there first for a Multi-Size result would show
  // the unavailable note before anything useful, so jump straight to the
  // one tab that IS available instead.
  if (isMultisize) showUtilityTab("util-truck");

  // Format Load Additions (Utility's own #util-formatload) — a new solution
  // invalidates whatever was toggled on for the PREVIOUS one (its own
  // layers/weight no longer apply), same "reset on solution change"
  // discipline as Layer Editor/Compression Strength above. Only the state
  // resets here, cheaply — the actual re-render (which lazily builds the
  // Pack Preview's own WebGL context) is deferred to showUtilityTab, same
  // "don't build a renderer until its own tab is actually opened"
  // discipline as Layer Editor's own ml-open-gated render.
  for (const key in flItemsOn) flItemsOn[key] = false;
  // Insert Pallet Base defaults to THIS analysis's own real pallet
  // dimensions, not a generic placeholder — user-supplied real before/
  // after (Old 1608mm/68.6968kg → New 1758mm/93.6968kg after inserting
  // one under a chosen layer): the +150mm/+25kg delta matches this same
  // analysis's own pallet (Height 150mm, Weight 25kg) exactly. "Insert
  // Pallet Base" literally means inserting another physical pallet —
  // reset every new solution, same as the rest of this block, so it
  // always reflects the CURRENT pallet, not whichever one was selected
  // when the page first loaded.
  $("fl-insertbase-thickness").value = currentContext.pallet?.deckHeight ?? 0;
  $("fl-insertbase-weight").value = currentContext.pallet?.weight ?? 0;
  insertBaseUnderLayer = 1;
  renderInsertBaseLayerList();
  // Layer Pads/Trays' own per-layer table (see renderLayerRowsTable) —
  // a previous solution's picked layers/values don't carry over, same
  // "invalidated by a new solve" discipline as everything else here.
  for (const key of ["layerpads", "layertrays"]) {
    resetLayerRowsState(key);
    renderLayerRowsTable(key);
    syncLayerRowFormFields(key);
  }
  formatLoadAdjustment = null;
}

function selectPalletSolution(s, pallet, primary, caseContent, solutionNumber = 1) {
  // Snapshot at selection time, not read live from the module-level flag at
  // Report-render time — the user could change Pack Type after Calculate
  // but before View Report, and the strength section must reflect what THIS
  // solution was actually computed from, same reasoning as every other
  // field already captured into currentContext here.
  currentContext = { workflow: "pallet", pallet, solution: s, primary, caseContent, solutionNumber, primaryIsTrueCircle: primaryPackIsTrueCircle };
  draw(s, pallet, buildRenderInfo(currentContext));
  showCaseDetail(currentContext);
  renderSummary();
}

// workflowLabel lets Pack Folded Cartons reuse this exact rendering path
// (the underlying solution shape is identical — a "primary" packed into a
// case packed onto a pallet) while still reporting its own workflow name.
function selectCaseSolution(r, pallet, primary, workflowLabel = "case", solutionNumber = 1) {
  currentContext = { workflow: workflowLabel, pallet, solution: r.palletSolution, caseInfo: r, primary, solutionNumber };
  draw(r.palletSolution, pallet, buildRenderInfo(currentContext));
  showCaseDetail(currentContext);
  renderSummary();
}

function selectFillCaseSolution(r, pallet, stockCase, workflowLabel = "fillcase", solutionNumber = 1) {
  currentContext = { workflow: workflowLabel, pallet, solution: r.palletSolution, fillInfo: r, stockCase, solutionNumber };
  draw(r.palletSolution, pallet, buildRenderInfo(currentContext));
  showCaseDetail(currentContext);
  renderSummary();
}

function selectResizeSolution(r, pallet, solutionNumber = 1) {
  currentContext = { workflow: "resize", pallet, solution: r.caseResult.palletSolution, resizeInfo: r, solutionNumber };
  draw(r.caseResult.palletSolution, pallet, buildRenderInfo(currentContext));
  showCaseDetail(currentContext);
  renderSummary();
}

function selectKdfSolution(r, pallet, solutionNumber = 1) {
  currentContext = { workflow: "kdf", pallet, solution: r.palletSolution, kdfInfo: r, solutionNumber };
  draw(r.palletSolution, pallet);
  showCaseDetail(currentContext);
  renderSummary();
}

function selectMultiSizeSolution(result, pallet) {
  currentContext = { workflow: "multisize", pallet, multiSizeResult: result };
  drawMultiSize(result, pallet);
  showCaseDetail(currentContext);
  renderSummary();
}

function showPalletSolutions(solutions, pallet, primary, caseContent) {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>strategy</th><th>per layer</th><th>layers</th><th>total</th><th>weight (kg)</th><th>area eff.</th><th>cube eff.</th>";
  body.innerHTML = "";

  solutions.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    const layersLabel = s.partialTopLayerCount > 0 ? `${s.layers} + ${s.partialTopLayerCount} partial` : `${s.layers}`;
    tr.innerHTML = `<td>${patternLabel(s.strategy)}</td><td>${s.perLayer}</td><td>${layersLabel}</td><td>${s.totalCount}</td><td>${s.totalWeight.toFixed(1)}</td><td>${(s.areaEfficiency * 100).toFixed(1)}%</td><td>${(s.cubeEfficiency * 100).toFixed(1)}%</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((r) => r.classList.remove("selected"));
      tr.classList.add("selected");
      selectPalletSolution(s, pallet, primary, caseContent, i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = solutions.length ? "table" : "none";
  $("status").textContent = solutions.length
    ? `${solutions.length} solution(s) - click a row to preview it.`
    : "No feasible solution for these inputs.";

  if (solutions[0]) selectPalletSolution(solutions[0], pallet, primary, caseContent, 1);
}

// Real CapePack's own Create a Case Solution Report table (user-supplied
// 24-row export): No./Carton Arrangement/SP per Layer/Number of Layers/
// PP Per SP/PP Per Load/Secondary Pack (ID)/Pattern Type/Cube Efficiency/
// Area Efficiency/Primary Pack (OD) — 11 columns. Every value here already
// existed on optimizeCase's own return shape or palletSolution (the exact
// shape showPalletSolutions already renders Pattern Type/Area Efficiency
// from, see patternLabel/main.js:304) — this was a real display gap, not
// a missing-data one. "Carton Arrangement"'s NL-NW-NH punctuation is
// verified against the user's own one real example (120×75×120 primary →
// 4L-3W-1H → insideDimensions 480×225×120, exact match) but not against a
// second. Pattern Type can never show "Multiple" — 13 of the real 24 rows
// use it and this engine has no such pattern (see docs/ARCHITECTURE.md) —
// a disclosed, correctly-surfaced gap, not hidden.
function showCaseSolutions(results, pallet, primary, workflowLabel = "case") {
  const head = $("results-head");
  const body = $("results-body");
  // Inner Pack (this app's own feature, no CapePack equivalent — see
  // optimizeCaseWithInnerPack.js) changes what a "case" result's own
  // primaryGrid/primaryPerCase mean (inner packs, not primary units
  // directly) — real enough a difference that it gets its own table
  // shape rather than overloading the real CapePack-matching 11-column
  // one below, which stays byte-identical for the ordinary (no Inner
  // Pack) path.
  const hasInnerPack = results.length > 0 && !!results[0].innerPack;
  if (hasInnerPack) {
    head.innerHTML =
      "<th>No.</th><th>Inner Pack Arrangement</th><th>Inner Pack OD (L×W×H mm)</th>" +
      "<th>Primary/Inner Pack</th><th>Case Arrangement</th><th>Case OD (L×W×H mm)</th>" +
      "<th>Inner Packs/Case</th><th>SP/Layer</th><th>Number of Layers</th>" +
      "<th>Total Primary/Load</th><th>Pattern Type</th><th>Cube Efficiency</th><th>Area Efficiency</th>" +
      "<th>Primary Pack OD (L×W×H mm)</th>";
  } else {
    head.innerHTML =
      "<th>No.</th><th>Carton Arrangement</th><th>SP/Layer</th><th>Number of Layers</th>" +
      "<th>PP Per SP</th><th>PP Per Load</th>" +
      "<th>Secondary Pack ID (L×W×H mm)</th><th>Secondary Pack OD (L×W×H mm)</th>" +
      "<th>Pattern Type</th><th>Cube Efficiency</th><th>Area Efficiency</th>" +
      "<th>Primary Pack OD (L×W×H mm)</th>";
  }
  body.innerHTML = "";

  results.forEach((r, i) => {
    const od = r.caseDimensions;
    const ps = r.palletSolution;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    if (hasInnerPack) {
      const { nx: inx, ny: iny, nz: inz } = r.innerPack.primaryGrid;
      const { nx: cnx, ny: cny, nz: cnz } = r.primaryGrid;
      const ipOd = r.innerPack.dimensions;
      tr.innerHTML =
        `<td>${i + 1}</td><td>${inx}L-${iny}W-${inz}H</td>` +
        `<td>${ipOd.length}×${ipOd.width}×${ipOd.height}</td>` +
        `<td>${r.innerPack.primaryPerInnerPack}</td>` +
        `<td>${cnx}L-${cny}W-${cnz}H</td><td>${od.length}×${od.width}×${od.height}</td>` +
        `<td>${r.primaryPerCase}</td>` +
        `<td>${ps.perLayer}</td><td>${ps.layers}</td>` +
        `<td>${r.totalPrimaryUnits}</td>` +
        `<td>${patternLabel(ps.strategy)}</td>` +
        `<td>${(ps.cubeEfficiency * 100).toFixed(1)}%</td><td>${(ps.areaEfficiency * 100).toFixed(1)}%</td>` +
        `<td>${primary.length}×${primary.width}×${primary.height}</td>`;
    } else {
      const { nx, ny, nz } = r.primaryGrid;
      const id = r.insideDimensions;
      tr.innerHTML =
        `<td>${i + 1}</td><td>${nx}L-${ny}W-${nz}H</td>` +
        `<td>${ps.perLayer}</td><td>${ps.layers}</td>` +
        `<td>${r.primaryPerCase}</td><td>${r.totalPrimaryUnits}</td>` +
        `<td>${id.length}×${id.width}×${id.height}</td><td>${od.length}×${od.width}×${od.height}</td>` +
        `<td>${patternLabel(ps.strategy)}</td>` +
        `<td>${(ps.cubeEfficiency * 100).toFixed(1)}%</td><td>${(ps.areaEfficiency * 100).toFixed(1)}%</td>` +
        `<td>${primary.length}×${primary.width}×${primary.height}</td>`;
    }
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectCaseSolution(r, pallet, primary, workflowLabel, i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = results.length ? "table" : "none";
  $("status").textContent = results.length
    ? `${results.length} case option(s) - click a row to preview the pallet load for that case.`
    : "No feasible case/pallet combination for these inputs.";

  if (results[0]) selectCaseSolution(results[0], pallet, primary, workflowLabel, 1);
}

function showFillCaseSolutions(results, pallet, stockCase, workflowLabel = "fillcase") {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>grid (nx×ny×nz)</th><th>primary/case</th><th>fill eff.</th><th>cases/pallet</th><th>total primary units</th>";
  body.innerHTML = "";

  results.forEach((r, i) => {
    const { nx, ny, nz } = r.orientation.grid;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    tr.innerHTML = `<td>${nx}×${ny}×${nz}</td><td>${r.primaryPerCase}</td><td>${(r.fillEfficiency * 100).toFixed(1)}%</td><td>${r.palletSolution.totalCount}</td><td>${r.totalPrimaryUnits}</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectFillCaseSolution(r, pallet, stockCase, workflowLabel, i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = results.length ? "table" : "none";
  $("status").textContent = results.length
    ? `${results.length} orientation(s) fit - click a row to preview the pallet load for that fit.`
    : "The primary pack doesn't fit inside this stock case (or fails the min fill efficiency).";

  if (results[0]) selectFillCaseSolution(results[0], pallet, stockCase, workflowLabel, 1);
}

function showResizeSolutions(results, pallet) {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>primary (L×W×H)</th><th>Δ vs base</th><th>case OD</th><th>primary/case</th><th>cases/pallet</th><th>total primary units</th>";
  body.innerHTML = "";

  results.forEach((r, i) => {
    const p = r.primary;
    const d = r.dimensionalChange;
    const c = r.caseResult.caseDimensions;
    const fmtDelta = (v) => `${v >= 0 ? "+" : ""}${v}`;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    tr.innerHTML = `<td>${p.length}×${p.width}×${p.height}</td><td>${fmtDelta(d.length)}/${fmtDelta(d.width)}/${fmtDelta(d.height)}</td><td>${c.length}×${c.width}×${c.height}</td><td>${r.caseResult.primaryPerCase}</td><td>${r.caseResult.palletSolution.totalCount}</td><td>${r.totalPrimaryUnits}</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectResizeSolution(r, pallet, i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = results.length ? "table" : "none";
  $("status").textContent = results.length
    ? `${results.length} resized option(s) - click a row to preview it.`
    : "No feasible resized size within the given variance.";

  if (results[0]) selectResizeSolution(results[0], pallet, 1);
}

// Pack Folded Cartons' own "New Case" results — real Cape Pack Cloud
// Solution Report table shape (Bundle OD / SP per Layer / Number of
// Layers / Bundle per SP / PP per Bundle / PP Per SP / PP Per Load /
// Secondary Pack ID / Pattern Type / Cube+Area Efficiency), distinct from
// showCaseSolutions' own table since Bundle OD varies per row here (one
// shared `primary` doesn't work, same reason showResizeSolutions is its
// own function instead of reusing showCaseSolutions) and "PP" here means
// folded CARTONS, not the bundle optimizeCase itself treats as "primary"
// — r.cartonsPerCase/r.totalCartons (set by optimizeFoldedCartonBundleCount)
// are already the carton-level numbers, no extra math needed here.
function showFoldedCartonBundleSolutions(results, pallet) {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>No.</th><th>Bundle OD (L×W×H mm)</th><th>SP/Layer</th><th>Number of Layers</th>" +
    "<th>Bundle/SP</th><th>PP/Bundle</th><th>PP Per SP</th><th>PP Per Load</th>" +
    "<th>Secondary Pack ID (L×W×H mm)</th><th>Pattern Type</th><th>Cube Efficiency</th><th>Area Efficiency</th>";
  body.innerHTML = "";

  results.forEach((r, i) => {
    const b = r.bundle;
    const id = r.insideDimensions;
    const ps = r.palletSolution;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    tr.innerHTML =
      `<td>${i + 1}</td><td>${b.length}×${b.width}×${b.height}</td>` +
      `<td>${ps.perLayer}</td><td>${ps.layers}</td>` +
      `<td>${r.primaryPerCase}</td><td>${r.cartonsPerBundle}</td>` +
      `<td>${r.cartonsPerCase}</td><td>${r.totalCartons}</td>` +
      `<td>${id.length}×${id.width}×${id.height}</td>` +
      `<td>${patternLabel(ps.strategy)}</td>` +
      `<td>${(ps.cubeEfficiency * 100).toFixed(1)}%</td><td>${(ps.areaEfficiency * 100).toFixed(1)}%</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectCaseSolution(r, pallet, r.bundle, "foldedcarton", i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = results.length ? "table" : "none";
  $("status").textContent = results.length
    ? `${results.length} bundle/case option(s) - click a row to preview the pallet load for that option.`
    : "No feasible bundle/case/pallet combination for these inputs.";

  if (results[0]) selectCaseSolution(results[0], pallet, results[0].bundle, "foldedcarton", 1);
}

function showKdfSolutions(results, pallet) {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>bundle count</th><th>bundle L×W×H</th><th>bundles/pallet</th><th>total flat blanks</th><th>cube eff.</th>";
  body.innerHTML = "";

  results.forEach((r, i) => {
    const b = r.bundle;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    tr.innerHTML = `<td>${r.bundleCount}</td><td>${b.length}×${b.width}×${b.height.toFixed(1)}</td><td>${r.palletSolution.totalCount}</td><td>${r.totalFlatblanks}</td><td>${(r.palletSolution.cubeEfficiency * 100).toFixed(1)}%</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectKdfSolution(r, pallet, i + 1);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = results.length ? "table" : "none";
  $("status").textContent = results.length
    ? `${results.length} bundle count option(s) - click a row to preview it.`
    : "No feasible bundle count within the given range.";

  if (results[0]) selectKdfSolution(results[0], pallet, 1);
}

// Load Multi-Sized Products doesn't produce a ranked list of alternative
// solutions the way the pattern search does elsewhere — the zone-split
// heuristic gives one result. The results table instead breaks that one
// result down per product zone (clicking any row just re-selects the same
// overall result — there's nothing else to switch to).
function showMultiSizeSolutions(result, pallet) {
  const head = $("results-head");
  const body = $("results-body");
  head.innerHTML =
    "<th>product</th><th>box footprint (mm)</th><th>per layer</th><th>layers</th><th>total</th><th>weight (kg)</th>";
  body.innerHTML = "";

  if (!result) {
    $("results-table").style.display = "none";
    $("status").textContent = "Add at least one product.";
    return;
  }

  result.zones.forEach((z, i) => {
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === 0 ? " selected" : "");
    // "zone" no longer means a footprint sub-region (products now stack
    // FULL layers on top of each other, not side by side — see
    // multiSizeLoad.js) — this column instead shows the product's own
    // placed footprint, or "doesn't fit" when infeasible.
    const footprintLabel = z.infeasible
      ? "doesn't fit"
      : `${z.boxFootprint.l.toFixed(0)} × ${z.boxFootprint.w.toFixed(0)} × ${z.boxFootprint.h.toFixed(0)}`;
    const layersLabel = z.partialUnitsInLastLayer > 0 ? `${z.layers - 1} + 1 partial` : `${z.layers}`;
    tr.innerHTML = `<td>${z.name}</td><td>${footprintLabel}</td><td>${z.perLayer}</td><td>${layersLabel}</td><td>${z.totalCount}</td><td>${z.totalWeight.toFixed(1)}</td>`;
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectMultiSizeSolution(result, pallet);
    });
    body.appendChild(tr);
  });

  $("results-table").style.display = result.zones.length ? "table" : "none";
  const infeasibleCount = result.zones.filter((z) => z.infeasible).length;
  $("status").textContent = infeasibleCount
    ? `${result.totalCount} total units across ${result.zones.length} product zones - ${infeasibleCount} product(s) don't fit their zone (try adjusting Share).`
    : `${result.totalCount} total units across ${result.zones.length} product zones.`;

  selectMultiSizeSolution(result, pallet);
}

// --- library pickers --------------------------------------------------------
const modal = $("library-modal");
const grid = $("library-grid");

// Every "Select From Library" picker fills plain number/text inputs with no
// visual change of its own — easy to miss that anything happened at all.
// This is the one shared confirmation shown right under the button that was
// clicked, for every picker (library selection AND file import alike).
// itemId (when the picked item has one) is remembered so the picker can
// highlight the current selection if reopened; onClear (when given) adds a
// "✕" button that undoes the pick — resets whatever fields it set back to
// their defaults, forgets the tracked id, and hides this banner again.
// icon (when given) shows the picked item's own thumbnail — user ask: "show
// selected images also, not only as text." Deliberately only passed by
// callers for real physical items (shapes/pallets/trucks/packs/stock cases);
// board grades, case types, liner/medium/flute materials, folded-carton
// factors, and pack names all only ever carry the same shared placeholder
// icon (icons/board.svg — see TABLE_STYLE_LIBRARY_TYPES), so showing it here
// would reintroduce exactly the "why are they like packages?" confusion
// that made those types a plain data table instead of icon cards in the
// first place. Text-only stays correct for those.
const selectedLibraryItemIds = {}; // selId -> item.id, for grid highlight on reopen

// User request: fields populated FROM a real picked library item (Pack
// Type/Stock Case/Pallet/Truck — a real, specific thing with its own fixed
// spec) should go inactive rather than stay silently editable, so there's
// no way to end up with a "Selected: Soda Can" badge next to dimensions
// that no longer match a real Soda Can. Deliberately NOT applied to the
// separate "Load example dimensions from library…" link (pickPrimaryPack/
// clearPrimaryPackFields) — that one is explicitly a starting point meant
// to be edited, not a real selected item, so it stays fully editable.
// Only locks the specific field ids a given pick actually wrote (callers
// pass exactly that list), so a picked item with no weight of its own
// leaves the weight field editable rather than locking a value it never
// set. Unlocking happens the same way, via the same id list, from the
// "✕ Clear" button's own onClear callback markSelected already wires up.
function lockFields(ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) el.disabled = true;
  }
}
function unlockFields(ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) el.disabled = false;
  }
}
// User request (follow-up): Clear used to leave a DIFFERENT filled-in
// number behind (this app's own generic default) instead of genuinely
// emptying the field — still looked like "a real item is configured"
// even with the badge gone. Blanks each field outright instead, paired
// with unlockFields in every "✕ Clear" callback below. Only ever called
// on plain number inputs (never <select>/color swatches, which have no
// real "blank" state of their own).
function blankFields(ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) el.value = "";
  }
}

function markSelected(selId, text, { itemId, onClear, icon } = {}) {
  const el = $(selId);
  if (!el) return;
  if (itemId !== undefined) selectedLibraryItemIds[selId] = itemId;
  el.innerHTML = "";

  const content = document.createElement("div");
  content.className = "lib-selected-content";
  if (icon) {
    const img = document.createElement("img");
    img.src = `../library/${icon}`;
    img.alt = "";
    img.className = "lib-selected-thumb";
    content.appendChild(img);
  }
  const label = document.createElement("span");
  label.textContent = `✓ Selected: ${text}`;
  content.appendChild(label);
  el.appendChild(content);

  if (onClear) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "lib-clear-btn";
    clearBtn.title = "Clear this selection";
    clearBtn.textContent = "✕ Clear";
    clearBtn.addEventListener("click", () => {
      delete selectedLibraryItemIds[selId];
      el.style.display = "none";
      el.innerHTML = "";
      onClear();
    });
    el.appendChild(clearBtn);
  }
  el.style.display = "flex";
}

// Only called for the remaining icon-card types (TABLE_STYLE_LIBRARY_TYPES
// bypasses this entirely) — every branch here corresponds to exactly one
// card-mode type's own field shape: shapes (baseShape), pallets
// (deckHeight), trucks (maxHeight), format-load-profiles (weight+
// thickness, no length), and the plain L×W×H fallback for packs/stock-cases.
function libraryDims(item) {
  if (item.baseShape !== undefined) {
    const support = item.engineSupport === "planned" ? "bounding-box approx." : "full support";
    const hasDims = item.lengthMm !== undefined && item.lengthMm !== null;
    const dimsOrSupport = hasDims
      ? `${item.lengthMm} × ${item.widthMm} × ${item.heightMm} mm${item.zae ? " (uploaded)" : ""}`
      : support;
    const thicknessPart = item.thickness ? ` · ${item.thickness}mm thick` : "";
    return `${item.baseShape} · ${dimsOrSupport}${thicknessPart}`;
  }
  if (item.deckHeight !== undefined) {
    return `${item.length} × ${item.width} mm, ${item.maxWeight} kg max${item.material ? `, ${item.material}` : ""}`;
  }
  if (item.maxHeight !== undefined) return `${item.length} × ${item.width} × ${item.maxHeight} mm`;
  // Format Load's 11 categories each have a genuinely different field set
  // (see FORMAT_LOAD_FIELD_SCHEMAS) — checked by category, not by which
  // fields happen to be present, since e.g. Horizontal Straps has no
  // thickness at all and would otherwise fall through to the generic
  // weight+thickness line below.
  if (FORMAT_LOAD_PROFILE_CATEGORIES.includes(item.category)) {
    const schema = FORMAT_LOAD_FIELD_SCHEMAS[item.category] ?? [];
    const parts = schema
      .map((f) => {
        const v = item[f.key];
        if (f.type === "checkbox") {
          if (!v) return null;
          // Grouped checkboxes (Horizontal Corner Posts' Top/Bottom ×
          // Length 1/2, Width 1/2) share their plain label across both
          // groups ("Length 1" alone can't tell Top from Bottom apart on
          // the card) — prefix with a short group tag when one exists.
          const groupTag = f.group?.replace(" Horizontal Corner Posts", "");
          return groupTag ? `${groupTag}: ${f.label}` : f.label;
        }
        if (v === undefined || v === null || v === "") return null;
        if (f.type === "select") return v;
        const unit = f.label.match(/\(([a-z]+)\)/i)?.[1] ?? "";
        return `${v}${unit}`;
      })
      .filter(Boolean);
    return parts.length ? parts.join(", ") : item.category;
  }
  if (item.weight !== undefined && item.thickness !== undefined) return `${item.weight} kg, ${item.thickness}mm thick`;
  if (item.length === undefined) return item.category ?? ""; // defensive fallback — no card-mode type currently hits this
  return `${item.length} × ${item.width} × ${item.height} mm`;
}

// editable=true adds per-card Edit/Delete controls and a Built-in/Custom
// badge — used for the real API-backed library, never for imported-from-
// file rows (those aren't persisted, so nothing to edit) or the offline
// static-JSON fallback (read-only, no server to write to).
// These types aren't physical objects to pick from a catalog — they're
// parameters/factors/spec-sheet rows (a strength multiplier, a material
// property, a bare label) with no real dimensions or shape, so the box-icon
// card grid built for pallets/packs/etc. made them look like products on a
// shelf. Rendered as a plain data table instead, with columns generated
// straight from each type's own LIBRARY_FIELD_SCHEMAS entry.
const TABLE_STYLE_LIBRARY_TYPES = new Set([
  "board-grades",
  "case-configurations",
  "printing-factors",
  "partition-factors",
  "case-proportion-factors",
  "fluting-orientation-factors",
  "liner-materials",
  "medium-materials",
  "flute-takeup-factors",
  "efficiency-factors",
  "folded-carton-types",
  "folded-carton-boards",
  "pack-names",
  "storage-environment-factors",
  "packages",
  // Real CapePack's own Pallet/Truck Base Styles screens (user-supplied
  // screenshot data for both) are data tables with an Include In List
  // checkbox column, not an icon-card gallery — see
  // LIBRARY_VISIBILITY_TOGGLE_TYPES below.
  "pallets",
  "trucks",
  // "Select Stock Case" (Fill a Stock Case / Pack Folded Cartons) used to
  // fall through to the generic card grid's plain L×W×H fallback — broke
  // once Cases and Trays gained its own real idLength/idWidth/idHeight/
  // odLength/odWidth/odHeight shape (that fallback only ever knew the old
  // flat length/width/height), so this now uses the same table rendering
  // as everything else with real per-field columns — see
  // LIBRARY_FIELD_SCHEMAS["stock-cases"] for exactly which ones.
  "stock-cases",
  // Real CapePack's own Layer Pads Profiles screen (user-supplied
  // screenshot: No./Description/Weight/Thickness/Color) is also a data
  // table, not the icon-card gallery this type had rendered as since
  // Format Load Profiles was first built — a real, user-facing gap this
  // closes for all 11 categories at once (they're one type, differing
  // only by .category, not 11 separate types).
  "format-load-profiles",
]);

// Types whose admin table (Databases menu only — never a mid-analysis
// picker, see openLibrary's respectIncludeInList) shows a per-row "Include
// In List" checkbox plus Include All/Exclude All. Real CapePack's own
// Pallet Base Styles screen has this (218 styles in the user's real
// account, most of them presumably hidden from day-to-day use) — a
// genuine personal-curation feature, not an org/multi-tenant one like
// "Manage Databases", so it's implemented for real rather than disclosed
// as out of scope. Unlike real CapePack's own draft-checkboxes-then-Apply
// flow, each toggle here commits immediately (see renderLibraryTable) —
// simpler and avoids losing unsaved toggles if the user types into Search
// before clicking a since-removed Apply button. Truck Base Styles has the
// exact same real column (user-supplied screenshot: Include In List/No./
// Name/Description/Length/Width/Height/Weight/Units/Visibility, 33 real
// entries) — same treatment.
const LIBRARY_VISIBILITY_TOGGLE_TYPES = new Set(["pallets", "trucks"]);
// Types whose Add form offers "Load existing X style" (see the block
// below that renders it) — currently the same two types as the toggle
// above, but named separately since the two features are conceptually
// distinct and only happen to coincide today; a future type could want
// one without the other.
const LIBRARY_LOAD_EXISTING_TYPES = new Set(["pallets", "trucks"]);

function renderLibraryGrid(
  items,
  onPick,
  {
    editable = false,
    type = null,
    onChanged = null,
    selectedId = null,
    showVisibilityToggle = false,
    closeOnPick = true,
  } = {}
) {
  if (TABLE_STYLE_LIBRARY_TYPES.has(type)) {
    renderLibraryTable(items, onPick, { editable, type, onChanged, selectedId, showVisibilityToggle, closeOnPick });
    return;
  }
  grid.className = "library-grid";
  grid.innerHTML = items.length
    ? ""
    : "<p style='padding:8px;color:var(--muted);font-size:12px'>No matches.</p>";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = item.id !== undefined && item.id === selectedId ? "library-card selected" : "library-card";
    const badge = item.isBuiltin === undefined ? "" : `<span class="lib-badge">${item.isBuiltin ? "Built-in" : "Custom"}</span>`;
    const actions = editable ? `<div class="lib-actions"><button data-act="edit" title="Edit">✎</button><button data-act="del" title="Delete">✕</button></div>` : "";
    card.innerHTML = `${badge}${actions}<img src="../library/${item.icon}" alt="" /><div class="lib-name">${item.name}</div><div class="lib-dims">${libraryDims(item)}</div>`;
    card.title = item.note || "";
    card.addEventListener("click", () => {
      onPick(item);
      if (closeOnPick) modal.style.display = "none";
    });
    if (editable) {
      card.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        // "shapes" has its own richer Add/Edit UI (optional .zae upload) —
        // see the comment on #custom-shapes-modal for why this database
        // doesn't use the generic name+note form every other type does.
        if (type === "shapes") openShapeEditor(item, onChanged);
        else if (type === "stock-cases") openCasesTraysForm(item, onChanged);
        else showLibraryForm(type, item, onChanged);
      });
      card.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
        await fetch(`${API_BASE}/api/library/${type}/${item.id}`, { method: "DELETE" });
        onChanged();
      });
    }
    grid.appendChild(card);
  }
}

// Plain data table for TABLE_STYLE_LIBRARY_TYPES — columns generated from
// the type's own schema, so each type shows exactly its own fields (e.g.
// Match Value/Factor for Storage Environment, ECT/Caliper for Board
// Grades). Several of these types ARE real pickers used mid-analysis
// (Select Board Grade, Select Case Type, Select Liner, etc.), so — unlike a
// first pass at this — row click still fires onPick + closes the modal,
// exactly like the icon-card grid; only the Edit/Delete buttons stop that
// (via stopPropagation) to act on the row without picking it.
//
// board-grades' wall/flute aren't in its editable schema (set automatically
// by which Databases sub-menu — Single/Double/Triple Wall — you added from,
// same as category elsewhere), but "Select Board Grade" opens ALL of them
// unfiltered, so wall/flute are still shown here as read-only columns —
// otherwise a picker mixing single/double/triple wall boards would have no
// way to tell them apart (the old icon-card view showed this too).
// `compute(item, units)` is an escape hatch for a column that isn't a
// plain stored field — `key` alone (read via item[key]) covers board-
// grades' Wall/Flute below; stock-cases' Volume/Units genuinely need to
// be computed (Volume isn't stored at all — casesTraysVolumeDisplay
// already existed for exactly this, just never wired in before; Units
// isn't per-item, every record is stored canonically regardless of what
// was typed at save time — see UNIT_KINDS — so this just reflects
// whatever Report Units currently is, same value in every row).
const LIBRARY_TABLE_EXTRA_COLUMNS = {
  "board-grades": [
    { key: "wall", label: "Wall" },
    { key: "flute", label: "Flute" },
  ],
  // Real CapePack's own Cases and Trays table (user-supplied export):
  // Pack Name/Pack Type/Case-Tray(ID)/Volume/Tray Wall Height/Units/
  // Case-Tray(OD)/Mat. Weight — this app's own table had ID/OD (from the
  // regular schema below) and Mat. Weight, but was missing these three.
  // Ordered to land between Pack Type and the ID columns, matching the
  // real table's own column order as closely as the existing
  // extra-columns-before-schema-columns rendering order allows.
  "stock-cases": [
    { key: "trayWallHeight", label: "Tray Wall Height", unitKind: "length" },
    {
      compute: (item, units) => roundTo(casesTraysVolumeDisplay(item, units), 3),
      label: (units) => `Volume (${units === "imperial" ? "in³" : "cm³"})`,
    },
    { compute: (_item, units) => (units === "imperial" ? "in/lb" : "mm/kg"), label: "Units" },
  ],
};

// The library API only has PUT (full replace, see updateLibraryItem in
// db.js) — no PATCH/merge route — so toggling this one field means
// sending the item's own other fields back unchanged alongside it, not
// just {includeInList}. id/isBuiltin aren't real data_json columns (see
// rowToLibraryItem), so they're stripped before the round-trip.
async function setIncludeInList(type, item, value, onChanged) {
  const { id, isBuiltin, ...data } = item;
  await fetch(`${API_BASE}/api/library/${type}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, includeInList: value }),
  });
  onChanged();
}

function renderLibraryTable(
  items,
  onPick,
  { editable, type, onChanged, selectedId, showVisibilityToggle = false, closeOnPick = true }
) {
  grid.className = "library-grid table-mode";

  if (showVisibilityToggle && editable) {
    const toolbar = document.createElement("div");
    // table-mode's #library-grid is padding:0 (the table's own cell
    // padding handles its edges) — but this toolbar isn't table content,
    // so it needs its own padding, matching the 16px the search row above
    // it uses, or it sits flush against the modal's edges (direct user
    // feedback after the modal itself went full-screen with padding:0).
    toolbar.style.cssText = "display:flex;gap:8px;padding:10px 16px 0";
    const includeAllBtn = document.createElement("button");
    includeAllBtn.textContent = "Include All";
    includeAllBtn.className = "secondary";
    includeAllBtn.style.cssText = "width:auto;margin:0;padding:6px 10px;font-size:11px";
    includeAllBtn.addEventListener("click", async () => {
      await Promise.all(items.map((i) => setIncludeInList(type, i, true, () => {})));
      onChanged();
    });
    const excludeAllBtn = document.createElement("button");
    excludeAllBtn.textContent = "Exclude All";
    excludeAllBtn.className = "secondary";
    excludeAllBtn.style.cssText = "width:auto;margin:0;padding:6px 10px;font-size:11px";
    excludeAllBtn.addEventListener("click", async () => {
      await Promise.all(items.map((i) => setIncludeInList(type, i, false, () => {})));
      onChanged();
    });
    toolbar.append(includeAllBtn, excludeAllBtn);
    grid.innerHTML = "";
    grid.appendChild(toolbar);
  } else {
    grid.innerHTML = "";
  }

  if (!items.length) {
    grid.insertAdjacentHTML("beforeend", "<p style='padding:8px;color:var(--muted);font-size:12px'>No matches.</p>");
    return;
  }
  // format-load-profiles has no entry in LIBRARY_FIELD_SCHEMAS at all (11
  // genuinely different field sets live in FORMAT_LOAD_FIELD_SCHEMAS
  // instead, keyed by category, not type) — same resolution
  // showLibraryForm already does. Every item this function is ever
  // called with for this type shares one category (openLibrary always
  // filters format-load-profiles down to a single category before
  // rendering, see DATABASES_MENU's Format Load entries), so the first
  // item's own category is a safe, always-correct source — there's no
  // "mixed categories in one table" case to worry about. Without this,
  // every Format Load Profile admin table silently showed zero of its
  // real columns (just Name + actions) — a real, user-facing gap fixed
  // alongside the Description-label/Color-field additions below.
  const category = type === "format-load-profiles" ? items[0]?.category : null;
  // board-grades' rich per-wall schema only applies when every row shown
  // shares one wall (the Single/Double/Triple Wall Boards admin views,
  // filtered via DATABASES_MENU's own { field: "wall", ... }) — the
  // generic unfiltered "Select Board Grade" picker mixes all three wall
  // counts in one table, where there's no single right column set, so it
  // keeps the plain ectLbIn→ectRc/caliperIn schema plus the existing
  // Wall/Flute summary columns (see extraColumns below) instead.
  const wall =
    type === "board-grades" && items.length && items.every((i) => i.wall === items[0].wall) ? items[0].wall : null;
  const rawSchema =
    type === "format-load-profiles"
      ? FORMAT_LOAD_FIELD_SCHEMAS[category] ?? []
      : wall
        ? BOARD_GRADE_FIELD_SCHEMAS[wall] ?? []
        : LIBRARY_FIELD_SCHEMAS[type] ?? [];
  // unit-select fields (see LIBRARY_FIELD_SCHEMAS.pallets) are an Add-form-
  // only entry convenience — nothing under that key is ever actually
  // persisted (see showLibraryForm's save handler), so they're excluded
  // from the auto-generated columns here; rendering one would show
  // "undefined" in every row.
  const schema = rawSchema.filter((f) => f.type !== "unit-select");
  // Grouped checkbox fields (Horizontal Corner Posts' Top/Bottom ×
  // Length1/2, Width1/2) render as one merged 2-column grid in the Add
  // form (see its own `group` handling), but real CapePack's admin table
  // for this exact category (user-supplied screenshot) condenses each
  // group into ONE summary column ("Top Corner Post"/"Bottom Corner
  // Post" showing "L1, L2, W1, W2" or whichever are checked), not one
  // column per checkbox — an earlier pass here rendered 8 separate
  // columns instead (with a "Top"/"Bottom" prefix to at least
  // disambiguate the resulting duplicate headers), which was a
  // reasonable guess at the time but is now known to not match the real
  // screen. This groups schema fields into an ordered column plan once,
  // used for both the header row and every data row below, so a grouped
  // set of checkboxes only ever produces one column no matter how many
  // fields are actually in it.
  const columnPlan = [];
  const seenGroups = new Set();
  for (const f of schema) {
    if (!f.group) {
      columnPlan.push({ kind: "field", field: f });
    } else if (!seenGroups.has(f.group)) {
      seenGroups.add(f.group);
      columnPlan.push({ kind: "group", group: f.group, fields: schema.filter((sf) => sf.group === f.group) });
    }
  }
  // Suppressed once the rich per-wall schema is showing its own Flute
  // columns (F1/F2/F3) — the summary Wall/Flute columns exist only to
  // disambiguate the unfiltered mixed picker (see `wall` above).
  const extraColumns = wall ? [] : LIBRARY_TABLE_EXTRA_COLUMNS[type] ?? [];
  const table = document.createElement("table");
  // Scoped to types dense enough to need it (currently just pallets, via
  // showVisibilityToggle) — table-layout:fixed + explicit column widths
  // (see .lib-name-col/.lib-wrap-col/.lib-num-col) stop Name/Description
  // ballooning the whole table to fit one long value, but applying it to
  // every table-mode type unscoped would also flatten simpler ones (board-
  // grades, storage-environment-factors, etc.) into equal-width columns
  // they never needed and were never designed around.
  if (showVisibilityToggle) table.className = "lib-dense-table";
  // Tight, capped-width columns for numbers (a handful of digits never
  // needs 100+px) and wrapping instead of content-driven growth for
  // longer free text (Name/Description) — without this, a single long
  // name/description drove the WHOLE column (and the table's total
  // scrollWidth) far wider than its actual content needed, which was the
  // real reason Pallet Base Styles' table didn't fit even at full screen
  // (direct user feedback: wider and full-screen both tried first, Name +
  // Description alone were ~590 of 1541 total px).
  // "No." (a plain row index) turned out not to be specific to the
  // Include In List toggle at all — real CapePack's Layer Pads Profiles
  // screen (user-supplied screenshot) has a No. column with no visibility
  // toggle in sight, same as Pallet Base Styles did. Kept as a real,
  // always-present column for every table-mode type rather than
  // re-coupling it to showVisibilityToggle a second time now that there's
  // direct evidence from two different real screens it isn't the same
  // feature.
  const nameHeader = type === "format-load-profiles" || type === "board-grades" ? "Description" : "Name";
  const headCells = [
    ...(showVisibilityToggle ? [`<th class="lib-visibility-header">Include In List</th>`] : []),
    `<th class="lib-no-col">No.</th>`,
    `<th class="lib-name-col">${nameHeader}</th>`,
    ...extraColumns.map((c) => `<th class="lib-num-col">${typeof c.label === "function" ? c.label(settings.units) : c.label}</th>`),
    ...columnPlan.map((col) => {
      if (col.kind === "group") {
        return `<th class="lib-short-col">${FORMAT_LOAD_GROUP_TABLE_HEADERS[col.group] ?? col.group}</th>`;
      }
      const f = col.field;
      // Every schema field needs a width class, not just number/text —
      // under table-layout:fixed (dense tables only, see .lib-dense-table)
      // any column left without one would get an arbitrary equal share of
      // whatever space remains, not a considered size.
      const cls = f.type === "number" ? "lib-num-col" : f.type === "text" ? "lib-wrap-col" : "lib-short-col";
      // Unit-kind fields carry a bare header/label (no unit baked in) —
      // the actual suffix is appended live from settings.units here, not
      // hardcoded, so the table always matches the global unit setting
      // (see UNIT_KINDS).
      const headerText = f.unitKind ? `${f.header ?? f.label} (${unitKindSuffix(f.unitKind)})` : f.header ?? f.label;
      return `<th${cls ? ` class="${cls}"` : ""}>${headerText}</th>`;
    }),
    "<th></th>",
  ].join("");
  table.innerHTML = `<thead><tr>${headCells}</tr></thead>`;
  const tbody = document.createElement("tbody");

  items.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.className = item.id !== undefined && item.id === selectedId ? "lib-row selected" : "lib-row";
    tr.title = item.note || "";

    if (showVisibilityToggle) {
      const toggleTd = document.createElement("td");
      toggleTd.className = "lib-visibility-cell";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.includeInList !== false;
      cb.disabled = !editable;
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => setIncludeInList(type, item, cb.checked, onChanged));
      toggleTd.appendChild(cb);
      tr.appendChild(toggleTd);
    }
    const noTd = document.createElement("td");
    noTd.className = "lib-no-col";
    noTd.textContent = String(index + 1);
    tr.appendChild(noTd);

    const nameTd = document.createElement("td");
    nameTd.className = "lib-name-col";
    nameTd.textContent = item.name;
    tr.appendChild(nameTd);
    for (const c of extraColumns) {
      const td = document.createElement("td");
      td.className = "lib-num-col";
      if (c.compute) {
        td.textContent = c.compute(item, settings.units);
      } else if (c.unitKind) {
        td.textContent = item[c.key] != null ? roundTo(unitKindToDisplay(c.unitKind, item[c.key], settings.units), 4) : "-";
      } else {
        td.textContent = item[c.key] ?? "-";
      }
      tr.appendChild(td);
    }
    for (const col of columnPlan) {
      const td = document.createElement("td");
      if (col.kind === "group") {
        // "L1, L2, W1, W2" (or whichever are actually checked) in one
        // cell, matching the real admin table — see the columnPlan
        // comment above for why this isn't one column per checkbox.
        td.className = "lib-short-col";
        const checked = col.fields.filter((f) => item[f.key]).map((f) => f.shortLabel ?? f.label);
        td.textContent = checked.length ? checked.join(", ") : "-";
        tr.appendChild(td);
        continue;
      }
      const f = col.field;
      if (f.type === "number") td.className = "lib-num-col";
      else if (f.type === "text") td.className = "lib-wrap-col";
      else td.className = "lib-short-col";
      // A small swatch reads better than a bare hex string, and setting
      // .style directly (vs string-interpolating into innerHTML) can't be
      // used to inject arbitrary HTML/CSS even from a malformed value.
      if (f.type === "color" && item[f.key]) {
        const swatch = document.createElement("span");
        swatch.style.cssText = "display:inline-block;width:16px;height:16px;border-radius:3px;vertical-align:middle;margin-right:6px;border:1px solid #0002";
        swatch.style.background = item[f.key];
        td.append(swatch, document.createTextNode(item[f.key]));
      } else if (f.unitKind && typeof item[f.key] === "number") {
        // Converted live from this app's own canonical storage unit to
        // whatever settings.units currently is — see UNIT_KINDS.
        td.textContent = roundTo(unitKindToDisplay(f.unitKind, item[f.key], settings.units), 4);
      } else {
        td.textContent = item[f.key];
      }
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => {
      onPick(item);
      if (closeOnPick) modal.style.display = "none";
    });

    const actionsTd = document.createElement("td");
    actionsTd.className = "lib-table-actions";
    if (editable) {
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Edit";
      editBtn.className = "secondary";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (type === "stock-cases") openCasesTraysForm(item, onChanged);
        else showLibraryForm(type, item, onChanged);
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.className = "secondary";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
        await fetch(`${API_BASE}/api/library/${type}/${item.id}`, { method: "DELETE" });
        onChanged();
      });
      actionsTd.append(editBtn, delBtn);
    }
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  grid.appendChild(table);
}

// Per-type form fields for Add/Edit — deliberately just the fields each
// picker's onPick actually reads, not every field the static JSON happens
// to carry (standard/category are set automatically, not user-edited).
const LIBRARY_FIELD_SCHEMAS = {
  // Real CapePack's own Add form (user-supplied screenshot) leads with a
  // mandatory Units choice, then Name/Description/Length/Width/Height/
  // Weight/Material — units type "unit-select" (see showLibraryForm) is an
  // ENTRY-TIME convenience only: whichever unit you pick, the length/weight
  // fields below (tagged unitKind) get converted to this app's one
  // canonical storage unit (mm/kg, same as literally everywhere else in
  // this app) at Save time, and nothing about which unit was originally
  // used is persisted — so Edit always shows the stored mm/kg values with
  // Units reset to Metric, not whatever was typed in originally. That's a
  // deliberate simplification (avoids threading a stored-unit flag through
  // every reader of a pallet item, for a purely typing convenience) over
  // real CapePack's own behavior, which may remember the original unit.
  pallets: [
    { key: "units", label: "Units", type: "unit-select", options: ["Metric (mm/kg)", "Imperial (in/lb)"] },
    { key: "description", label: "Description", type: "text" },
    // No unit baked into label/header — both the admin table's column
    // and the form field's own label now show whichever unit is live
    // (the global setting, or this entry's own Units toggle above while
    // editing — see UNIT_KINDS/updateUnitSuffixes in showLibraryForm and
    // the unitKind branch in renderLibraryTable).
    { key: "length", label: "Length", header: "Length", type: "number", unitKind: "length" },
    { key: "width", label: "Width", header: "Width", type: "number", unitKind: "length" },
    { key: "deckHeight", label: "Height", header: "Height", type: "number", unitKind: "length" },
    { key: "maxWeight", label: "Max weight", header: "Max wt", type: "number", unitKind: "weight" },
    {
      key: "tareWeight",
      label: "Pallet's own weight",
      header: "Tare wt",
      type: "number",
      unitKind: "weight",
    },
    // Was tracked in the seed JSON but never editable here — the New
    // Analysis pallet panel (pl-material) already had a material picker,
    // just with a guessed option list (Wood/Plastic/Corrugated/Metal/
    // Presswood); user corrected both to CapePack's real four: Wood,
    // Plastic, Paper Based, Fibre.
    { key: "material", label: "Material", type: "select", options: ["Wood", "Plastic", "Paper Based", "Fibre"] },
    { key: "color", label: "Change Color", header: "Color", type: "color" },
  ],
  // Real CapePack's own Truck Base Styles Add form (user-supplied
  // screenshot) — Units*/Name*/Description*/Length*/Width*/Height*/
  // Weight*, "Load existing truck style", Change Color. Same unit-select
  // convention as pallets (see that comment above). No Material field —
  // the real form doesn't have one for trucks. maxWeight is this app's
  // own addition (not in CapePack's Truck Base Style schema at all — its
  // one "Weight" field is tare weight, matching tareWeight below) kept
  // because Truck Analysis genuinely needs a payload capacity to
  // calculate anything; still gets unitKind so it converts consistently
  // when entered under Imperial.
  trucks: [
    { key: "units", label: "Units", type: "unit-select", options: ["Metric (mm/kg)", "Imperial (in/lb)"] },
    { key: "description", label: "Description", type: "text" },
    { key: "length", label: "Length", header: "Length", type: "number", unitKind: "length" },
    { key: "width", label: "Width", header: "Width", type: "number", unitKind: "length" },
    { key: "maxHeight", label: "Height", header: "Height", type: "number", unitKind: "length" },
    { key: "tareWeight", label: "Weight", header: "Weight", type: "number", unitKind: "weight" },
    { key: "maxWeight", label: "Max payload", header: "Max payload", type: "number", unitKind: "weight" },
    { key: "color", label: "Change Color", header: "Color", type: "color" },
  ],
  packs: [
    { key: "length", label: "Length", type: "number", unitKind: "length" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    { key: "height", label: "Height", type: "number", unitKind: "length" },
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
  ],
  // Plain fallback for the one case that can't know which wall-count
  // schema applies (see showLibraryForm's own wall-resolution comment):
  // "+ Add New" from the generic unfiltered "Select Board Grade" picker.
  // Field names match the rich per-wall schema (BOARD_GRADE_FIELD_SCHEMAS)
  // so a board added here still works with the same picker callbacks.
  "board-grades": [
    { key: "ectRc", label: "EC (RC)", type: "number", unitKind: "edgeCrush" },
    { key: "caliperIn", label: "Caliper", type: "number", unitKind: "caliper" },
  ],
  // Display columns only for the generic "Select Stock Case" picker (Fill
  // a Stock Case / Pack Folded Cartons workflows) — Add/Edit is routed to
  // the bespoke openCasesTraysForm instead (see openLibrary's own
  // type==="stock-cases" special case, matching "shapes"'s own pattern),
  // since this type's real fields (computed Volume, conditional Tray Wall
  // Height, per-axis Number of Thicknesses) don't fit the generic
  // {key,label,type} shape. Kept simpler than the bespoke admin table —
  // Volume/Tray Wall Height aren't shown here, since this generic system
  // has no computed-column support.
  "stock-cases": [
    { key: "packType", label: "Pack Type", type: "text" },
    { key: "idLength", label: "ID Length", type: "number", unitKind: "length" },
    { key: "idWidth", label: "ID Width", type: "number", unitKind: "length" },
    { key: "idHeight", label: "ID Height", type: "number", unitKind: "length" },
    { key: "odLength", label: "OD Length", type: "number", unitKind: "length" },
    { key: "odWidth", label: "OD Width", type: "number", unitKind: "length" },
    { key: "odHeight", label: "OD Height", type: "number", unitKind: "length" },
    { key: "weight", label: "Material weight", type: "number", unitKind: "weight" },
    { key: "maxWeight", label: "Max weight", type: "number", unitKind: "weight" },
  ],
  // Real CapePack's own Folded Carton Factors > Boards table (user-supplied
  // screenshot) — internal key stays boardThickness (buildFoldedCartonBundle,
  // packing-engine, already destructures carton.boardThickness), header
  // relabeled to just "Thickness" to match that real column exactly.
  "folded-carton-boards": [
    { key: "boardThickness", label: "Thickness", header: "Thickness", type: "number", unitKind: "length" },
    { key: "fluffFactor", label: "Fluff Factor", type: "number" },
  ],
  // Folded Carton Factors > Carton Types table (user-supplied screenshot) —
  // dimensionless multiplier factors (same as Material Factors' own Liner/
  // Medium/Takeup factors elsewhere in this app), no unitKind. Not wired
  // into any calculation — see db.js's LIBRARY_TYPES comment.
  "folded-carton-types": [
    { key: "thickness1Factor", label: "Thickness 1 Factor", type: "number" },
    { key: "thickness2Factor", label: "Thickness 2 Factor", type: "number" },
    { key: "fluffFactor", label: "Fluff Factor", type: "number" },
  ],
  "pack-names": [],
  // Real CapePack's own Packages screen (user-supplied screenshot: table +
  // Add form) — was a generic Name + Note stub (no confirmed field spec
  // available at the time); replaced with the real fields, all handled by
  // this existing generic form/table engine with no code changes needed
  // beyond the schema itself. "Pack Name" is the existing built-in Name
  // field. "Package Description" is real and required on the real form —
  // kept separate from this generic form's own "Note (optional)" field
  // (every other type's own free-text annotation) rather than conflated
  // with it, since real CapePack has both a required Description AND
  // (like every other database here) room for this app's own note.
  // "Dimensions Vertical" reuses the same Length/Width/Height concept as
  // Primary Pack's own allowedVertical (readAllowedVertical) but is a
  // single required choice here (one stored orientation for a saved
  // preset), not a multi-select (multiple candidate orientations for a
  // live search) — a genuinely different field for a different purpose,
  // so not the same key. Stored capitalized ("Length"/"Width"/"Height",
  // matching the real screen's own option text) rather than lowercase
  // like allowedVertical's own array values — cosmetic only, nothing
  // currently reads this field back to care about casing (not yet wired
  // into any calculation, same status as Carton Types — see db.js).
  // "Pack Type" defaults to "Standard Box" on the real Add form; this
  // engine's plain text fields have no schema-level default (only
  // existingItem values pre-fill), so a brand new entry starts blank
  // instead — a minor, disclosed gap rather than restricting it to a
  // closed dropdown of the 3 example values actually seen (Standard Box/
  // End Loader Box/RSC Box), which is more likely a free-text field that
  // merely happens to draw its default from the real Pack Type Library —
  // "End Loader"/"RSC" both being real, already-confirmed Pack Type
  // Library names (see shapes.json's own "Case/Tray Pack Type" category)
  // is suggestive but not enough to justify wiring this to that same
  // picker without a real screenshot showing a "Select From Library"
  // button on Packages' own Add form the way Cases and Trays has one.
  // Tray Wall Height is real (a real table column, "-" in all 3 example
  // rows) but shown unconditionally here rather than gated on Pack Type
  // containing "Tray" the way Cases and Trays' own bespoke form does —
  // this type uses the plain generic form/table engine, which has no
  // conditional-field mechanism; an acceptable simplification for a field
  // that's usually blank anyway.
  packages: [
    { key: "label", label: "Label", type: "text" },
    { key: "packType", label: "Pack Type", header: "Pack Type", type: "text" },
    { key: "description", label: "Package Description", header: "Description", type: "text" },
    { key: "units", label: "Units", type: "unit-select", options: ["Metric (mm/kg)", "Imperial (in/lb)"] },
    { key: "length", label: "Length", type: "number", unitKind: "length" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    { key: "height", label: "Height", type: "number", unitKind: "length" },
    { key: "trayWallHeight", label: "Tray Wall Height", type: "number", unitKind: "length" },
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "absoluteMaximum", label: "Absolute Maximum", type: "number" },
    { key: "desiredMinimum", label: "Desired Minimum", type: "number" },
    { key: "dimensionVertical", label: "Dimensions Vertical", type: "select", options: ["Length", "Width", "Height"] },
    { key: "color", label: "Change Color", header: "Color", type: "color" },
  ],
  // No entry for "shapes" — it never reaches showLibraryForm. Its Add/Edit
  // needs an optional .zae upload (name/category/baseShape/thickness/note
  // plus a dropzone), which doesn't fit this generic number/text/select
  // schema, so openLibrary/renderLibraryGrid route type==="shapes" to
  // openShapeEditor (see the comment on #custom-shapes-modal) instead.
  "case-configurations": [{ key: "caseTypeFactor", label: "Case Type Factor (× RSC baseline)", type: "number" }],
  // Case Configuration's real remaining sub-databases — see db.js's
  // LIBRARY_TYPES comment and applyStrengthFactorChain in compression.js.
  "printing-factors": [{ key: "factor", label: "Printing Factor", type: "number" }],
  "partition-factors": [{ key: "factor", label: "Partition Factor", type: "number" }],
  "case-proportion-factors": [{ key: "factor", label: "Case Proportion Factor", type: "number" }],
  "fluting-orientation-factors": [{ key: "factor", label: "Fluting Orientation Factor", type: "number" }],
  // Material Factors' 4th sub-database — a bracket row like Storage
  // Environment's own (see lookupEfficiencyFactor), so the boundary itself
  // is editable alongside the factor, not just the factor.
  "efficiency-factors": [
    {
      key: "maxBurstTestLb",
      label: "Max Burst Test - this bracket's upper bound",
      type: "number",
      unitKind: "pressure",
    },
    { key: "factor", label: "Efficiency Factor", type: "number" },
  ],
  "liner-materials": [
    { key: "basisWeight", label: "Basis Weight", type: "number", unitKind: "basisWeight" },
    { key: "ringCrush", label: "Ring Crush", type: "number", unitKind: "edgeCrush" },
    { key: "stfi", label: "STFI", type: "number", unitKind: "edgeCrush" },
  ],
  "medium-materials": [
    { key: "basisWeight", label: "Basis Weight", type: "number", unitKind: "basisWeight" },
    { key: "ringCrush", label: "Ring Crush", type: "number", unitKind: "edgeCrush" },
    { key: "stfi", label: "STFI", type: "number", unitKind: "edgeCrush" },
  ],
  "flute-takeup-factors": [
    { key: "takeupFactor", label: "Takeup Factor", type: "number" },
    { key: "caliperIn", label: "Caliper", type: "number", unitKind: "caliper" },
  ],
  // No entry for "format-load-profiles" — docs section 11.5's own text is
  // generic ("Enter the Description, Weight and Thickness") but the 11
  // profile types genuinely don't share one field set (e.g. Horizontal
  // Straps has no thickness, Vertical Straps has no weight-only shape).
  // showLibraryForm resolves FORMAT_LOAD_FIELD_SCHEMAS[category] instead,
  // one category at a time — see that map, defined near
  // FORMAT_LOAD_PROFILE_CATEGORIES below.
  // Storage Environment's 6 factor groups (docs "Storage Environment
  // Database") mix bracket-style groups (Humidity/Days/Overhang, matched by
  // an upper bound) and enum-style groups (Orientation/Stacking/Surface,
  // matched by an exact key like "base"/"stacked"/"solid") — one text field
  // covers both without needing two different schemas, since the actual
  // bracket-vs-enum interpretation happens at calculation time, not storage
  // time (see buildStorageEnvironmentTable). "999" / "999999" are this
  // app's existing sentinel values for "and over" (no literal Infinity in
  // JSON), matching what the original hardcoded <select> options already used.
  "storage-environment-factors": [
    {
      key: "matchValue",
      label: "Match Value (a range's upper bound, e.g. 55 or 999999 for \"and over\" - or the exact key for Orientation/Stacking/Surface, e.g. base/side/end)",
      header: "Match Value", // short form for the table column — the long label above is form-only guidance
      type: "text",
    },
    { key: "factor", label: "Factor (multiplier)", type: "number" },
  ],
};

const FORMAT_LOAD_PROFILE_CATEGORIES = [
  "Layer Pads Profiles",
  "Layer Trays Profiles",
  "Top Board Profiles",
  "Top Cap Profiles",
  "Picture Frame Profiles",
  "Horizontal Corner Posts Profiles",
  "Vertical Corner Posts Profiles",
  "Horizontal Straps Profiles",
  "Vertical Straps Profiles",
  "Shroud Profiles",
  "Stretch Wrap Profiles",
];

// Per-category Add/Edit fields for Format Load Profiles — user-supplied,
// cross-checked against the one Additions screenshot this session could
// find (docs 8.1.1, "Add Vertical Corner Posts": Weight*/Thickness*/
// Width*/Color*, no Length or Position — a real discrepancy with the
// fuller list given here, flagged rather than silently resolved either
// way, see docs/ARCHITECTURE.md) and against this app's own pre-existing
// Format Load Additions wiring (wireFormatLoadProfilePicker), which
// already omits thickness for Horizontal Straps/Stretch Wrap exactly as
// given — independent confirmation for those two before this pass touched
// anything. Keys are chosen to match what that existing wiring already
// reads (weight/thickness) wherever a category carries those fields, so
// the 4 categories already wired into the load calculation keep working
// unchanged; the other 7 are schema/database-only for now, same
// "disclosed, not silently built beyond what was asked" scoping as
// elsewhere in this file.
// Every category ends with `color` — real CapePack's own Layer Pads
// Profiles Add form (user-supplied screenshot: No./Description/Weight/
// Thickness/Color in the admin table; Description*/Weight*/Thickness*/
// Color* in the Add form, no separate Name field at all — see
// showLibraryForm/renderLibraryTable's format-load-profiles special case
// for that) has one; applied to all 11 categories on the reasonable
// inference that they're the same CapePack subsystem's accessory
// profiles, not individually re-verified per category the way Weight/
// Thickness/Height/Width already were from the original field-list task.
const FORMAT_LOAD_FIELD_SCHEMAS = {
  "Layer Pads Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  "Layer Trays Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "height", label: "Height", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  "Top Board Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  // User said "layer cap"; the docs' own Additions list (8.1) names this
  // "top caps" and this app's own category has always been "Top Cap
  // Profiles" — treated as the same thing, not a 12th category.
  "Top Cap Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "height", label: "Height", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  "Picture Frame Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  // "Top"/"Bottom" Horizontal Corner Posts each independently choose which
  // of the load footprint's 4 edges get a post (Length 1/2, Width 1/2) —
  // refined from an earlier pass's plain 2-checkbox version once the user
  // gave the real per-edge breakdown. `group` marks these 8 as one grouped
  // 2×2 checkbox grid, not 8 standalone rows — see showLibraryForm's
  // field-rendering loop. See the inline diagram it renders for this one
  // category (user: "an image explanation needed" / "with an image").
  "Horizontal Corner Posts Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    // Real CapePack's own Add form (user-supplied screenshot) shows this
    // as a plain-integer field suffixed "%", not mm like the others —
    // corroborated by the real table showing the identical value (95) on
    // two otherwise-unrelated products (C-Flute, Fiberboard), which reads
    // as "95% of the load's own length" (a sensible shared default a post
    // length would scale with), not a coincidental identical absolute
    // length in mm. Corrected from an earlier, unverified "Length (mm)".
    { key: "length", label: "Length (%)", type: "number" },
    // shortLabel: the real admin table (same screenshot) condenses each
    // group into ONE column ("Top Corner Post"/"Bottom Corner Post")
    // showing which of its 4 are checked as a short comma list ("L1, L2,
    // W1, W2"), not 4 separate columns per side — see
    // FORMAT_LOAD_GROUP_TABLE_HEADERS and renderLibraryTable's column-
    // plan logic. label itself matches the real Add form's own exact
    // wording ("Length1", no space — confirmed from the same screenshot).
    { key: "topLength1", label: "Length1", shortLabel: "L1", type: "checkbox", group: "Top Horizontal Corner Posts" },
    { key: "topLength2", label: "Length2", shortLabel: "L2", type: "checkbox", group: "Top Horizontal Corner Posts" },
    { key: "topWidth1", label: "Width1", shortLabel: "W1", type: "checkbox", group: "Top Horizontal Corner Posts" },
    { key: "topWidth2", label: "Width2", shortLabel: "W2", type: "checkbox", group: "Top Horizontal Corner Posts" },
    { key: "bottomLength1", label: "Length1", shortLabel: "L1", type: "checkbox", group: "Bottom Horizontal Corner Posts" },
    { key: "bottomLength2", label: "Length2", shortLabel: "L2", type: "checkbox", group: "Bottom Horizontal Corner Posts" },
    { key: "bottomWidth1", label: "Width1", shortLabel: "W1", type: "checkbox", group: "Bottom Horizontal Corner Posts" },
    { key: "bottomWidth2", label: "Width2", shortLabel: "W2", type: "checkbox", group: "Bottom Horizontal Corner Posts" },
    { key: "color", label: "Color", type: "color" },
  ],
  "Vertical Corner Posts Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    // Same correction as Horizontal Corner Posts Profiles and for the
    // same reason (user-supplied screenshot): a plain-integer field
    // suffixed "%", not mm. Cross-checked here too — this category's real
    // Fiberboard entry (1.13kg/6.4mm/76mm, hand-converted from the
    // screenshot's lb/in) matches Horizontal Corner Posts' own real
    // Fiberboard entry almost exactly, confirming both categories share
    // the same real corner-post material data, just shown in different
    // unit systems across the two screenshots.
    { key: "length", label: "Length (%)", type: "number" },
    { key: "position", label: "Position", type: "select", options: ["Bottom", "Center", "Top"] },
    { key: "color", label: "Color", type: "color" },
  ],
  "Horizontal Straps Profiles": [
    // Real CapePack's own label (user-supplied screenshot) is "Num. of
    // Straps", not "Number of Straps" — matched exactly.
    { key: "numberOfStraps", label: "Num. of Straps", type: "number" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "color", label: "Color", type: "color" },
  ],
  // Real CapePack's own Add form (user-supplied screenshot) shows "Across
  // Length"/"Across Width" with no unit suffix at all (unlike Width,
  // explicitly "in"), and the real data's values for both are small plain
  // integers (2) — read as a strap COUNT across each axis, not a length
  // measurement, so neither gets a "(mm)" label or unitKind. The 4th
  // field is genuinely "Weight", not "Height" — an earlier, unverified
  // guess at this category's fields had it wrong; corrected here, and the
  // one pre-existing placeholder entry's stray unused `thickness` value
  // (a field that was never even in this category's own schema) replaced
  // with real fields for the corrected set.
  "Vertical Straps Profiles": [
    { key: "acrossLength", label: "Across Length", type: "number" },
    { key: "acrossWidth", label: "Across Width", type: "number" },
    { key: "width", label: "Width", type: "number", unitKind: "length" },
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "includePalletBase", label: "Include Pallet Base", type: "checkbox" },
    { key: "color", label: "Color", type: "color" },
  ],
  "Shroud Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "thickness", label: "Thickness", type: "number", unitKind: "length" },
    { key: "color", label: "Color", type: "color" },
  ],
  // No Color field, confirmed by the real Add form (user-supplied
  // screenshot: Description*/Weight*/Include Pallet Base/Include Pallet
  // Top, nothing else) — Color was added to all 11 categories earlier on
  // the inference that they're one CapePack subsystem sharing the same
  // fields, verified per-category as each one's real screenshot arrived.
  // Stretch wrap is the first direct counterexample: physically it's
  // usually just clear/translucent plastic film, so a distinguishing
  // "color" catalog attribute not existing here is consistent with real
  // CapePack's own field list, not just an omission in this one
  // screenshot.
  "Stretch Wrap Profiles": [
    { key: "weight", label: "Weight", type: "number", unitKind: "weight" },
    { key: "includePalletBase", label: "Include Pallet Base", type: "checkbox" },
    { key: "includePalletTop", label: "Include Pallet Top", type: "checkbox" },
  ],
};

// board-grades' real field set genuinely varies by wall count (real
// Single/Double/Triple Wall Board screens, user-supplied exports) — a
// single-wall board has 2 liners/1 medium/1 flute, double has 3/2/2,
// triple has 4/3/3 — same "one type, several real schemas keyed by a
// sub-field" shape as FORMAT_LOAD_FIELD_SCHEMAS above (keyed by .wall
// instead of .category; see renderLibraryTable/showLibraryForm's own
// wall-resolution). Liner/medium refs are the material's basis weight as
// a bare string (e.g. "23", "56H" — matches liner-materials.json's own
// name convention) and flutes are the bare letter ("A"/"B"/"C") — text,
// not a picker link, matching exactly what the real table itself shows
// (no evidence CapePack's own Add form links these to the Material
// Factors database rather than just recording the value).
const BOARD_GRADE_FIELD_SCHEMAS = {
  single: [
    { key: "burstTestLb", label: "Burst Test", type: "number", unitKind: "pressure" },
    { key: "liner1", label: "L1", type: "text" },
    { key: "medium1", label: "M1", type: "text" },
    { key: "liner2", label: "L2", type: "text" },
    { key: "flute1", label: "F1", type: "text" },
    { key: "ectRc", label: "EC (RC)", type: "number", unitKind: "edgeCrush" },
    { key: "ectStfi", label: "EC (STFI)", type: "number", unitKind: "edgeCrush" },
    { key: "ectCustom", label: "EC (Custom)", type: "number", unitKind: "edgeCrush" },
    { key: "caliperIn", label: "Caliper", type: "number", unitKind: "caliper" },
  ],
  double: [
    { key: "burstTestLb", label: "Burst Test", type: "number", unitKind: "pressure" },
    { key: "liner1", label: "L1", type: "text" },
    { key: "medium1", label: "M1", type: "text" },
    { key: "liner2", label: "L2", type: "text" },
    { key: "medium2", label: "M2", type: "text" },
    { key: "liner3", label: "L3", type: "text" },
    { key: "flute1", label: "F1", type: "text" },
    { key: "flute2", label: "F2", type: "text" },
    { key: "ectRc", label: "EC (RC)", type: "number", unitKind: "edgeCrush" },
    { key: "ectStfi", label: "EC (STFI)", type: "number", unitKind: "edgeCrush" },
    { key: "ectCustom", label: "EC (Custom)", type: "number", unitKind: "edgeCrush" },
    { key: "caliperIn", label: "Caliper", type: "number", unitKind: "caliper" },
  ],
  triple: [
    { key: "burstTestLb", label: "Burst Test", type: "number", unitKind: "pressure" },
    { key: "liner1", label: "L1", type: "text" },
    { key: "medium1", label: "M1", type: "text" },
    { key: "liner2", label: "L2", type: "text" },
    { key: "medium2", label: "M2", type: "text" },
    { key: "liner3", label: "L3", type: "text" },
    { key: "medium3", label: "M3", type: "text" },
    { key: "liner4", label: "L4", type: "text" },
    { key: "flute1", label: "F1", type: "text" },
    { key: "flute2", label: "F2", type: "text" },
    { key: "flute3", label: "F3", type: "text" },
    { key: "ectRc", label: "EC (RC)", type: "number", unitKind: "edgeCrush" },
    { key: "ectStfi", label: "EC (STFI)", type: "number", unitKind: "edgeCrush" },
    { key: "ectCustom", label: "EC (Custom)", type: "number", unitKind: "edgeCrush" },
    { key: "caliperIn", label: "Caliper", type: "number", unitKind: "caliper" },
  ],
};

// The Add form's own group name (long, used as the fieldset legend — see
// showLibraryForm's grouped-checkbox rendering) vs. the admin table's
// shorter column header for that same group (see renderLibraryTable's
// column-plan logic) — both confirmed from the real Horizontal Corner
// Posts Profiles screenshot: form says "Top Horizontal Corner Posts",
// table column says just "Top Corner Post".
const FORMAT_LOAD_GROUP_TABLE_HEADERS = {
  "Top Horizontal Corner Posts": "Top Corner Post",
  "Bottom Horizontal Corner Posts": "Bottom Corner Post",
};

// Two small diagrams explaining Horizontal Corner Posts' checkboxes,
// injected into the Add/Edit form only for that one category (see
// showLibraryForm). (1) A plan (top-down) view of the load's footprint,
// showing which physical edge each of Length 1/2, Width 1/2 refers to —
// the genuinely ambiguous part now that each of Top/Bottom expanded from
// one checkbox to four (user: "an image explanation needed" / "with an
// image"). (2) A side view showing what "Top" vs "Bottom" itself means —
// a short post reinforcing just one band of the stack height, contrasted
// with a Vertical Corner Post (dashed, shown only for comparison — a
// different profile type, not controlled by these checkboxes) which runs
// the full height. Axis orientation (Length = horizontal, Width =
// vertical) matches this app's own fixed convention elsewhere (X=Length).
const HORIZONTAL_CORNER_POSTS_DIAGRAM_HTML = `
  <div style="margin:10px 0;padding:10px;border:1px solid var(--border);border-radius:8px;background:#fafbfc">
    <div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;align-items:center">
      <div style="text-align:center">
        <svg viewBox="0 0 180 150" width="150" height="125" style="display:block" xmlns="http://www.w3.org/2000/svg">
          <rect x="30" y="30" width="120" height="80" fill="#e8d9b5" stroke="#b8a172" stroke-width="1"/>
          <line x1="30" y1="106" x2="150" y2="106" stroke="#2563eb" stroke-width="5" stroke-linecap="round"/>
          <line x1="30" y1="34" x2="150" y2="34" stroke="#059669" stroke-width="5" stroke-linecap="round"/>
          <line x1="34" y1="30" x2="34" y2="110" stroke="#d97706" stroke-width="5" stroke-linecap="round"/>
          <line x1="146" y1="30" x2="146" y2="110" stroke="#dc2626" stroke-width="5" stroke-linecap="round"/>
          <text x="90" y="125" font-size="9" fill="#6b7280" text-anchor="middle" font-family="sans-serif">Length axis</text>
          <text x="14" y="70" font-size="9" fill="#6b7280" text-anchor="middle" font-family="sans-serif" transform="rotate(-90 14 70)">Width axis</text>
        </svg>
      </div>
      <div style="text-align:center">
        <svg viewBox="0 0 200 150" width="120" height="90" style="display:block" xmlns="http://www.w3.org/2000/svg">
          <rect x="20" y="120" width="140" height="10" fill="#8a5a2b"/>
          <rect x="30" y="20" width="120" height="100" fill="#e8d9b5" stroke="#b8a172" stroke-width="1.5"/>
          <line x1="30" y1="53" x2="150" y2="53" stroke="#b8a172"/>
          <line x1="30" y1="87" x2="150" y2="87" stroke="#b8a172"/>
          <line x1="30" y1="120" x2="30" y2="20" stroke="#9aa0a6" stroke-width="4" stroke-dasharray="4 3"/>
          <path d="M 30 20 L 30 42 M 30 20 L 50 20" stroke="#2563eb" stroke-width="6" fill="none" stroke-linecap="round"/>
          <path d="M 30 120 L 30 98 M 30 120 L 50 120" stroke="#d97706" stroke-width="6" fill="none" stroke-linecap="round"/>
        </svg>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text);display:flex;flex-direction:column;gap:4px;margin-top:8px">
      <span><span style="display:inline-block;width:10px;height:10px;background:#059669;border-radius:2px;margin-right:5px"></span>Length 1 - the near edge running along the length axis</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#2563eb;border-radius:2px;margin-right:5px"></span>Length 2 - the far edge running along the length axis</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#d97706;border-radius:2px;margin-right:5px"></span>Width 1 - the near edge running along the width axis</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#dc2626;border-radius:2px;margin-right:5px"></span>Width 2 - the far edge running along the width axis</span>
      <span style="margin-top:2px">Right diagram: Top/Bottom is a separate choice - which band of the stack <em>height</em> gets a post (dashed line: a Vertical Corner Post, a different profile type, shown only for comparison - runs the full height).</span>
    </div>
  </div>
`;

const LIBRARY_CATEGORIES = {
  pallets: "Pallet",
  trucks: "Container",
  packs: "Primary Pack Example",
  "board-grades": "Board Grade",
  "stock-cases": "Stock Case Example",
  "folded-carton-boards": "Folded Carton Board",
  "folded-carton-types": "Folded Carton Type",
  "pack-names": "Pack Name",
  packages: "Package",
  shapes: "Cases and Trays",
  "case-configurations": "Case Configuration",
  "printing-factors": "Printing Factor",
  "partition-factors": "Partition Factor",
  "case-proportion-factors": "Case Proportion Factor",
  "fluting-orientation-factors": "Fluting Orientation Factor",
  "liner-materials": "Liner Material",
  "medium-materials": "Medium Material",
  "flute-takeup-factors": "Flute Takeup Factor",
  "efficiency-factors": "Efficiency Factor",
  "format-load-profiles": "Layer Pads Profiles",
  "storage-environment-factors": "Storage Environment: Humidity",
};

const STORAGE_ENV_FACTOR_CATEGORIES = [
  "Storage Environment: Humidity",
  "Storage Environment: Days of Storage",
  "Storage Environment: Case Orientation",
  "Storage Environment: Stacking",
  "Storage Environment: Pallet Overhang",
  "Storage Environment: Pallet Surface",
];

// itemFilter mirrors openLibrary's own param: a category string, or a
// { field, value } pair (e.g. board-grades' { field: "wall", value:
// "single" }) — new items created from a filtered Databases sub-view are
// auto-tagged with it, so e.g. "Add" from "Single Wall Boards" produces a
// board actually filed under wall:"single", with no separate UI selector
// needed for a distinction the sub-menu itself already made unambiguous.
function showLibraryForm(type, existingItem, onSaved, itemFilter = null) {
  const filterField = typeof itemFilter === "string" ? "category" : itemFilter?.field;
  const filterValue = typeof itemFilter === "string" ? itemFilter : itemFilter?.value;
  // format-load-profiles has no single shared schema (11 genuinely
  // different field sets, see FORMAT_LOAD_FIELD_SCHEMAS) — resolved from
  // the category itself, known either from the item being edited or from
  // which Databases sub-menu "+ Add New" was clicked from.
  const category = existingItem?.category ?? (filterField === "category" ? filterValue : null);
  // board-grades: same idea, resolved from .wall instead of .category —
  // known either from the item being edited or from which Single/Double/
  // Triple Wall Boards sub-menu "+ Add New" was clicked from. Falls back
  // to the plain schema (no wall known at all) for the one edge case
  // that can't determine it: "+ Add New" from the generic unfiltered
  // "Select Board Grade" picker, which was already wall-agnostic before
  // this schema existed.
  const wall = existingItem?.wall ?? (filterField === "wall" ? filterValue : null);
  const schema =
    type === "format-load-profiles"
      ? FORMAT_LOAD_FIELD_SCHEMAS[category] ?? []
      : type === "board-grades" && wall
        ? BOARD_GRADE_FIELD_SCHEMAS[wall] ?? []
        : LIBRARY_FIELD_SCHEMAS[type] ?? [];
  const container = $("library-form-fields");
  container.innerHTML = "";

  // Real CapePack's own Format Load Profile Add forms (user-supplied
  // Layer Pads Profiles screenshot) have no separate Name field at all —
  // "Description" is the one identifying text field. Board Grades' own
  // real screen uses "Description" too. Relabeled here only (the
  // underlying data key stays "name" — every consumer of an item's name,
  // the table's Name/Description column header aside, is unaffected by
  // what the form calls the field it's editing).
  const nameLabel = document.createElement("label");
  nameLabel.textContent = type === "format-load-profiles" || type === "board-grades" ? "Description" : "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = existingItem?.name ?? "";
  container.append(nameLabel, nameInput);

  if (category === "Horizontal Corner Posts Profiles") {
    container.insertAdjacentHTML("beforeend", HORIZONTAL_CORNER_POSTS_DIAGRAM_HTML);
  }

  // "Load existing pallet/truck style" (real CapePack's own Add forms,
  // user-supplied screenshots of both) — a template convenience, only
  // meaningful when ADDING (editing already starts from one real item):
  // picking an existing style copies its field values into this still-
  // unsaved form, so Save still creates a brand new entry rather than
  // overwriting the one loaded from. Placed right after Name rather than
  // matching the real forms' bottom-of-form position — loading a template
  // BEFORE looking at/adjusting the fields below reads more naturally
  // than after.
  if (LIBRARY_LOAD_EXISTING_TYPES.has(type) && !existingItem) {
    const loadNoun = { pallets: "pallet", trucks: "truck" }[type] ?? type;
    const loadLabel = document.createElement("label");
    loadLabel.textContent = `Load existing ${loadNoun} style`;
    const loadSelect = document.createElement("select");
    loadSelect.innerHTML = '<option value="">- none -</option>';
    container.append(loadLabel, loadSelect);
    fetch(`${API_BASE}/api/library/${type}`)
      .then((r) => r.json())
      .then(({ items }) => {
        for (const it of items) {
          const opt = document.createElement("option");
          opt.value = it.id;
          opt.textContent = it.name;
          loadSelect.appendChild(opt);
        }
        loadSelect.onchange = () => {
          const picked = items.find((it) => it.id === loadSelect.value);
          if (!picked) return;
          nameInput.value = picked.name;
          if (unitSelectInput) unitSelectInput.value = unitSelectInput.options[0].value; // loaded values are already canonical mm/kg
          for (const field of schema) {
            if (field.type === "unit-select" || !fieldInputs[field.key]) continue;
            const val = picked[field.key];
            if (field.type === "checkbox") fieldInputs[field.key].checked = val ?? false;
            else fieldInputs[field.key].value = val ?? (field.type === "color" ? "#8a5a34" : "");
          }
          noteInput.value = picked.note ?? "";
          updateUnitSuffixes();
        };
      })
      .catch(() => {
        loadSelect.disabled = true;
      });
  }

  // Real CapePack's Pallet Base Styles Add form lets you type Length/
  // Width/Height/Weight in whichever unit system you pick (its own
  // mandatory Units field) — see LIBRARY_FIELD_SCHEMAS.pallets. These
  // track the unit-select input and every unitKind-tagged field's <label>
  // so a change to Units can update each one's shown suffix live, and so
  // the save handler below knows whether to convert on the way out.
  let unitSelectInput = null;
  const unitKindLabels = [];
  const updateUnitSuffixes = () => {
    if (!unitSelectInput) return;
    const units = unitSelectInput.value.startsWith("Imperial") ? "imperial" : "metric";
    for (const { label, unitKind } of unitKindLabels) {
      const base = label.textContent.replace(/ \(.*\)$/, "");
      label.textContent = `${base} (${unitKindSuffix(unitKind, units)})`;
    }
  };

  // "Select All" (real Horizontal Corner Posts Profiles Add form, user-
  // supplied screenshot) — one control above both Top/Bottom groups that
  // checks all 8 at once, not per-group. fieldInputs[gf.key] for every
  // grouped field isn't populated until the schema loop below actually
  // reaches it, but this only needs to run later, on user interaction —
  // by then the loop has long finished and every entry exists, same
  // closure reasoning as "Load existing style"'s noteInput reference.
  if (schema.some((f) => f.group)) {
    const selectAllLabel = document.createElement("label");
    selectAllLabel.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:10px";
    const selectAllCb = document.createElement("input");
    selectAllCb.type = "checkbox";
    selectAllCb.style.width = "auto";
    selectAllCb.style.margin = "0";
    selectAllCb.addEventListener("change", () => {
      for (const f of schema) {
        if (f.group) fieldInputs[f.key].checked = selectAllCb.checked;
      }
    });
    const selectAllSpan = document.createElement("span");
    selectAllSpan.textContent = "Select All";
    selectAllLabel.append(selectAllCb, selectAllSpan);
    container.append(selectAllLabel);
  }

  const fieldInputs = {};
  const renderedGroups = new Set();
  for (const field of schema) {
    let input;
    // A grouped checkbox field (e.g. Horizontal Corner Posts' Length 1/2,
    // Width 1/2 under "Top"/"Bottom") renders once as a labeled 2-column
    // grid the first time its group is seen, not as 8 standalone rows —
    // every field sharing that group is registered into fieldInputs right
    // away, so the generic save loop below still picks each one up
    // individually via field.type === "checkbox", same as any other.
    if (field.group) {
      if (renderedGroups.has(field.group)) continue;
      renderedGroups.add(field.group);
      const groupWrap = document.createElement("div");
      groupWrap.style.marginTop = "10px";
      const groupLabel = document.createElement("label");
      groupLabel.textContent = field.group;
      groupLabel.style.marginBottom = "2px";
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:4px;font-size:12px";
      for (const gf of schema.filter((f) => f.group === field.group)) {
        const cbLabel = document.createElement("label");
        cbLabel.style.cssText = "display:flex;align-items:center;gap:4px;margin:0";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.style.width = "auto";
        cb.style.margin = "0";
        cb.checked = existingItem?.[gf.key] ?? false;
        const span = document.createElement("span");
        span.textContent = gf.label;
        cbLabel.append(cb, span);
        grid.appendChild(cbLabel);
        fieldInputs[gf.key] = cb;
      }
      groupWrap.append(groupLabel, grid);
      container.append(groupWrap);
      continue;
    }
    if (field.type === "checkbox") {
      const wrapLabel = document.createElement("label");
      wrapLabel.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:10px";
      input = document.createElement("input");
      input.type = "checkbox";
      input.style.width = "auto";
      input.style.margin = "0";
      input.checked = existingItem?.[field.key] ?? false;
      const span = document.createElement("span");
      span.textContent = field.label;
      wrapLabel.append(input, span);
      container.append(wrapLabel);
    } else {
      const label = document.createElement("label");
      // Unit-kind fields carry a bare field.label (no unit baked in) — the
      // actual suffix comes from settings.units (the global preference)
      // here, live, not a hardcoded string — see UNIT_KINDS. Pallets/
      // trucks' own per-entry Units toggle can still override this one
      // field for one particular entry (updateUnitSuffixes below), same
      // as it always could; every other unit-kind type just uses the
      // global setting directly, with no toggle at all.
      label.textContent = field.unitKind ? `${field.label} (${unitKindSuffix(field.unitKind)})` : field.label;
      if (field.unitKind) unitKindLabels.push({ label, unitKind: field.unitKind });
      if (field.type === "select" || field.type === "unit-select") {
        input = document.createElement("select");
        for (const opt of field.options) {
          const optionEl = document.createElement("option");
          optionEl.value = opt;
          optionEl.textContent = opt;
          input.appendChild(optionEl);
        }
        // unit-select never has a stored value to restore (see the
        // LIBRARY_FIELD_SCHEMAS.pallets comment) — defaults to whichever
        // option matches the GLOBAL unit setting (fixed from always
        // defaulting to Metric regardless — the actual bug report this
        // whole change addresses), whether adding new or editing an
        // existing (canonical mm/kg) item; still a one-entry override you
        // can flip manually for typing convenience.
        input.value =
          field.type === "unit-select"
            ? field.options[settings.units === "imperial" ? 1 : 0]
            : existingItem?.[field.key] ?? field.options[0];
        if (field.type === "unit-select") {
          unitSelectInput = input;
          input.addEventListener("change", updateUnitSuffixes);
        }
      } else if (field.type === "color") {
        input = document.createElement("input");
        input.type = "color";
        input.style.cssText = "width:44px;padding:2px;height:32px";
        input.value = existingItem?.[field.key] ?? "#8a5a34";
      } else {
        input = document.createElement("input");
        input.type = field.type === "text" ? "text" : "number";
        // No LIBRARY_FIELD_SCHEMAS number field is ever legitimately
        // negative — every one is a physical length/weight, a count, or a
        // multiplier/percentage factor (checked the full schema list) — so
        // min="0" applies safely across every database this generic form
        // serves, not just the one the user happened to report (user ask:
        // "net weight cannot be minus... correct all these kind of logic
        // errors").
        if (input.type === "number") {
          input.step = "any";
          input.min = "0";
        }
        // Unit-kind fields show an existing item's stored value converted
        // to the current unit (the global setting, or the per-entry
        // Units toggle above for pallets/trucks) instead of the raw
        // canonical number — the save handler below converts back.
        input.value =
          field.unitKind && existingItem?.[field.key] !== undefined
            ? roundTo(
                unitKindToDisplay(
                  field.unitKind,
                  existingItem[field.key],
                  settings.units === "imperial" ? "imperial" : "metric"
                ),
                4
              )
            : existingItem?.[field.key] ?? "";
      }
      container.append(label, input);
    }
    fieldInputs[field.key] = input;
  }
  updateUnitSuffixes(); // initial label suffixes (Metric mm/kg) for whatever unitKind fields this type has, if any

  const noteLabel = document.createElement("label");
  noteLabel.textContent = "Note (optional)";
  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.value = existingItem?.note ?? "";
  container.append(noteLabel, noteInput);

  $("library-grid-view").style.display = "none";
  $("library-form-view").style.display = "block";

  $("library-form-save").onclick = async () => {
    if (!nameInput.value.trim()) {
      alert("Name is required.");
      return;
    }
    const data = {
      name: nameInput.value.trim(),
      category:
        existingItem?.category ?? (filterField === "category" ? filterValue : null) ?? LIBRARY_CATEGORIES[type],
      icon: existingItem?.icon ?? "icons/box.svg",
      note: noteInput.value.trim(),
    };
    // Not part of any type's editable schema (no form field for it) — the
    // generic loop below would otherwise silently drop it back to
    // "included" on every edit, undoing an Exclude toggle set from the
    // table (see LIBRARY_VISIBILITY_TOGGLE_TYPES).
    if (existingItem?.includeInList !== undefined) data.includeInList = existingItem.includeInList;
    if (filterField && filterField !== "category" && existingItem?.[filterField] === undefined) {
      data[filterField] = filterValue;
    }
    // The per-item Units toggle (pallets/trucks only) is a one-entry
    // override of the global setting for typing convenience — every
    // other unit-kind field (no such toggle at all) just converts
    // against the global setting directly. See UNIT_KINDS.
    const displayUnits = unitSelectInput
      ? unitSelectInput.value.startsWith("Imperial")
        ? "imperial"
        : "metric"
      : settings.units === "imperial"
        ? "imperial"
        : "metric";
    for (const field of schema) {
      if (field.type === "unit-select") continue; // entry-time convenience only, never persisted — see LIBRARY_FIELD_SCHEMAS.pallets
      if (field.type === "select") data[field.key] = fieldInputs[field.key].value;
      else if (field.type === "checkbox") data[field.key] = fieldInputs[field.key].checked;
      else if (field.type === "color") data[field.key] = fieldInputs[field.key].value;
      else if (field.type === "text") data[field.key] = fieldInputs[field.key].value.trim();
      else if (field.unitKind) {
        data[field.key] = unitKindToCanonical(field.unitKind, Number(fieldInputs[field.key].value), displayUnits);
      } else {
        data[field.key] = Number(fieldInputs[field.key].value);
      }
    }

    if (existingItem) {
      await fetch(`${API_BASE}/api/library/${type}/${existingItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } else {
      await fetch(`${API_BASE}/api/library/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    $("library-form-view").style.display = "none";
    $("library-grid-view").style.display = "flex";
    onSaved();
  };
  $("library-form-cancel").onclick = () => {
    $("library-form-view").style.display = "none";
    $("library-grid-view").style.display = "flex";
  };
}

// Search matches CapePack's own documented library UX ("Enter the package
// name in the Search field or expand the categories on the left") — a
// substring, case-insensitive match on name (and category, so e.g. typing
// "container" surfaces every truck/container entry at once).
function openLibraryFromItems(items, title, onPick, selId = null) {
  $("library-title").textContent = title;
  $("library-offline-note").style.display = "none";
  $("library-add-new").style.display = "none";
  $("library-form-view").style.display = "none";
  $("library-grid-view").style.display = "flex";
  $("library-search").value = "";
  modal.style.display = "flex";
  const selectedId = selId ? selectedLibraryItemIds[selId] : null;
  renderLibraryGrid(items, onPick, { selectedId });

  $("library-search").oninput = () => {
    const q = $("library-search").value.trim().toLowerCase();
    const filtered = q
      ? items.filter((i) => i.name.toLowerCase().includes(q) || (i.category ?? "").toLowerCase().includes(q))
      : items;
    renderLibraryGrid(filtered, onPick, { selectedId });
  };
}

// The real, persistent, editable library — API-backed (companies' own
// standards live in packages/api's SQLite database), falling back to the
// static JSON (read-only) if the API server isn't running, so the app still
// works fully offline, matching every other API-dependent feature's
// graceful-degradation pattern.
// itemFilter: when set — a plain string (matched against .category) or a
// { field, value } pair (matched against item[field]) — only matching items
// are shown. Used by the Databases menu to scope one type shared across
// several CapePack sub-databases (e.g. format-load-profiles' 11 profile
// types by .category, or board-grades' Single/Double/Triple Wall by .wall)
// down to a single one, without needing near-duplicate types per sub-menu.
// options.respectIncludeInList: true for an actual mid-analysis PICKER
// (e.g. "Select Pallet") — filters out items the user has excluded from
// their own catalog (see LIBRARY_VISIBILITY_TOGGLE_TYPES/"Include In
// List" below), same as real CapePack's picker only offering included
// styles. Admin views (opened from the Databases menu) leave this false
// so every item — included or not — stays visible to manage.
// options.closeOnPick (default true): every real "Select X" picker across
// the app wants the modal to close once you've picked something — but the
// Databases menu's own admin view passes onPick: () => {} (nothing IS
// picked there, you're just managing the catalog), and closing on every
// row click there was a real bug, not by-design: clicking a row to, say,
// read its full Note in the tooltip would instantly dismiss the whole
// management view for no reason. Set to false there specifically.
async function openLibrary(type, title, onPick, selId = null, itemFilter = null, options = {}) {
  const { respectIncludeInList = false, closeOnPick = true } = options;
  const filterField = typeof itemFilter === "string" ? "category" : itemFilter?.field;
  const filterValue = typeof itemFilter === "string" ? itemFilter : itemFilter?.value;
  $("library-title").textContent = title;
  $("library-form-view").style.display = "none";
  $("library-grid-view").style.display = "flex";
  $("library-offline-note").style.display = "none";
  grid.innerHTML = "<p style='padding:8px;color:var(--muted);font-size:12px'>Loading…</p>";
  modal.style.display = "flex";

  let allItems;
  let editable;
  try {
    const res = await fetch(`${API_BASE}/api/library/${type}`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    allItems = (await res.json()).items;
    editable = true;
  } catch {
    allItems = await fetch(`../library/${type}.json`).then((r) => r.json());
    editable = false;
    $("library-offline-note").style.display = "block";
  }
  let items = filterField ? allItems.filter((i) => i[filterField] === filterValue) : allItems;
  if (respectIncludeInList) items = items.filter((i) => i.includeInList !== false);

  const reopen = () => openLibrary(type, title, onPick, selId, itemFilter, options);
  $("library-add-new").style.display = editable ? "block" : "none";
  $("library-add-new").onclick =
    type === "shapes"
      ? () => openShapeEditor(null, reopen)
      : type === "stock-cases"
        ? () => openCasesTraysForm(null, reopen)
        : () => showLibraryForm(type, null, reopen, itemFilter);

  $("library-title").textContent = title;
  $("library-search").value = "";
  const selectedId = selId ? selectedLibraryItemIds[selId] : null;
  const showVisibilityToggle = !respectIncludeInList && LIBRARY_VISIBILITY_TOGGLE_TYPES.has(type);
  renderLibraryGrid(items, onPick, { editable, type, onChanged: reopen, selectedId, showVisibilityToggle, closeOnPick });

  $("library-search").oninput = () => {
    const q = $("library-search").value.trim().toLowerCase();
    const filtered = q
      ? items.filter((i) => i.name.toLowerCase().includes(q) || (i.category ?? "").toLowerCase().includes(q))
      : items;
    renderLibraryGrid(filtered, onPick, { editable, type, onChanged: reopen, selectedId, showVisibilityToggle, closeOnPick });
  };
}

// --- Databases (docs section 11: "Managing Databases") -------------------
// User ask: "I want to have the same menu called Databases with add/edit
// options... make sure we cover all these." Every leaf row below opens the
// exact same Add/Edit/Delete picker (openLibrary) already used throughout
// the app — this menu is purely an organized, CapePack-shaped entry point
// into libraries that already existed, plus format-load-profiles (new this
// pass) and board-grades split into its three wall-count sub-databases via
// itemFilter. See docs/ARCHITECTURE.md for exactly what's covered vs
// deferred vs not applicable, and why.
// Used to back a shared "Manage Databases" not-implemented entry under
// Strength/Stock Cases/Package Databases (CapePack's own multi-database
// management — creating, switching between, and merging several named
// databases of this type). All three are gone now — Strength's own was
// removed first, a "Stock Cases" group was never (re-)built after being
// explicitly reverted once (see the note on "More Databases" below), and
// Package Databases' own was removed on user request ("delete manage
// package databases. package databases is one tab itself") since a
// single flat tab has no "switch between databases" concept to manage in
// the first place. Constant removed alongside its last usage rather than
// left as dead code nothing references.

const DATABASES_MENU = [
  // Report Units/Default Search Objective — general app preferences with
  // no CapePack Database equivalent, folded in here (see openSettingsView)
  // now that this tab covers Settings too, not just Databases. First in
  // the list since it's global, not one specific database.
  // User ask: "rename settings as general settings" — distinguishes it
  // from the many specific per-item "Settings" surfaces elsewhere (Board
  // Grade settings, Format Load settings, etc.) now that this row sits
  // in a list alongside the "Databases" group below (named "General
  // Databases" at the time of that ask; see the group entry's own comment
  // for the later rename).
  { kind: "item", label: "General Settings", kindOverride: "settings", mainStyle: true },
  // CapePack's own Databases left-nav (docs section 11) — user-supplied
  // the full real structure (a flat top-level list, but Format Load/
  // Strength/Package Databases each expand into their own sub-items) after
  // an earlier pass here had it wrong in two different ways at two
  // different times: first over-grouped under invented headers ("Pallet &
  // Truck Base Styles" etc.), then missing several real entries entirely
  // because they aren't in this app's local copy of the user guide. Three
  // of those (External Interface Examples, Export Documentation, Setup
  // Cape .PDF report on WebCenter) were added with their real menu
  // position but an honest "not implemented" explanation in place of a
  // fake picker (kindOverride: "not-implemented", still used below for
  // "Manage Databases"/"Formulae"), then removed outright on user request
  // — see docs/ARCHITECTURE.md for that entry; not re-added here since the
  // ask was to delete them, not re-disclose them.
  //
  // User request (an earlier pass): group "Pallet Base Styles"/"Truck Base
  // Styles"/"Pack Names"/"Custom Shapes" and "Cases and Trays"/"Graphics
  // Database"/"Folded Carton Factors"/"KDF Formulae" into their own
  // collapsible sections, matching Format Load/Strength's own visual
  // treatment — an explicit, deliberate departure from the flat real
  // structure above. That first pass split them into two separate groups,
  // "General Databases" and "More Databases" — this app's own invented
  // labels, not real CapePack section names. User follow-up, later: "can
  // we combine or find a better name for [More Databases]?" — neither
  // label was a real semantic category (the split was purely "first batch
  // of items added" vs. "second batch"), and the second batch's own items
  // are too varied for any one descriptive name to fit better than "more"
  // did. Merged into one plain "Databases" group instead — same items,
  // same nested Folded Carton Factors subgroup, just without the
  // artificial general/more divide.
  //
  // NOT restored as part of this: a real "Stock Cases" group (Manage
  // Database + Cases and Trays), even though this array's own general
  // structure note above once listed "Stock Cases" as a real expandable
  // group alongside Format Load/Strength/Package Databases. A separate,
  // MORE specific correction (previously right above the old flat "Cases
  // and Trays" entry, now folded into "Databases" below) already
  // established — from an actual user-supplied Cases and Trays
  // screenshot, stronger evidence than the general section-11 outline —
  // that real CapePack shows Cases and Trays as a flat top-level entry,
  // NOT nested under its own "Stock Cases" group with a "Manage Database"
  // sibling; that exact grouping was tried here once already and
  // explicitly reverted on request. Re-introducing it now would undo that
  // correction on weaker evidence, so Cases and Trays only joins the
  // "Databases" visual-consistency group below, without a "Manage
  // Database" sibling or its own "Stock Cases" wrapper.
  // User ask (this pass): "find better categorization for Databases...
  // check the app and find better names and categories." The old single
  // "Databases" group was itself already an invented, non-CapePack
  // catch-all (see the long note above) holding two genuinely different
  // kinds of things — physical LOAD EQUIPMENT (what a load sits on/ships
  // in) vs. everything about the PRODUCT/PACKAGING itself — under one
  // undifferentiated label. Split into two clearer top-level groups along
  // that real distinction. Deliberately NOT touched: item order, which
  // items are flat vs. nested in the Folded Carton Factors subgroup, or
  // Cases and Trays' own flat (non-nested) position — all three were
  // separately confirmed against real CapePack evidence in earlier passes
  // (see this array's own history above), and this split doesn't add a
  // click to reach anything that didn't already need one.
  { kind: "group", label: "Load Equipment" },
  { kind: "item", label: "Pallet Base Styles", type: "pallets" },
  { kind: "item", label: "Truck Base Styles", type: "trucks" },
  { kind: "group", label: "Packaging & Materials" },
  { kind: "item", label: "Pack Names", type: "pack-names" },
  // One database, "shapes" — an earlier pass had split this into "Shape
  // Templates" (the built-in named catalog) and "Custom Shapes" (real .zae
  // uploads) as two separate entries/UIs, since at the time only one of
  // them supported real geometry. Merged back on user request ("shape
  // templates can easily be merged with custom shapes so when we add a new
  // shape template, we can add a .zae document as shape") — every entry
  // here can now optionally carry a real uploaded shape, matching how
  // CapePack itself only ever had the one "Custom Shapes" database (docs
  // section 11.4). See the comment on #custom-shapes-modal for the Add/Edit
  // UI this now opens instead of the generic name+note form.
  { kind: "item", label: "Custom Shapes", type: "shapes" },

  // Real CapePack shows Cases and Trays, Graphics Database, Folded Carton
  // Factors, and KDF Formulae as flat top-level entries (11.7/11.8/11.9/
  // 11.10) — Cases and Trays specifically confirmed via a real user-
  // supplied screenshot (not tucked under its own "Stock Cases" group with
  // a "Manage Database" sibling — that exact grouping was tried here once
  // already and explicitly reverted on request), the other three via the
  // docs' own section list, not grouped under an "Other Databases"
  // catch-all. No group entry here (unlike the earlier "More Databases"
  // header this pass merged away) — these fold straight into the same
  // "Databases" group opened above, right after Custom Shapes (physically
  // moved here from further down in this array, where the removed "More
  // Databases" header used to sit — otherwise, with Format Load/Strength's
  // own group entries in between, these would've silently nested inside
  // Strength instead of joining "Databases" at all); see the longer note
  // atop this array for the full history.
  // Opens the same shared Add/Edit/Delete picker modal every other type
  // uses (user: "should look similar to others") — its real per-axis
  // Inside/Outside dimensions, Dimension Mode, and live-computed Volume
  // are handled by openCasesTraysForm, which openLibrary routes to
  // instead of the generic showLibraryForm for this one type (same
  // special-casing pattern as "shapes"), rendering its own richer fields
  // into the same #library-form-fields container/Save-Cancel chrome
  // rather than a separate modal.
  { kind: "item", label: "Cases and Trays", type: "stock-cases" },
  { kind: "item", label: "Graphics Database", kindOverride: "graphics" },
  // Real CapePack's own Folded Carton Factors screen (user-supplied
  // screenshot) is one page with 2 real sub-databases — Carton Types
  // (Style + Thickness 1/2 Factor + Fluff Factor) and Boards (Board name +
  // Thickness + Fluff Factor) — same multi-category-page shape as Case
  // Configuration/Storage Environment above, not the single flat list this
  // app had before (which only ever really matched Boards; Carton Types
  // didn't exist as a database at all). See db.js's LIBRARY_TYPES comment
  // for the full rationale, including why Carton Types isn't wired into
  // any calculation yet. Stays its own nested subgroup here (real,
  // confirmed 2-sub-database structure) even though its outer "Databases"
  // group isn't itself a real CapePack section — subgroup-inside-group is
  // already an established, working pattern (see Storage Environment/
  // Case Configuration/Material Factors inside Strength above).
  { kind: "subgroup", label: "Folded Carton Factors" },
  { kind: "item", label: "Carton Types", type: "folded-carton-types" },
  { kind: "item", label: "Boards", type: "folded-carton-boards" },
  { kind: "endsubgroup" },
  { kind: "item", label: "KDF Formulae", kindOverride: "kdf-formulae" },

  // Four sequential, real user requests here, evolving this entry four
  // times: first "delete manage package databases. package databases is
  // one tab itself" (removed the "Manage Databases" placeholder — see
  // MANAGE_DATABASES_NOTE's own comment for why every instance of it is
  // gone now — and flattened this down to one plain item-top entry), then
  // "package databases should be like main category such as more
  // databases" — promoted to a `group` matching General Databases/Format
  // Load/Strength/More Databases' own visual treatment, with "Packages" as
  // its one child item. Once "Manage Settings and Databases" (added right
  // below, then promoted to standalone) stopped being this group's second
  // child, it was back to a group with exactly one item again — "Package
  // Databases CAN DIRECTLY Open the packages page, we don't need a subitem
  // there" — flattened back to a standalone item-top. Then: "Package
  // Databases can be under cases and trays" → clarified to "no, i meant
  // move Package Databases under more databases" — a plain `item` again
  // (not item-top), physically the last entry inside this group, alongside
  // Cases and Trays/Graphics Database/Folded Carton Factors/KDF Formulae
  // above rather than a standalone top-level row of its own.
  { kind: "item", label: "Package Databases", type: "packages" },

  { kind: "group", label: "Format Load" },
  // Not indented — unlike Strength's Material Factors/Storage Environment
  // subgroups, every item under this group is one of these 11 profile
  // types with no top-level sibling to distinguish them from, so indenting
  // just pushed them right of every other group's items for no reason.
  ...FORMAT_LOAD_PROFILE_CATEGORIES.map((cat) => ({
    kind: "item",
    label: cat,
    type: "format-load-profiles",
    filter: cat,
  })),

  // Order matches the real CapePack menu exactly (user-supplied): Manage
  // Databases, Storage Environment, Case Configuration, Default Env.
  // Factors, Material Factors, Single/Double/Triple Wall Boards, Formulae.
  // Storage Environment and Material Factors stay subgroups with their
  // existing, already-wired-up children (docs' own finer factor list) —
  // the user's paste names them as one line each, most likely because it
  // wasn't transcribing 3 levels deep, not because those children should
  // be removed; nothing here reads as an instruction to delete already-
  // working structure. Note the "endsubgroup" markers: this render loop
  // tracks only one open subgroup at a time via ordering (see
  // renderDatabasesMenu), so returning to plain Strength-level items after
  // a subgroup's own items needs an explicit reset — without it, Case
  // Configuration would render nested inside Storage Environment by
  // accident.
  // "Manage Databases" removed here on user request — still present
  // under Stock Cases and Package Databases below (not part of this ask).
  { kind: "group", label: "Strength" },
  { kind: "subgroup", label: "Storage Environment" },
  {
    kind: "item",
    label: "Humidity",
    type: "storage-environment-factors",
    filter: "Storage Environment: Humidity",
  },
  {
    kind: "item",
    label: "Days of Storage",
    type: "storage-environment-factors",
    filter: "Storage Environment: Days of Storage",
  },
  {
    kind: "item",
    label: "Case Orientation",
    type: "storage-environment-factors",
    filter: "Storage Environment: Case Orientation",
  },
  {
    kind: "item",
    label: "Stacking",
    type: "storage-environment-factors",
    filter: "Storage Environment: Stacking",
  },
  {
    kind: "item",
    label: "Pallet Overhang",
    type: "storage-environment-factors",
    filter: "Storage Environment: Pallet Overhang",
  },
  {
    kind: "item",
    label: "Pallet Surface",
    type: "storage-environment-factors",
    filter: "Storage Environment: Pallet Surface",
  },
  { kind: "endsubgroup" },
  // Real CapePack's own Case Configuration screen (user-supplied
  // screenshot) is one page with 5 real sub-databases, same shape as
  // Storage Environment's own multi-category page above — order matches
  // the real screen: Case Proportion, Case Types, Printing, Fluting,
  // Partition. caseTypeFactor/case-configurations already existed and
  // was already correct (its 4 shown real values matched exactly); the
  // other 4 were missing from both the menu and the strength calculation
  // itself until this pass — see applyStrengthFactorChain.
  { kind: "subgroup", label: "Case Configuration" },
  { kind: "item", label: "Case Proportion", type: "case-proportion-factors" },
  { kind: "item", label: "Case Types", type: "case-configurations" },
  { kind: "item", label: "Printing", type: "printing-factors" },
  { kind: "item", label: "Fluting Orientation", type: "fluting-orientation-factors" },
  { kind: "item", label: "Partition", type: "partition-factors" },
  { kind: "endsubgroup" },
  // Used to be its own top-level group (user ask at the time: "Default
  // Environmental Factors does not have a section like stock cases or
  // strength. it should have.") — moved back under Strength on this
  // user-supplied real structure, which places it here between Case
  // Configuration and Material Factors. Still its own clickable row (not
  // buried), just correctly positioned instead of promoted to a top-level
  // group that real CapePack doesn't have — see docs/ARCHITECTURE.md for
  // the full note on this correction.
  { kind: "item", label: "Default Env. Factors", kindOverride: "strength-defaults" },
  { kind: "subgroup", label: "Material Factors" },
  { kind: "item", label: "Liner Materials", type: "liner-materials" },
  { kind: "item", label: "Medium Materials", type: "medium-materials" },
  { kind: "item", label: "Flute Takeup Factors", type: "flute-takeup-factors" },
  { kind: "item", label: "Efficiency Factors", type: "efficiency-factors" },
  { kind: "endsubgroup" },
  { kind: "item", label: "Single Wall Boards", type: "board-grades", filter: { field: "wall", value: "single" } },
  { kind: "item", label: "Double Wall Boards", type: "board-grades", filter: { field: "wall", value: "double" } },
  { kind: "item", label: "Triple Wall Boards", type: "board-grades", filter: { field: "wall", value: "triple" } },
  // Real CapePack's own Formulae screen (user-supplied Imperial and
  // Metric screenshots) — read-only Ring Crush/STFI/McKee formula text
  // plus a real, working Custom Formula Entry editor. Was "not
  // implemented" (custom formula editing genuinely wasn't); superseded
  // once the user asked to see this screen built for real.
  { kind: "item", label: "Formulae", kindOverride: "formulae" },

  // User ask: "add manage database tab under package databases to import
  // export databases." Originally a Package Databases leaf; promoted to a
  // standalone top-level row (kind: "item-top", not "item" — resets
  // groupBody/subgroupBody so this doesn't render nested inside the
  // Databases group above, regardless of where Package Databases itself
  // happens to sit) once renamed to "Manage Settings and Databases" (user: "rename
  // databases as settings and databases... add one more menu there called
  // manage settings and databases") — a whole-tab action, not specific to
  // Package Databases anymore. See openManageDatabaseView.
  { kind: "item-top", label: "Manage Settings and Databases", kindOverride: "manage-database", mainStyle: true },
];

// Each top-level group (and each subgroup nested inside one) renders as a
// native <details>/<summary> — collapsed by default, so the menu opens as a
// short list of dropdown headers instead of every database's items all
// being on screen at once (user ask: "maybe they should also be like
// dropdown list ... same for all the rest"). DATABASES_MENU stays a flat,
// ordered array (unchanged shape); this walks it once, tracking whichever
// group/subgroup body is currently open, and appends each item/note into
// the innermost one — except notes, which always attach to the top-level
// group body even while a subgroup is open, so an important caveat (e.g.
// "Formulae aren't editable") stays visible as soon as Strength itself is
// opened, without also needing Storage Environment specifically expanded.
function renderDatabasesMenu() {
  const container = $("databases-list");
  container.innerHTML = "";

  let groupBody = null;
  let subgroupBody = null;

  const makeRow = (entry) => {
    const row = document.createElement("div");
    // mainStyle: reads at the same visual weight as a group header (General
    // Databases/Strength/...) even though it's a plain clickable row, not a
    // <details> — user ask: "make settings and manage buttons as the
    // others... they are main buttons." See .db-row-main, index.html.
    row.className = entry.mainStyle ? "db-row db-row-main" : "db-row";
    row.innerHTML = `<span>${entry.label}</span><span class="db-arrow"></span>`;
    // Settings/Default Environmental Factors/Formulae/Manage Settings and
    // Databases are each a single form or action, not a list of records —
    // every one opens its own dedicated modal instead of the shared
    // Add/Edit/Delete picker every other leaf uses, but a modal all the
    // same (every Databases leaf opens the same way — see
    // docs/ARCHITECTURE.md).
    row.addEventListener("click", () => {
      if (entry.kindOverride === "strength-defaults") {
        openStrengthDefaultsForm();
      } else if (entry.kindOverride === "graphics") {
        openGraphicsView();
      } else if (entry.kindOverride === "kdf-formulae") {
        openKdfFormulaeView();
      } else if (entry.kindOverride === "formulae") {
        openFormulaeView();
      } else if (entry.kindOverride === "manage-database") {
        openManageDatabaseView();
      } else if (entry.kindOverride === "settings") {
        openSettingsView();
      } else if (entry.kindOverride === "not-implemented") {
        // Real CapePack menu position, honest explanation instead of a
        // fake picker — see the comment atop DATABASES_MENU.
        alert(`${entry.label}\n\n${entry.noteText}`);
      } else {
        openLibrary(entry.type, `Manage ${entry.label}`, () => {}, null, entry.filter ?? null, { closeOnPick: false });
      }
    });
    return row;
  };

  for (const entry of DATABASES_MENU) {
    if (entry.kind === "group") {
      const details = document.createElement("details");
      details.className = "db-group";
      const summary = document.createElement("summary");
      summary.textContent = entry.label;
      groupBody = document.createElement("div");
      groupBody.className = "db-group-body";
      details.append(summary, groupBody);
      container.appendChild(details);
      subgroupBody = null;
    } else if (entry.kind === "subgroup") {
      const details = document.createElement("details");
      details.className = "db-subgroup";
      const summary = document.createElement("summary");
      summary.textContent = entry.label;
      subgroupBody = document.createElement("div");
      subgroupBody.className = "db-subgroup-body";
      details.append(summary, subgroupBody);
      (groupBody ?? container).appendChild(details);
    } else if (entry.kind === "endsubgroup") {
      // Explicit reset back to group-level nesting — this loop tracks only
      // one open subgroup at a time via array ORDER (subgroupBody only
      // ever changes on the next "subgroup"/"group" entry), so a plain
      // item meant to sit at the group level again after a subgroup's own
      // items needs this marker, or it would render nested inside that
      // subgroup by accident.
      subgroupBody = null;
    } else if (entry.kind === "note") {
      const p = document.createElement("p");
      p.className = "db-note";
      p.textContent = entry.text;
      (groupBody ?? container).appendChild(p);
    } else if (entry.kind === "note-top") {
      // Unlike "note" above, always attaches to the root list — used after
      // the last group so it doesn't get swept into whichever group body
      // happens to still be open (groupBody only ever changes on the next
      // "group" entry, it doesn't reset when the array returns to
      // top-level items).
      const p = document.createElement("p");
      p.className = "db-note";
      p.textContent = entry.text;
      container.appendChild(p);
      // Also reset for whatever comes AFTER this entry — see the
      // "item-top" branch's own comment just below for the real bug this
      // fixes (this branch has the identical latent issue, fixed
      // alongside it rather than left as a known-identical trap).
      groupBody = null;
      subgroupBody = null;
    } else if (entry.kind === "item-top") {
      // Same reasoning as "note-top" — a flat CapePack nav entry that must
      // render as a direct child of the Databases list, not nested inside
      // whichever group/subgroup happens to precede it in the array.
      container.appendChild(makeRow(entry));
      // Reset group/subgroup tracking too, not just this row's own parent:
      // a "subgroup" entry placed after an item-top (Folded Carton Factors,
      // right after Graphics Database) used (groupBody ?? container) and
      // silently nested itself inside whatever group was last opened
      // (Strength, still "open" as far as this loop's state was concerned
      // even though Graphics Database had already rendered at top level in
      // between) — invisible unless that stale group happened to be
      // expanded. item-top's own doc comment already promised it renders
      // "not nested inside whichever group/subgroup happens to precede
      // it," but that only covered ITSELF; nothing enforced the same for
      // whatever came next, until now.
      groupBody = null;
      subgroupBody = null;
    } else {
      (subgroupBody ?? groupBody ?? container).appendChild(makeRow(entry));
    }
  }
}

// Same tab pattern as tab-analyses: always reachable, not one of the 4
// linear STEPS. Databases content is narrow-only (fits the aside), so
// unlike the Analyses tab this doesn't need to touch canvas-wrap/<main>.
function openDatabases() {
  for (const s of STEPS) $(`panel-${s}`).hidden = true;
  $("panel-analyses").hidden = true;
  $("analyses-table-wrap").hidden = true;
  $("calculate-preview").hidden = true; // inline now, not a permanent side column — only relevant within New Analysis
  $("preview-3d-row").hidden = true;
  $("panel-databases").hidden = false;
  document.querySelectorAll(".stepper .step").forEach((el) => el.classList.remove("active"));
  $("tab-databases").classList.add("active");
  renderDatabasesMenu();
}
$("tab-databases").addEventListener("click", openDatabases);

// Settings used to be its own standalone tab (user ask, back then: "settings
// should also be like a new tab such as analyses or databases"). Folded into
// this combined "Settings and Databases" tab instead (user: "rename
// databases as settings and databases. move the settings there.") as its
// first menu entry — opens a modal like every other Databases leaf now.
const settingsModal = $("settings-modal");
function openSettingsView() {
  populateSettingsForm();
  $("settings-status").textContent = "";
  settingsModal.style.display = "flex";
}
$("settings-close").addEventListener("click", () => {
  settingsModal.style.display = "none";
});
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.style.display = "none";
});

// About modal: bottom-of-rail info button, not part of the Databases menu
// tree (see index.html's own comment on #open-about) — same plain
// show/hide-on-overlay-click pattern as settingsModal above.
const aboutModal = $("about-modal");
$("open-about").addEventListener("click", () => {
  aboutModal.style.display = "flex";
});
$("about-close").addEventListener("click", () => {
  aboutModal.style.display = "none";
});
aboutModal.addEventListener("click", (e) => {
  if (e.target === aboutModal) aboutModal.style.display = "none";
});

// --- Import from File --------------------------------------------------------
// Real, honest scope: CapePack's own ArtiosCAD integration doesn't parse the
// native .ard file either — per Esko's documentation, ArtiosCAD sends a
// case's OUTER DIMENSIONS (L×W×H) to Cape Pack, not the raw structural
// design file. This is the same shape: a plain dimension list (CSV or JSON),
// which is what you'd get from ArtiosCAD (or any tool) exporting a BOM/
// dimension table — not a parser for ArtiosCAD's proprietary binary format,
// which isn't publicly documented and wasn't guessed at.
//
// Minimal CSV parser: header row + comma-separated values, numeric cells
// auto-converted. No quoted-comma support — fine for a plain dimension
// table, not a general CSV parser.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => {
      const raw = cells[i] ?? "";
      const n = Number(raw);
      row[h] = raw !== "" && !Number.isNaN(n) ? n : raw;
    });
    return row;
  });
}

const importFileInput = document.createElement("input");
importFileInput.type = "file";
importFileInput.accept = ".csv,.json";
importFileInput.style.display = "none";
document.body.appendChild(importFileInput);

let pendingImportPick = null;
let pendingImportTitle = "Imported Items";

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  importFileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  const text = await file.text();
  let rows;
  try {
    rows = file.name.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseCsv(text);
  } catch (err) {
    alert(`Couldn't parse ${file.name} - expected CSV with a header row, or a JSON array. (${err.message})`);
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    alert(`${file.name} didn't contain any rows.`);
    return;
  }

  const items = rows.map((r, i) => ({
    id: `import-${i}`,
    name: r.name ?? `Row ${i + 1}`,
    category: "Imported",
    length: r.length,
    width: r.width,
    height: r.height,
    weight: r.weight,
    maxWeight: r.maxWeight,
    deckHeight: r.deckHeight,
    maxHeight: r.maxHeight,
    icon: "icons/box.svg",
    note: `Imported from ${file.name}`,
  }));
  openLibraryFromItems(items, `${pendingImportTitle} - ${file.name}`, pendingImportPick);
});

function openFileImport(title, onPick) {
  pendingImportTitle = title;
  pendingImportPick = onPick;
  importFileInput.click();
}

const PALLET_PICK_FIELD_IDS = ["pl-length", "pl-width", "pl-deck", "pl-maxweight", "pl-weight", "pl-material", "pl-color-swatch"];
// User request: Clear used to leave a DIFFERENT set of filled-in numbers
// behind (the app's own generic defaults) — still looked like "a pallet
// is configured" even with the badge gone. Now blanks the real dimension/
// weight fields outright so Clear genuinely means "nothing selected,"
// same as an "optional" field elsewhere in this file (e.g. sc-maxweight
// already blanks on clear). Material/color have no real "blank" state
// (a <select> and a swatch always show SOME value), so those two still
// fall back to a plain generic default rather than nothing.
function clearPalletFields() {
  $("pl-length").value = "";
  $("pl-width").value = "";
  $("pl-deck").value = "";
  $("pl-maxweight").value = "";
  $("pl-weight").value = "";
  $("pl-material").value = "Wood";
  palletColor = "#e8d67a";
  $("pl-color").value = palletColor;
  $("pl-color-swatch").style.background = palletColor;
  unlockFields(PALLET_PICK_FIELD_IDS);
}
function pickPallet(item) {
  $("pl-length").value = item.length;
  $("pl-width").value = item.width;
  $("pl-deck").value = item.deckHeight ?? 0;
  $("pl-maxweight").value = item.maxWeight;
  $("pl-weight").value = item.tareWeight ?? 25;
  if (item.material) $("pl-material").value = item.material;
  // Unlike boxColor (independent of Pack Type), a Pallet Base Style's color
  // is part of the style's own saved data in real CapePack — so picking one
  // restores ITS color, not just a generic default.
  palletColor = item.color ?? "#e8d67a";
  $("pl-color").value = palletColor;
  $("pl-color-swatch").style.background = palletColor;
  lockFields(PALLET_PICK_FIELD_IDS);
  markSelected("sel-pallet", item.name, { itemId: item.id, onClear: clearPalletFields, icon: item.icon });
}
$("open-library").addEventListener("click", () => {
  openLibrary("pallets", "Select Pallet", pickPallet, "sel-pallet", null, { respectIncludeInList: true });
});
$("import-pallet-file").addEventListener("click", () => {
  openFileImport("Select Pallet", pickPallet);
});

// Board Grade library data is stored in its documented imperial source
// units (ectLbIn/caliperMils, per docs section on the Board Grade Database)
// — converted to metric for display/calculation when Report Units is
// Metric, per updateStrengthUnitLabels()'s own note on why.
function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
$("open-board-library").addEventListener("click", () => {
  openLibrary(
    "board-grades",
    "Select Board Grade",
    (item) => {
      // ectRc/caliperIn (Ring Crush EC + inches) replaced the old flat
      // ectLbIn/caliperMils fields once Single/Double/Triple Wall Boards
      // gained their real per-wall schema (EC(RC)/EC(STFI)/EC(Custom) are
      // now three separate real fields; this app's own single ECT slot
      // has always meant the Ring Crush one specifically).
      $("r-ect").value = roundTo(ectLbInToDisplay(item.ectRc), 4);
      $("r-cal").value = roundTo(caliperMilsToDisplay(item.caliperIn * 1000), 4);
      markSelected("sel-board", item.name, {
        itemId: item.id,
        onClear: () => {
          $("r-ect").value = roundTo(ectLbInToDisplay(40), 4);
          $("r-cal").value = roundTo(caliperMilsToDisplay(40), 4);
        },
      });
    },
    "sel-board"
  );
});

$("open-fcf-library").addEventListener("click", () => {
  openLibrary(
    "folded-carton-boards",
    "Select Folded Carton Board",
    (item) => {
      $("fc-thickness").value = item.boardThickness;
      $("fc-fluff").value = item.fluffFactor;
      markSelected("sel-fcf", item.name, {
        itemId: item.id,
        onClear: () => {
          $("fc-thickness").value = 0.5;
          $("fc-fluff").value = 1;
        },
      });
    },
    "sel-fcf"
  );
});

// Real CapePack Truck Analysis (user-supplied screenshot) locks Length/
// Width/Height/Weight once a real truck is picked (they're the truck's own
// physical database attributes) but leaves Maximum Load Weight/Maximum
// Load Height always editable (real per-analysis LIMITS, not database
// attributes — defaulted from the truck's own maxWeight/Height here but
// free to be set lower afterward). tareWeight ("Weight" — the truck's own
// tare weight) already existed in the trucks library schema but had no UI
// field anywhere in this app until now.
const TRUCK_PICK_FIELD_IDS = ["tr-length", "tr-width", "tr-height", "tr-tareweight"];
$("open-truck-library").addEventListener("click", () => {
  openLibrary(
    "trucks",
    "Select Truck",
    (item) => {
      $("tr-length").value = item.length;
      $("tr-width").value = item.width;
      $("tr-height").value = item.maxHeight;
      $("tr-tareweight").value = item.tareWeight ?? 0;
      $("tr-maxweight").value = item.maxWeight;
      $("tr-maxheight").value = item.maxHeight;
      lockFields(TRUCK_PICK_FIELD_IDS);
      markSelected("sel-truck", item.name, {
        itemId: item.id,
        icon: item.icon,
        // User request: Clear used to swap in a DIFFERENT filled-in truck
        // size (this app's own generic default) rather than genuinely
        // clearing the pick — still read as "a container is configured."
        // Blanks the fields outright instead, same fix as Pallet/Stock
        // Case/Primary Pack's own onClear right below/above.
        onClear: () => {
          $("tr-length").value = "";
          $("tr-width").value = "";
          $("tr-height").value = "";
          $("tr-tareweight").value = "";
          $("tr-maxweight").value = "";
          $("tr-maxheight").value = "";
          unlockFields(TRUCK_PICK_FIELD_IDS);
        },
      });
    },
    "sel-truck",
    null,
    { respectIncludeInList: true }
  );
});

const STOCK_CASE_PICK_FIELD_IDS = ["sc-length", "sc-width", "sc-height", "sc-weight", "sc-thickness", "sc-maxweight"];
// User request: Clear used to swap in this app's own generic default case
// size rather than genuinely clearing the pick — still read as "a case is
// configured." Blanks the fields outright instead, same fix as Pallet/
// Truck/Primary Pack's own onClear.
function clearStockCaseFields() {
  $("sc-length").value = "";
  $("sc-width").value = "";
  $("sc-height").value = "";
  $("sc-weight").value = "";
  $("sc-thickness").value = "";
  $("sc-maxweight").value = "";
  pickedStockCaseInsideDims = null;
  unlockFields(STOCK_CASE_PICK_FIELD_IDS);
}
function pickStockCase(item) {
  // sc-length/width/height are the OUTSIDE (palletized) dimensions — real
  // Cases and Trays entries store these as odLength/odWidth/odHeight (see
  // openCasesTraysForm); older, pre-redesign picks (or a raw file import)
  // may still only have the old flat length/width/height, kept as a
  // fallback so neither breaks.
  $("sc-length").value = item.odLength ?? item.length;
  $("sc-width").value = item.odWidth ?? item.width;
  $("sc-height").value = item.odHeight ?? item.height;
  $("sc-weight").value = item.weight ?? 0;
  $("sc-thickness").value = item.thickness ?? item.wallThickness ?? 0;
  $("sc-maxweight").value = item.maxWeight ?? "";
  // Real per-axis inside dimensions (not always a uniform wallThickness x2
  // relationship to the OD above) — see readStockCase's own comment.
  pickedStockCaseInsideDims =
    item.idLength !== undefined
      ? { insideLength: item.idLength, insideWidth: item.idWidth, insideHeight: item.idHeight }
      : null;
  // Fields are now locked on pick (user request — a "Selected: X" badge
  // shouldn't sit next to dimensions someone silently edited away from X),
  // so the sibling "manual edit un-picks insideDims" input listener right
  // below this function can no longer fire while locked — not removed,
  // since it's still correct/harmless: it only matters if these fields are
  // ever editable again, i.e. after Clear.
  lockFields(STOCK_CASE_PICK_FIELD_IDS);
  markSelected("sel-stockcase", item.name, { itemId: item.id, onClear: clearStockCaseFields, icon: item.icon });
}
// A manual edit to any of the OD/thickness fields after a pick means the
// user wants to model something other than the exact picked case — the
// stale real per-axis insideDims would otherwise silently keep overriding
// whatever they just typed. Falls back to the plain wallThickness x2
// model (unchanged pre-redesign behavior) rather than showing an override
// that no longer matches what's on screen.
for (const id of ["sc-length", "sc-width", "sc-height", "sc-thickness"]) {
  $(id).addEventListener("input", () => {
    pickedStockCaseInsideDims = null;
  });
}
$("open-stockcase-library").addEventListener("click", () => {
  openLibrary("stock-cases", "Select Stock Case", pickStockCase, "sel-stockcase");
});
$("import-stockcase-file").addEventListener("click", () => {
  openFileImport("Select Stock Case", pickStockCase);
});

function clearPrimaryPackFields() {
  $("p-length").value = 400;
  $("p-width").value = 300;
  $("p-height").value = 250;
  $("p-weight").value = 5;
  primaryPackBaseShape = "box";
  primaryPackCustomShape = null;
  primaryPackIsTrueCircle = false;
  updateCaseContentAvailability();
}
function pickPrimaryPack(item) {
  $("p-length").value = item.length;
  $("p-width").value = item.width;
  $("p-height").value = item.height;
  $("p-weight").value = item.weight;
  primaryPackBaseShape = "box"; // a plain dimension preset has no shape info — assume box
  primaryPackCustomShape = null;
  primaryPackIsTrueCircle = false;
  updateCaseContentAvailability();
  markSelected("sel-pack", item.name, { itemId: item.id, onClear: clearPrimaryPackFields, icon: item.icon });
}
$("open-pack-library").addEventListener("click", () => {
  openLibrary("packs", "Select Primary Pack", pickPrimaryPack, "sel-pack");
});

// Only "cylinder"-like Shape Types get a distinct round 3D mesh (see
// renderBoxes) — the packing math itself always uses the bounding box
// regardless of baseShape, per the shapes library's own honest
// engineSupport note. Bottle/Oval are physically round too, so they're
// grouped in here rather than left to silently fall back to a box mesh —
// everything else (including the newer Tray/Solid Cuboid/Rectangular
// Body/Case/Bag types) renders as a box, same as before this list grew.
const ROUND_BASE_SHAPES = new Set(["cylinder", "bottle", "oval"]);

// Pack Type Library (docs section 4.1.1: "Select From Library to open the
// Pack Type Library window") — a shape TEMPLATE, not a dimension preset,
// so it only sets Pack Name + shape and warns if the engine can't fully
// compute that shape yet — UNLESS the template itself carries known
// Length/Width/Height (set directly on the shape entry, or measured from
// an uploaded .zae), in which case those get applied too and the warning
// is skipped, since there's nothing left to prompt the user to type in.
// Shared by both the Pack Type picker (below) and the "Add New Shape"
// quick-add button's post-save callback — a shapes-library item is applied
// identically either way, so this is the one place that logic lives.
// Branches on item.zae: real uploaded geometry re-parses and renders the
// actual shape (re-parsing rather than caching the Object3D guarantees the
// rendered mesh always matches exactly what's persisted, worth the cost
// since this only runs once per pick, not per frame); a plain named
// template (no zae) falls back to the box/cylinder bounding-box behavior
// this app has always used for CapePack's own "planned" shapes.
async function applyShapeToPackType(item) {
  if (item.zae) {
    try {
      const parsed = await parseCustomShapeFile(item.zae, item.zaeFilename, { zUp: item.zaeZUp });
      primaryPackBaseShape = "custom";
      primaryPackCustomShape = parsed;
      primaryPackIsTrueCircle = false; // an uploaded mesh's true cross-section isn't known — stays bounding-box
      updateCaseContentAvailability(); // primaryPackBaseShape is now "custom", not "box" — hides Case Content, same as any other non-box shape
      $("p-length").value = parsed.lengthMm;
      $("p-width").value = parsed.widthMm;
      $("p-height").value = parsed.heightMm;
      $("p-packname").value = item.name;
      // User request: fields a real library pick just set shouldn't stay
      // silently editable next to a "Selected: X" badge — see lockFields'
      // own doc comment. A custom shape always sets all 3 dims.
      lockFields(["p-length", "p-width", "p-height"]);
      markSelected("sel-packtype", `${item.name} (custom shape - bounding-box approx.) - Pack Name set below`, {
        itemId: item.id,
        icon: item.icon,
        onClear: () => {
          $("p-packname").value = "";
          primaryPackBaseShape = "box";
          primaryPackCustomShape = null;
          primaryPackIsTrueCircle = false;
          updateCaseContentAvailability();
          // User request (follow-up): Clear used to leave the custom
          // shape's own real dimensions sitting in the fields, unlocked
          // but unchanged — still read as "this shape is configured."
          blankFields(["p-length", "p-width", "p-height"]);
          unlockFields(["p-length", "p-width", "p-height"]);
        },
      });
    } catch (err) {
      alert(`Couldn't load "${item.name}": ${err.message}`);
    }
    return;
  }
  $("p-packname").value = item.name;
  const engineSupport = item.engineSupport ?? "full"; // custom company shapes default to full/box
  primaryPackBaseShape = ROUND_BASE_SHAPES.has(item.baseShape) ? "cylinder" : "box";
  // crossSection ("circle" | "hex" | "oval"), not baseShape, decides real
  // hexagonal packing eligibility — baseShape "cylinder" also covers Hex
  // Jar and Oval Tube (see shapes.json), neither of which is a true
  // circle, so checking baseShape alone would wrongly hexagonal-pack them.
  primaryPackIsTrueCircle = item.crossSection === "circle";
  primaryPackCustomShape = null; // clear any real Collada shape a previous pick left behind
  updateCaseContentAvailability(); // primaryPackBaseShape is set above — Case Content only ever shows for "box"
  const hasDims = item.lengthMm !== undefined && item.lengthMm !== null;
  if (hasDims) {
    $("p-length").value = item.lengthMm;
    $("p-width").value = item.widthMm;
    $("p-height").value = item.heightMm;
  }
  // Real CapePack Pack Type Library pastes Weights (Net/Gross) alongside
  // dimensions when a library item is picked (user-supplied screenshot:
  // selecting "Soda Can" filled Top/Bottom Diameter, Height, AND Net/Gross
  // Weight) — this app's own picker only ever filled dimensions, never
  // weight, even on items that already carry it. grossWeightKg mirrors
  // p-weight's own "Gross Weight" label exactly; netWeightKg is optional,
  // matching p-netweight's own optional field.
  if (item.grossWeightKg != null) $("p-weight").value = item.grossWeightKg;
  if (item.netWeightKg != null) $("p-netweight").value = item.netWeightKg;
  // User request (see lockFields' own doc comment): lock only the fields
  // THIS pick actually wrote — a shape with no weight of its own leaves
  // Gross/Net Weight editable rather than locking a value it never set.
  const lockedFieldIds = [
    ...(hasDims ? ["p-length", "p-width", "p-height"] : []),
    ...(item.grossWeightKg != null ? ["p-weight"] : []),
    ...(item.netWeightKg != null ? ["p-netweight"] : []),
  ];
  lockFields(lockedFieldIds);
  markSelected(
    "sel-packtype",
    `${item.name} (${item.baseShape ?? "box"}${engineSupport === "planned" ? " - bounding-box approx." : ""}) - Pack Name set below`,
    {
      itemId: item.id,
      icon: item.icon,
      onClear: () => {
        $("p-packname").value = "";
        primaryPackBaseShape = "box";
        primaryPackCustomShape = null;
        primaryPackIsTrueCircle = false;
        updateCaseContentAvailability();
        // User request (follow-up): Clear used to leave the picked item's
        // own real dimensions/weight sitting in the fields, unlocked but
        // unchanged — still read as "this item is configured."
        blankFields(lockedFieldIds);
        unlockFields(lockedFieldIds);
      },
    }
  );
  if (engineSupport === "planned" && !hasDims) {
    alert(
      `"${item.name}" is approximated as a rectangular bounding box for palletization - ` +
        `true ${item.baseShape ?? "non-box"} packing math isn't implemented yet. ` +
        `Enter the shape's bounding box dimensions below.`
    );
  }
}

// Real Cape Pack Cloud uses the SAME "Select From Library" Pack Type
// Library (Explore rail + "Choose From The List" grid, plus Search and
// Create New Shape) for Primary/Secondary Pack shape selection as it does
// for Create a Case's own Secondary Pack Details — user-supplied
// screenshots of both confirmed this. Previously this button opened the
// generic, single-column #library-modal instead (a different, less
// CapePack-like picker) — user: "we need to make it similar to capepack."
// applyShapeToPackType already calls markSelected("sel-packtype", ...)
// itself on pick, so no selId is needed here the way openLibrary took one.
$("open-packtype-library").addEventListener("click", () => {
  openPackTypeModal(applyShapeToPackType, null, { categories: PACK_TYPE_BROWSE_CATEGORIES });
});
// User report: "I expect that it accepts 3d import. not json." — this
// used to open the generic CSV/JSON row importer (openFileImport, shared
// with Pallet/Stock Case, both of which stay plain dimensional boxes
// with no real shape concept at all) — but Pack Type is the one place in
// this app real geometry actually applies (Custom Shapes, real .zae/
// .step/.stp uploads, same system "Select From Library" right next to
// this button already opens into). Real CapePack's own docs describe
// exactly this: upload a Collada file "inline from the Pack Type
// Library if the required shape is not available" — this button now
// does that directly (openShapeEditor, the same real upload form/
// dropzone "Select CAD File"/"Create New Shape" already use elsewhere),
// instead of a JSON table that was never a 3D import at all.
$("import-pack-file").addEventListener("click", () => {
  openShapeEditor(null, applyShapeToPackType);
});

// --- Custom Shapes (docs section 11.4/4.7: Collada .zae import) ------------
// One database, "shapes" — CapePack itself doesn't split this into a
// built-in-catalog database and a separate uploads database (see the HTML
// comment on #custom-shapes-modal); every entry is a name + category +
// base shape type, with an optional real .zae attached. This modal is the
// shared Add/Edit form for that single database, opened from the generic
// library picker's own "+ Add New"/pencil-edit actions for type "shapes"
// (existingItem set when editing, onSaved=refresh the grid) — see
// openLibrary/renderLibraryGrid's type==="shapes" branches below. Used to
// have a second entry point too — the Pack Type section's own standalone
// "Add New Shape…" button (existingItem=null, onSaved=applyShapeToPackType
// — save and apply immediately) — removed on user request after
// confirming it was identical to the picker's own "+ Add New" one click
// deeper, and that a real screenshot (docs/ARCHITECTURE.md, the Pack Type
// Library rebuild entry) shows "Create New Shape" living inside the
// picker itself, not as a second button beside it. applyShapeToPackType
// itself is unaffected — still used as "Browse Shape Library"'s own onPick
// (openLibrary's third argument, below), since picking any tile — freshly
// created or pre-existing — still needs to apply it to the form.
const customShapesModal = $("custom-shapes-modal");
let pendingShapeZae = null; // { zae, zaeFilename } once a file parses successfully this session — dims live in the form fields, not here
let shapeEditorExistingItem = null; // the item being edited, or null when adding new
let shapeEditorOnSaved = null; // (savedItem) => void, set per-call by openShapeEditor
let zaeDetached = false; // true once "Remove File" is clicked this session — overrides shapeEditorExistingItem.zae even though that item still has one

// A real uploaded model has real, known geometry — once one is attached
// (freshly uploaded, or already on the item being edited), Length/Width/
// Height are locked to what it actually measures instead of staying
// hand-editable, so the stored dims can't silently drift from the file.
function setCsDimensionsLocked(locked) {
  $("cs-length").disabled = locked;
  $("cs-width").disabled = locked;
  $("cs-height").disabled = locked;
  $("cs-remove-zae").style.display = locked ? "" : "none";
}

function isStepFilename(name) {
  const lower = (name || "").toLowerCase();
  return lower.endsWith(".step") || lower.endsWith(".stp");
}

function openShapeEditor(existingItem, onSaved) {
  shapeEditorExistingItem = existingItem;
  shapeEditorOnSaved = onSaved;
  pendingShapeZae = null;
  zaeDetached = false;
  $("cs-file-input").value = "";
  $("cs-modal-title").textContent = existingItem ? "Edit Custom Shape" : "Add Custom Shape";
  $("cs-name").value = existingItem?.name ?? "";
  $("cs-category").value = existingItem?.category ?? "";
  $("cs-baseshape").value = existingItem?.baseShape ?? "box";
  $("cs-thickness").value = existingItem?.thickness ?? "";
  $("cs-length").value = existingItem?.lengthMm ?? "";
  $("cs-width").value = existingItem?.widthMm ?? "";
  $("cs-height").value = existingItem?.heightMm ?? "";
  $("cs-note").value = existingItem?.note ?? "";
  setCsDimensionsLocked(!!existingItem?.zae);
  $("cs-step-zup-row").style.display = isStepFilename(existingItem?.zaeFilename) ? "flex" : "none";
  $("cs-step-zup").checked = !!existingItem?.zaeZUp;
  $("cs-parse-status").textContent = existingItem?.zae
    ? `This shape has a real uploaded file attached (${existingItem.zaeFilename || "uploaded"}). Length/Width/Height are locked to it - upload a new file to replace it, or remove it to enter dimensions manually.`
    : "";
  customShapesModal.style.display = "flex";
}
$("custom-shapes-close").addEventListener("click", () => {
  customShapesModal.style.display = "none";
});
customShapesModal.addEventListener("click", (e) => {
  if (e.target === customShapesModal) customShapesModal.style.display = "none";
});

// The API's own JSON body cap is 1MB (packages/api/src/server.js); base64
// inflates a binary file by ~4/3, so an uploaded shape file has to stay
// comfortably under that or the save request would just fail with no
// useful explanation — checked here instead, with a real number in the
// message.
const MAX_ZAE_BYTES = 700_000;

// User ask: "in import option, we need to make .step is also possible as
// collada." Accepts .zae (Collada) or .step/.stp — dispatches to
// parseCustomShapeFile, which routes to parseStepFile/parseZaeCollada by
// extension. Still named handleZaeFile (an internal function name, not
// user-facing) to avoid a broad rename across every call site below for a
// purely cosmetic reason.
async function handleZaeFile(file) {
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".zae") && !lower.endsWith(".step") && !lower.endsWith(".stp")) {
    $("cs-parse-status").textContent = `"${file.name}" doesn't look like a supported file - upload a zipped Collada (.zae, not a bare .dae) or a STEP file (.step/.stp).`;
    return;
  }
  if (file.size > MAX_ZAE_BYTES) {
    $("cs-parse-status").textContent = `"${file.name}" is ${(file.size / 1000).toFixed(0)}KB - custom shapes are capped at ${(MAX_ZAE_BYTES / 1000).toFixed(0)}KB (the API's own request-size limit, once base64-encoded for storage).`;
    return;
  }

  // A fresh upload always starts unchecked — Z-up is something the user
  // judges by looking at the result (see parseStepFile's own comment),
  // never carried over from whatever the checkbox happened to show for a
  // previous, unrelated file.
  $("cs-step-zup-row").style.display = isStepFilename(file.name) ? "flex" : "none";
  $("cs-step-zup").checked = false;

  $("cs-parse-status").textContent = "Parsing…";
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binStr = "";
    for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
    const base64 = btoa(binStr);

    const parsed = await parseCustomShapeFile(base64, file.name, { zUp: $("cs-step-zup").checked });
    pendingShapeZae = { zae: base64, zaeFilename: file.name };
    zaeDetached = false;
    if (!$("cs-name").value.trim()) $("cs-name").value = file.name.replace(/\.(zae|step|stp)$/i, "");
    // Fills in the real Length/Width/Height from the model's own measured
    // geometry and locks the fields — a real uploaded file is the source
    // of truth for its own dimensions, so hand-editing them afterward
    // would let the stored size silently drift from what was uploaded.
    $("cs-length").value = parsed.lengthMm;
    $("cs-width").value = parsed.widthMm;
    $("cs-height").value = parsed.heightMm;
    setCsDimensionsLocked(true);
    $("cs-parse-status").textContent = `Parsed "${file.name}" successfully - Length/Width/Height filled in below and locked to the uploaded model.`;
  } catch (err) {
    $("cs-parse-status").textContent = `Couldn't parse "${file.name}": ${err.message}`;
  }
}

// Whichever zae/zaeFilename is currently "live" for this modal — a fresh
// upload this session if there is one, else the item being edited's own
// already-attached file (unless "Remove File" detached it). Same
// precedence cs-save's own zaeSource uses below, factored out so the
// Z-up checkbox can re-parse whichever one is actually active without
// duplicating that precedence logic.
function currentZaeSource() {
  return pendingShapeZae ?? (!zaeDetached && shapeEditorExistingItem?.zae ? shapeEditorExistingItem : null);
}

// Re-parses the current file with the new Z-up setting — only meaningful
// once a STEP file is actually attached (the row is hidden otherwise, so
// this can't fire for a .zae or no file at all). Re-measures Length/
// Width/Height too, since rotating 90° swaps which raw axis maps to this
// app's own Width vs Height — covers both a just-uploaded file AND
// toggling this for an existing item's own already-attached file without
// re-uploading it, so the saved zaeZUp flag and the saved dimensions
// never disagree with each other.
$("cs-step-zup").addEventListener("change", async () => {
  const source = currentZaeSource();
  if (!source) return;
  $("cs-parse-status").textContent = "Re-parsing…";
  try {
    const parsed = await parseCustomShapeFile(source.zae, source.zaeFilename, { zUp: $("cs-step-zup").checked });
    $("cs-length").value = parsed.lengthMm;
    $("cs-width").value = parsed.widthMm;
    $("cs-height").value = parsed.heightMm;
    $("cs-parse-status").textContent = `Re-parsed "${source.zaeFilename}" - Length/Width/Height updated for the new orientation.`;
  } catch (err) {
    $("cs-parse-status").textContent = `Couldn't re-parse: ${err.message}`;
  }
});

$("cs-remove-zae").addEventListener("click", () => {
  pendingShapeZae = null;
  zaeDetached = true;
  $("cs-step-zup-row").style.display = "none";
  $("cs-file-input").value = "";
  setCsDimensionsLocked(false);
  $("cs-parse-status").textContent = "File removed - Length/Width/Height are now editable manually.";
});

const csDropzone = $("cs-dropzone");
csDropzone.addEventListener("click", () => $("cs-file-input").click());
csDropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("cs-file-input").click();
});
csDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  csDropzone.classList.add("dragover");
});
csDropzone.addEventListener("dragleave", () => csDropzone.classList.remove("dragover"));
csDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  csDropzone.classList.remove("dragover");
  handleZaeFile(e.dataTransfer.files[0]);
});
$("cs-file-input").addEventListener("change", (e) => handleZaeFile(e.target.files[0]));

$("cs-save").addEventListener("click", async () => {
  const name = $("cs-name").value.trim();
  if (!name) {
    $("cs-parse-status").textContent = "Name is required.";
    return;
  }
  $("cs-parse-status").textContent = "Saving…";
  const baseShape = $("cs-baseshape").value;
  const data = {
    name,
    category: $("cs-category").value.trim() || "Custom Shapes",
    baseShape,
    // A brand-new entry defaults to "planned" for the round-ish types (no
    // true circular packing math exists — same honesty note every other
    // cylinder/bottle/oval-shaped built-in already carries) and "full" for
    // everything else; editing an existing item keeps whatever it already
    // had rather than re-deriving it from a Shape Type change alone.
    engineSupport: shapeEditorExistingItem?.engineSupport ?? (ROUND_BASE_SHAPES.has(baseShape) ? "planned" : "full"),
    note: $("cs-note").value.trim(),
    icon: shapeEditorExistingItem?.icon ?? "icons/box.svg",
    thickness: $("cs-thickness").value ? num("cs-thickness") : null,
    // Always read from the form fields, not from the parsed .zae directly —
    // a file upload only fills these in as a starting point (see
    // handleZaeFile), the user can still override them afterward (e.g. to
    // store a rounded nominal size instead of the model's exact dims).
    lengthMm: $("cs-length").value ? num("cs-length") : null,
    widthMm: $("cs-width").value ? num("cs-width") : null,
    heightMm: $("cs-height").value ? num("cs-height") : null,
  };
  // A newly-uploaded file wins; otherwise, if editing a shape that already
  // had real geometry, keep it — not re-uploading a file this round must
  // not silently wipe out previously-attached geometry. "Remove File"
  // (zaeDetached) is the one explicit exception: the user chose to detach
  // it, so the existing attachment is dropped even though it's still on
  // shapeEditorExistingItem.
  const zaeSource = currentZaeSource();
  if (zaeSource) {
    data.zae = zaeSource.zae;
    data.zaeFilename = zaeSource.zaeFilename;
    // Only meaningful for STEP (see the checkbox's own row, hidden for
    // .zae) — reading the checkbox directly here, not a stored field on
    // zaeSource, since it's the one place both "fresh upload" and
    // "editing an existing item" paths already converge to the same
    // current on-screen state.
    if (isStepFilename(zaeSource.zaeFilename)) data.zaeZUp = $("cs-step-zup").checked;
  }
  try {
    let saved;
    if (shapeEditorExistingItem) {
      const res = await fetch(`${API_BASE}/api/library/shapes/${shapeEditorExistingItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      saved = { id: shapeEditorExistingItem.id, ...data };
    } else {
      const res = await fetch(`${API_BASE}/api/library/shapes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const created = await res.json();
      saved = { id: created.id, ...data };
    }
    customShapesModal.style.display = "none";
    shapeEditorOnSaved?.(saved);
  } catch (err) {
    $("cs-parse-status").textContent = `Couldn't save - is the API server running? (node packages/api/src/server.js). ${err.message}`;
  }
});

// --- Change Color (docs section 4.8) + Graphics Database (11.8/4.9) --------
// CapePack always documents these two together (same "Click Change Color...
// Click Add Graphics" step pair, every workflow) — both cosmetic, neither
// touches packing math. boxColor/activeGraphic are read by renderBoxes();
// resetting the box's material color/faces is otherwise identical to how
// primaryPackBaseShape/primaryPackCustomShape already get reset alongside
// each other everywhere a fresh pack gets picked or cleared.
// Default color — an earlier real Cape Pack Cloud screenshot showed dark
// charcoal gray here; a later one (this session, Create a Case's own
// Solution Report, see CHECKER_COLOR's own comment above) showed a
// distinctly blue accent instead — updated to match the newer evidence,
// per explicit user request ("the color scheme in ours makes it a bit
// difficult to understand").
let boxColor = "#2c4d8a";
let activeGraphic = null; // { texture: THREE.Texture, faces: Set<0-5> } or null — BoxGeometry's own default face-group order: 0=+X(right/F) 1=-X(left/C) 2=+Y(top/A) 3=-Y(bottom/D) 4=+Z(front/B) 5=-Z(back/E)
// Same "Change Color" pattern as boxColor above, for the pallet mesh itself
// (real CapePack's own Pallet Base Styles Add form has a "Change Color"
// field per style — see DATABASES_MENU/pickPallet). Independent variable,
// not part of the readPallet() calc object, matching how boxColor is
// cosmetic-only and never touches packing math.
// Default pale yellow (wood) — same real screenshot as boxColor's own
// comment confirmed this is Cape Pack Cloud's own default pallet color.
let palletColor = "#e8d67a";

// --- Change Color picker modal ---------------------------------------------
// Replaces the plain native <input type="color"> with a curated, professional
// palette (matching the real Cape Pack Cloud "Change Color" dialog's own
// swatch-grid look) while keeping the native color input as the underlying
// value store (hidden, still read/set by every existing .value call below).
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (n) => Math.round(f(n) * 255).toString(16).padStart(2, "0");
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

function buildColorPalette() {
  const grayscale = [0, 20, 35, 50, 65, 78, 88, 96].map((l) => hslToHex(0, 0, l));
  const hues = [4, 28, 40, 90, 165, 210, 255, 320];
  const shades = [
    { s: 45, l: 88 },
    { s: 45, l: 76 },
    { s: 55, l: 60 },
    { s: 60, l: 46 },
    { s: 62, l: 32 },
    { s: 55, l: 20 },
  ];
  const rows = [grayscale];
  for (const shade of shades) {
    rows.push(hues.map((h) => hslToHex(h, shade.s, shade.l)));
  }
  return rows;
}

function isValidHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

let colorPickerOnPick = null;
let colorPickerDefault = "#000000";

function setColorPickerValue(hex) {
  $("cp-native").value = hex;
  $("cp-hex").value = hex;
  $("cp-hex-error").style.display = "none";
  for (const el of $("cp-palette").querySelectorAll(".cp-swatch")) {
    el.classList.toggle("selected", el.dataset.hex.toLowerCase() === hex.toLowerCase());
  }
}

function openColorPicker(currentColor, defaultColor, onPick) {
  colorPickerOnPick = onPick;
  colorPickerDefault = defaultColor;
  setColorPickerValue(currentColor);
  $("color-picker-modal").style.display = "flex";
}

function closeColorPicker() {
  $("color-picker-modal").style.display = "none";
  colorPickerOnPick = null;
}

(function initColorPickerPalette() {
  const container = $("cp-palette");
  for (const row of buildColorPalette()) {
    const rowEl = document.createElement("div");
    rowEl.className = "cp-row";
    for (const hex of row) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "cp-swatch";
      swatch.style.background = hex;
      swatch.dataset.hex = hex;
      swatch.title = hex;
      rowEl.appendChild(swatch);
    }
    container.appendChild(rowEl);
  }
})();

$("cp-palette").addEventListener("click", (e) => {
  const swatch = e.target.closest(".cp-swatch");
  if (!swatch) return;
  setColorPickerValue(swatch.dataset.hex);
});

$("cp-native").addEventListener("input", () => {
  setColorPickerValue($("cp-native").value);
});

$("cp-hex").addEventListener("input", () => {
  const raw = $("cp-hex").value.trim();
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  if (isValidHex(hex)) {
    $("cp-hex-error").style.display = "none";
    $("cp-native").value = hex;
    for (const el of $("cp-palette").querySelectorAll(".cp-swatch")) {
      el.classList.toggle("selected", el.dataset.hex.toLowerCase() === hex.toLowerCase());
    }
  } else {
    $("cp-hex-error").style.display = "block";
  }
});

$("cp-reset").addEventListener("click", () => {
  setColorPickerValue(colorPickerDefault);
});

$("cp-cancel").addEventListener("click", closeColorPicker);
$("color-picker-close").addEventListener("click", closeColorPicker);
$("color-picker-modal").addEventListener("click", (e) => {
  if (e.target.id === "color-picker-modal") closeColorPicker();
});

$("cp-save").addEventListener("click", () => {
  const hex = $("cp-hex").value.trim();
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  if (!isValidHex(normalized)) {
    $("cp-hex-error").style.display = "block";
    return;
  }
  if (colorPickerOnPick) colorPickerOnPick(normalized);
  closeColorPicker();
});

$("p-color-swatch").addEventListener("click", () => {
  openColorPicker(boxColor, "#2c4d8a", (hex) => {
    boxColor = hex;
    $("p-color").value = hex;
    $("p-color-swatch").style.background = hex;
    redraw();
  });
});

$("pl-color-swatch").addEventListener("click", () => {
  openColorPicker(palletColor, "#e8d67a", (hex) => {
    palletColor = hex;
    $("pl-color").value = hex;
    $("pl-color-swatch").style.background = hex;
    redraw();
  });
});


const graphicsModal = $("graphics-modal");
let pendingGraphic = null; // { dataUrl, filename } once an image file is read this session
let graphicsEditingItem = null; // the existing item being edited, or null when adding new

function openGraphicsView() {
  resetGraphicUpload();
  renderGraphicsList();
  graphicsModal.style.display = "flex";
}
$("graphics-close").addEventListener("click", () => {
  graphicsModal.style.display = "none";
});
graphicsModal.addEventListener("click", (e) => {
  if (e.target === graphicsModal) graphicsModal.style.display = "none";
});
$("open-graphics").addEventListener("click", openGraphicsView);

function resetGraphicUpload() {
  graphicsEditingItem = null;
  pendingGraphic = null;
  $("gr-file-input").value = "";
  $("gr-new-fields").style.display = "none";
  $("gr-name").value = "";
  $("gr-description").value = "";
  $("gr-type").value = "cuboid";
  for (const id of ["gr-face-all", "gr-face-front", "gr-face-back", "gr-face-top", "gr-face-bottom", "gr-face-left", "gr-face-right"]) {
    $(id).checked = id === "gr-face-front";
  }
  $("gr-parse-status").textContent = "";
  $("gr-form-heading").textContent = "Add a Graphic";
  $("gr-dropzone-label").textContent = "Upload an image";
  $("gr-dropzone-text").textContent = "Drag and drop an image here, or click to choose one";
  $("gr-save").textContent = "Save Graphic";
  $("gr-cancel-edit").style.display = "none";
}

// Opens the same form as Add, pre-filled from an existing item — the image
// itself stays whatever's already saved unless a new file is dropped/
// chosen (see gr-save's own "new file wins, otherwise keep existing"
// logic below), same reasoning as openShapeEditor's existing-.zae handling:
// re-uploading shouldn't be mandatory just to fix a typo in Name.
function openGraphicsEditor(item) {
  graphicsEditingItem = item;
  pendingGraphic = null;
  $("gr-file-input").value = "";
  $("gr-form-heading").textContent = `Edit "${item.name}"`;
  $("gr-dropzone-label").textContent = "Replace image (optional)";
  $("gr-dropzone-text").textContent = "Drag and drop a new image here, or click to choose one - leave as-is to keep the current image";
  $("gr-preview").src = item.imageDataUrl;
  $("gr-name").value = item.name;
  $("gr-description").value = item.description ?? "";
  $("gr-type").value = item.type ?? "cuboid";
  const itemFaces = new Set(item.faces ?? []);
  for (const name of ["front", "back", "top", "bottom", "left", "right"]) {
    $(`gr-face-${name}`).checked = itemFaces.has(name);
  }
  $("gr-face-all").checked = ["front", "back", "top", "bottom", "left", "right"].every((f) => itemFaces.has(f));
  $("gr-parse-status").textContent = "";
  $("gr-save").textContent = "Update Graphic";
  $("gr-cancel-edit").style.display = "inline-block";
  $("gr-new-fields").style.display = "block";
  updateGraphicPreview();
  $("gr-form-heading").scrollIntoView({ block: "nearest" });
}
$("gr-cancel-edit").addEventListener("click", resetGraphicUpload);

const MAX_GRAPHIC_BYTES = 700_000; // same reasoning as MAX_ZAE_BYTES — API's 1MB body cap, base64-inflated

function handleGraphicFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    $("gr-parse-status").textContent = `"${file.name}" doesn't look like an image file.`;
    return;
  }
  if (file.size > MAX_GRAPHIC_BYTES) {
    $("gr-parse-status").textContent = `"${file.name}" is ${(file.size / 1000).toFixed(0)}KB - graphics are capped at ${(MAX_GRAPHIC_BYTES / 1000).toFixed(0)}KB (the API's own request-size limit, once base64-encoded for storage).`;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingGraphic = { dataUrl: reader.result, filename: file.name };
    $("gr-preview").src = reader.result;
    // Only auto-fill Name from the filename when adding new — editing an
    // existing entry and dropping a replacement image shouldn't silently
    // rename it.
    if (!graphicsEditingItem) $("gr-name").value = file.name.replace(/\.[a-z0-9]+$/i, "");
    $("gr-parse-status").textContent = `Loaded "${file.name}".`;
    $("gr-new-fields").style.display = "block";
    updateGraphicPreview();
  };
  reader.onerror = () => {
    $("gr-parse-status").textContent = `Couldn't read "${file.name}".`;
  };
  reader.readAsDataURL(file);
}

const grDropzone = $("gr-dropzone");
grDropzone.addEventListener("click", () => $("gr-file-input").click());
grDropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("gr-file-input").click();
});
grDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  grDropzone.classList.add("dragover");
});
grDropzone.addEventListener("dragleave", () => grDropzone.classList.remove("dragover"));
grDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  grDropzone.classList.remove("dragover");
  handleGraphicFile(e.dataTransfer.files[0]);
});
$("gr-file-input").addEventListener("change", (e) => handleGraphicFile(e.target.files[0]));

// "All Faces" is a convenience shortcut, not its own stored state — checking
// it just checks the other six, matching CapePack's own dialog (docs 11.8:
// All Faces / Front view / Back view / Face A-F all shown as sibling
// checkboxes with no separate "all" flag persisted).
const GRAPHIC_FACE_IDS = ["gr-face-front", "gr-face-back", "gr-face-top", "gr-face-bottom", "gr-face-left", "gr-face-right"];
$("gr-face-all").addEventListener("change", () => {
  const checked = $("gr-face-all").checked;
  for (const id of GRAPHIC_FACE_IDS) $(id).checked = checked;
  updateGraphicPreview();
});
for (const id of GRAPHIC_FACE_IDS) {
  $(id).addEventListener("change", updateGraphicPreview);
}

function readSelectedFaces() {
  const faces = [];
  if ($("gr-face-front").checked) faces.push("front");
  if ($("gr-face-back").checked) faces.push("back");
  if ($("gr-face-top").checked) faces.push("top");
  if ($("gr-face-bottom").checked) faces.push("bottom");
  if ($("gr-face-left").checked) faces.push("left");
  if ($("gr-face-right").checked) faces.push("right");
  return faces;
}

// A tiny, independent Three.js viewport for the Add/Edit form's own live
// preview (real CapePack: "Preview" with a 3D view, user-supplied
// screenshot) — same independent-scene-per-form pattern as
// ensureCasesTraysScene (ITS own comment explains the render-loop-stops-
// when-detached reasoning, unchanged here). Fixed proxy box, not the real
// pack's own dimensions — graphics are cosmetic and shape-agnostic (see
// boxColor/activeGraphic's own doc comment above), so there's no "real
// size" to preview at. One material per face, textured on whichever faces
// are currently checked — mirrors applyGraphic's FACE_NAME_TO_INDEX
// ordering exactly (right,left,top,bottom,front,back) so this preview
// always matches what "Apply to Pack" (a row click below) will actually
// do — box shapes only, see the Type note in the form.
let graphicPreviewScene, graphicPreviewCamera, graphicPreviewRenderer, graphicPreviewControls, graphicPreviewMesh;
const GRAPHIC_PREVIEW_FACE_ORDER = ["right", "left", "top", "bottom", "front", "back"];
function ensureGraphicPreviewScene(container) {
  // Same fix, same reasoning as ensureCasesTraysScene's own comment
  // (main.js): no preserveDrawingBuffer meant a real risk of this canvas
  // reading back blank despite rendering correctly, and no disposal of
  // the previous renderer/controls on repeat opens — this renderer has
  // the identical construction pattern (copied from around the same time
  // Cases and Trays' own was added), so it gets the identical fix
  // proactively rather than waiting for the same bug report twice.
  graphicPreviewRenderer?.dispose();
  graphicPreviewControls?.dispose();

  graphicPreviewScene = new THREE.Scene();
  graphicPreviewScene.background = new THREE.Color(0xdcdcdc);
  graphicPreviewCamera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
  graphicPreviewRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(graphicPreviewRenderer.domElement);
  graphicPreviewControls = new OrbitControls(graphicPreviewCamera, graphicPreviewRenderer.domElement);
  addZoomControls(container, graphicPreviewCamera, graphicPreviewControls);
  graphicPreviewScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  graphicPreviewScene.add(dirLight);

  const geo = new THREE.BoxGeometry(200, 140, 120);
  // polygonOffset: same coincident face-vs-edges z-fighting fix as the
  // main pallet view's own POLYGON_OFFSET (renderBoxes) — this mesh's
  // own EdgesGeometry outline is added as its own child right below.
  const materials = GRAPHIC_PREVIEW_FACE_ORDER.map(
    () => new THREE.MeshStandardMaterial({ color: 0xd9a441, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
  );
  graphicPreviewMesh = new THREE.Mesh(geo, materials);
  graphicPreviewScene.add(graphicPreviewMesh);
  graphicPreviewMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x8a6a2b })));

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 180;
  graphicPreviewRenderer.setSize(w, h);
  graphicPreviewCamera.aspect = w / h;
  graphicPreviewCamera.updateProjectionMatrix();
  graphicPreviewCamera.position.set(320, 260, 320);
  graphicPreviewControls.target.set(0, 0, 0);
  graphicPreviewControls.update();

  const loop = () => {
    if (!container.isConnected) return; // modal closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, graphicPreviewRenderer, graphicPreviewCamera);
    graphicPreviewControls.update();
    graphicPreviewRenderer.render(graphicPreviewScene, graphicPreviewCamera);
  };
  loop();
}
function updateGraphicPreview() {
  const container = $("gr-3d-preview");
  if (!graphicPreviewMesh || graphicPreviewRenderer?.domElement.parentNode !== container) {
    ensureGraphicPreviewScene(container);
  }
  const imageUrl = pendingGraphic?.dataUrl ?? graphicsEditingItem?.imageDataUrl ?? null;
  const checkedFaces = new Set(readSelectedFaces());
  const texture = imageUrl ? new THREE.TextureLoader().load(imageUrl) : null;
  if (texture) texture.colorSpace = THREE.SRGBColorSpace;
  graphicPreviewMesh.material.forEach((mat, i) => {
    const onThisFace = texture && checkedFaces.has(GRAPHIC_PREVIEW_FACE_ORDER[i]);
    mat.map = onThisFace ? texture : null;
    mat.color.set(onThisFace ? 0xffffff : 0xd9a441);
    mat.needsUpdate = true;
  });
}

$("gr-save").addEventListener("click", async () => {
  const name = $("gr-name").value.trim();
  if (!name) {
    $("gr-parse-status").textContent = "Name is required.";
    return;
  }
  const description = $("gr-description").value.trim();
  if (!description) {
    $("gr-parse-status").textContent = "Description is required.";
    return;
  }
  const faces = readSelectedFaces();
  if (!faces.length) {
    $("gr-parse-status").textContent = "Select at least one face.";
    return;
  }
  // A newly dropped/chosen file wins; otherwise, when editing, keep
  // whatever image the item already had — same "new wins, otherwise keep
  // existing" reasoning as openShapeEditor's own zaeSource handling.
  const image =
    pendingGraphic ?? (graphicsEditingItem ? { dataUrl: graphicsEditingItem.imageDataUrl, filename: graphicsEditingItem.imageFilename } : null);
  if (!image) {
    $("gr-parse-status").textContent = "Choose an image to upload.";
    return;
  }
  $("gr-parse-status").textContent = "Saving…";
  const data = {
    name,
    description,
    type: $("gr-type").value,
    faces,
    imageDataUrl: image.dataUrl,
    imageFilename: image.filename,
  };
  try {
    const res = graphicsEditingItem
      ? await fetch(`${API_BASE}/api/library/graphics/${graphicsEditingItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
      : await fetch(`${API_BASE}/api/library/graphics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    resetGraphicUpload();
    renderGraphicsList();
  } catch (err) {
    $("gr-parse-status").textContent = `Couldn't save - is the API server running? (node packages/api/src/server.js). ${err.message}`;
  }
});

const GRAPHIC_TYPE_LABELS = { cuboid: "Cuboid", cylinder: "Cylinder" };

// DD/MM/YYYY, HH:MM:SS — matches the real admin table's own example
// ("13/06/2024, 10:59:30", user-supplied screenshot) rather than
// toLocaleString()'s locale-dependent format, which wouldn't reliably
// match it.
function formatCreatedAt(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Real admin table columns (user-supplied screenshot): No./Name/
// Description/Type/Created By/Date Created — built as a plain table here
// (reusing the .lib-* classes renderLibraryTable's own tables use, for
// free visual consistency) rather than migrated into that shared function:
// this modal's list and its own bespoke Add/Edit form (image upload, face
// checkboxes, live 3D preview) already live together on one screen, not
// #library-modal's grid/form toggle, so there's nothing to gain by moving
// it — see the HTML comment on #graphics-modal. "Faces" isn't a real
// column there; kept as this app's own addition (genuinely useful at a
// glance for its own per-face apply model) rather than dropped, same
// "extra column beyond the real screen" precedent as Cases and Trays' own
// Max Weight column. "Created By" has no real per-user identity to draw
// from in this app (no company/user-profile system) — derived from
// isBuiltin instead: "System" for the one demo row CapePack itself seeds
// (not replicated here — no real Cape-logo asset to seed it with
// honestly, see db.js), "User" for anything added through this database.
async function renderGraphicsList() {
  const list = $("graphics-list");
  list.innerHTML = `<p style="font-size:12px;color:var(--muted)">Loading…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/library/graphics`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const { items } = await res.json();
    if (!items.length) {
      list.innerHTML = `<p style="font-size:12px;color:var(--muted)">No graphics uploaded yet.</p>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.style.cssText = "overflow-x:auto"; // real screen's 6 columns + actions can exceed this modal's default width
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>
      <th class="lib-no-col">No.</th>
      <th class="lib-name-col">Name</th>
      <th class="lib-wrap-col">Description</th>
      <th class="lib-short-col">Type</th>
      <th class="lib-short-col">Faces</th>
      <th class="lib-short-col">Created By</th>
      <th class="lib-short-col">Date Created</th>
      <th></th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    items.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.className = "lib-row";
      tr.title = "Click to apply this graphic to the current pack";
      for (const text of [
        String(index + 1),
        item.name,
        item.description || "-",
        GRAPHIC_TYPE_LABELS[item.type] ?? item.type,
        (item.faces ?? []).join(", ") || "-",
        item.isBuiltin ? "System" : "User",
        formatCreatedAt(item.createdAt),
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      tr.addEventListener("click", () => applyGraphic(item));

      const actionsTd = document.createElement("td");
      actionsTd.className = "lib-table-actions";
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Edit";
      editBtn.className = "secondary";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openGraphicsEditor(item);
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.className = "secondary";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
        await fetch(`${API_BASE}/api/library/graphics/${item.id}`, { method: "DELETE" });
        if (graphicsEditingItem?.id === item.id) resetGraphicUpload();
        renderGraphicsList();
      });
      actionsTd.append(editBtn, delBtn);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    list.innerHTML = "";
    list.appendChild(wrap);
  } catch (err) {
    list.innerHTML = `<p style="font-size:12px;color:var(--muted)">Couldn't reach the API server - is it running? (node packages/api/src/server.js)</p>`;
  }
}

// BoxGeometry's own default face-group order (materialIndex): 0=+X(right)
// 1=-X(left) 2=+Y(top) 3=-Y(bottom) 4=+Z(front) 5=-Z(back) — see renderBoxes.
const FACE_NAME_TO_INDEX = { right: 0, left: 1, top: 2, bottom: 3, front: 4, back: 5 };

function applyGraphic(item) {
  const texture = new THREE.TextureLoader().load(item.imageDataUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  activeGraphic = { texture, faces: new Set(item.faces.map((f) => FACE_NAME_TO_INDEX[f])) };
  markSelected("sel-graphic", `${item.name} (${item.faces.join(", ")})`, {
    itemId: item.id,
    onClear: () => {
      activeGraphic = null;
      redraw();
    },
  });
  graphicsModal.style.display = "none";
  redraw();
}

// --- KDF Formulae (docs section 11.10) --------------------------------------
// Computes the informational "KDF Dimensions" (docs 4.6.1 step 5, the
// assembled case's reference size) shown read-only in the KDF workflow
// panel. Deliberately never fed into buildKdfBundle/optimizeKdfBundleCount
// — see those functions' own doc comments in kdf.js for why.
const kdfFormulaeModal = $("kdf-formulae-modal");
let kdfFormulaeItems = [];
let kdfFormulaEditingItem = null; // the existing item being edited, or null when adding new

// Real Cape Pack Cloud KDF Formulae screen (user-supplied, 9-row export +
// its own real Add form) confirmed a FIXED shape per dimension, not the
// open-ended +Add/Remove chain this app guessed at from docs prose alone
// before a real screen was available (evaluateKdfFormula, kdf.js, stays a
// correct generic left-to-right evaluator either way — only the UI's own
// shape changed here). KDF Length/Width are each exactly 3 slots: an
// optional parenthesized first slot ("No Selection", skipped — or
// combines the base with Glue Flap), then two mandatory op+value slots.
// KDF Height is exactly 1 slot, no parens, no Glue Flap option. Real
// examples: simple styles (1 Piece Folders, Tray, ...) read
// "L * 1.0000 + 0.0000" (slot 1 skipped, so no parens show); RSC/FOL/HSC
// read "(L - Glue Flap) / 2.0000 ± 0.0000".
const KDF_DIM_META = {
  length: { containerId: "kf-chain-length", baseLabel: "L", title: "KDF Length", slots: 3 },
  width: { containerId: "kf-chain-width", baseLabel: "W", title: "KDF Width", slots: 3 },
  height: { containerId: "kf-chain-height", baseLabel: "Thickness", title: "KDF Height", slots: 1 },
};
const KF_OP_SYMBOL = { "+": "+", "-": "−", "*": "×", "/": "÷" };

const defaultKfSlot1 = () => ({ op: "+", source: "none", value: 0 });
const defaultKfSlot = () => ({ op: "+", source: "value", value: 0 });
// terms: exactly 3 elements for length/width (slot 1 optional/
// parenthesized, slots 2-3 mandatory), or exactly 1 for height — see
// KDF_DIM_META.
let kfDraft = {
  length: [defaultKfSlot1(), defaultKfSlot(), defaultKfSlot()],
  width: [defaultKfSlot1(), defaultKfSlot(), defaultKfSlot()],
  height: [defaultKfSlot()],
};

// Matches the real screen's own display exactly: the optional first slot
// only shows (parenthesized) when it isn't "No Selection" — see
// KDF_DIM_META's own comment for real examples of both shapes.
function formatKdfChain(baseLabel, terms) {
  const opStr = (t) => KF_OP_SYMBOL[t.op] ?? t.op;
  const operandStr = (t) => (t.source === "glueFlap" ? "Glue Flap" : Number(t.value ?? 0).toFixed(4));
  if (terms.length === 1) {
    return `${baseLabel} ${opStr(terms[0])} ${operandStr(terms[0])}`;
  }
  const [slot1, slot2, slot3] = terms;
  const inner = slot1.source === "none" ? baseLabel : `(${baseLabel} ${opStr(slot1)} ${operandStr(slot1)})`;
  return `${inner} ${opStr(slot2)} ${operandStr(slot2)} ${opStr(slot3)} ${operandStr(slot3)}`;
}

// One op-select per slot, plus either a source-select (slot 1 only — No
// Selection/Glue Flap, no numeric value needed for either choice) or a
// numeric value input (every other slot). Fixed slot count per dimension
// (KDF_DIM_META.slots) — no add/remove, matching the real form exactly.
function renderKfDim(dimKey) {
  const meta = KDF_DIM_META[dimKey];
  const terms = kfDraft[dimKey];
  const preview = () => `${meta.title} = ${formatKdfChain(meta.baseLabel, terms)}`;

  const slotHtml = (term, i, showSource) => `
    <div class="kf-slot" data-index="${i}">
      <select class="kf-slot-op">
        <option value="+" ${term.op === "+" ? "selected" : ""}>+</option>
        <option value="-" ${term.op === "-" ? "selected" : ""}>−</option>
        <option value="*" ${term.op === "*" ? "selected" : ""}>×</option>
        <option value="/" ${term.op === "/" ? "selected" : ""}>÷</option>
      </select>
      ${
        showSource
          ? `<select class="kf-slot-source">
               <option value="none" ${term.source === "none" ? "selected" : ""}>No Selection</option>
               <option value="glueFlap" ${term.source === "glueFlap" ? "selected" : ""}>Glue Flap</option>
             </select>`
          : `<input class="kf-slot-value" type="number" step="0.0001" min="0" value="${term.value ?? 0}" />`
      }
    </div>`;

  const body =
    meta.slots === 1
      ? `<div class="kf-dim-row"><span>${meta.baseLabel}</span>${slotHtml(terms[0], 0, false)}</div>`
      : `<div class="kf-dim-row"><span>(</span><span>${meta.baseLabel}</span>${slotHtml(terms[0], 0, true)}<span>)</span>${slotHtml(terms[1], 1, false)}${slotHtml(terms[2], 2, false)}</div>`;

  $(meta.containerId).innerHTML = `
    <label class="kf-chain-label">${meta.title} *</label>
    <div class="kf-dim-body">${body}</div>
    <p class="kf-chain-preview" id="${meta.containerId}-preview">${preview()}</p>
  `;

  $(meta.containerId)
    .querySelectorAll(".kf-slot")
    .forEach((slotEl) => {
      const i = Number(slotEl.dataset.index);
      slotEl.querySelector(".kf-slot-op").addEventListener("change", (e) => {
        terms[i].op = e.target.value;
        $(`${meta.containerId}-preview`).textContent = preview();
      });
      slotEl.querySelector(".kf-slot-source")?.addEventListener("change", (e) => {
        terms[i].source = e.target.value;
        renderKfDim(dimKey);
      });
      // Only patch the preview text on each keystroke (not a full
      // re-render) — re-rendering would recreate the <input> and throw
      // away focus/caret position mid-type.
      slotEl.querySelector(".kf-slot-value")?.addEventListener("input", (e) => {
        terms[i].value = Number(e.target.value);
        $(`${meta.containerId}-preview`).textContent = preview();
      });
    });
}

function resetKfDraft() {
  kdfFormulaEditingItem = null;
  kfDraft = {
    length: [defaultKfSlot1(), defaultKfSlot(), defaultKfSlot()],
    width: [defaultKfSlot1(), defaultKfSlot(), defaultKfSlot()],
    height: [defaultKfSlot()],
  };
  $("kf-name").value = "";
  $("kf-save-status").textContent = "";
  $("kf-form-heading").textContent = "Add a KDF Formula";
  $("kf-save").textContent = "Save Formula";
  $("kf-cancel-edit").style.display = "none";
  for (const dimKey of Object.keys(KDF_DIM_META)) renderKfDim(dimKey);
}

// Deep-copies an existing item's term arrays into kfDraft — editing must
// never mutate the still-displayed table row's own data before Save is
// actually clicked (same reasoning as openGraphicsEditor's own copy-not-
// reference handling).
function openKfFormulaEditor(item) {
  kdfFormulaEditingItem = item;
  kfDraft = {
    length: item.length.map((t) => ({ ...t })),
    width: item.width.map((t) => ({ ...t })),
    height: item.height.map((t) => ({ ...t })),
  };
  $("kf-name").value = item.name;
  $("kf-save-status").textContent = "";
  $("kf-form-heading").textContent = `Edit "${item.name}"`;
  $("kf-save").textContent = "Update Formula";
  $("kf-cancel-edit").style.display = "inline-block";
  for (const dimKey of Object.keys(KDF_DIM_META)) renderKfDim(dimKey);
  $("kf-form-heading").scrollIntoView({ block: "nearest" });
}
$("kf-cancel-edit").addEventListener("click", resetKfDraft);

function openKdfFormulaeView() {
  resetKfDraft();
  renderKdfFormulaeList();
  kdfFormulaeModal.style.display = "flex";
}
$("kdf-formulae-close").addEventListener("click", () => {
  kdfFormulaeModal.style.display = "none";
});
kdfFormulaeModal.addEventListener("click", (e) => {
  if (e.target === kdfFormulaeModal) kdfFormulaeModal.style.display = "none";
});
$("open-kdf-formulae").addEventListener("click", openKdfFormulaeView);

$("kf-save").addEventListener("click", async () => {
  const name = $("kf-name").value.trim();
  if (!name) {
    $("kf-save-status").textContent = "Name is required.";
    return;
  }
  $("kf-save-status").textContent = "Saving…";
  const data = { name, length: kfDraft.length, width: kfDraft.width, height: kfDraft.height };
  try {
    const res = kdfFormulaEditingItem
      ? await fetch(`${API_BASE}/api/library/kdf-formulae/${kdfFormulaEditingItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
      : await fetch(`${API_BASE}/api/library/kdf-formulae`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    resetKfDraft();
    renderKdfFormulaeList();
    await loadKdfFormulae();
  } catch (err) {
    $("kf-save-status").textContent = `Couldn't save - is the API server running? (node packages/api/src/server.js). ${err.message}`;
  }
});

// Real admin table columns (user-supplied screenshot): No./Name/KDF
// Length/KDF Width/KDF Height — reuses the .lib-* class names
// renderLibraryTable's own tables use for free base styling, same mirrored-
// CSS-block reasoning as #graphics-list (see that comment in index.html);
// this stays its own bespoke modal, not migrated into the shared
// #library-modal, since its Add/Edit form (fixed-slot builder) is exactly
// as bespoke as openShapeEditor/openGraphicsEditor's own.
async function renderKdfFormulaeList() {
  const list = $("kdf-formulae-list");
  list.innerHTML = `<p style="font-size:12px;color:var(--muted)">Loading…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/library/kdf-formulae`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const { items } = await res.json();
    if (!items.length) {
      list.innerHTML = `<p style="font-size:12px;color:var(--muted)">No KDF formulae saved yet.</p>`;
      return;
    }
    const wrap = document.createElement("div");
    wrap.style.cssText = "overflow-x:auto";
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>
      <th class="lib-no-col">No.</th>
      <th class="lib-name-col">Name</th>
      <th class="lib-wrap-col">KDF Length</th>
      <th class="lib-wrap-col">KDF Width</th>
      <th class="lib-wrap-col">KDF Height</th>
      <th></th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    items.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.className = "lib-row";
      tr.title = "Click to use this formula for the current KDF Dimensions";

      const noTd = document.createElement("td");
      noTd.textContent = String(index + 1);
      tr.appendChild(noTd);
      const nameTd = document.createElement("td");
      nameTd.textContent = item.name;
      tr.appendChild(nameTd);
      for (const text of [
        formatKdfChain("L", item.length),
        formatKdfChain("W", item.width),
        formatKdfChain("Thickness", item.height),
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        td.style.cssText = "font-family:ui-monospace,monospace;font-size:11px";
        tr.appendChild(td);
      }
      tr.addEventListener("click", async () => {
        await loadKdfFormulae(); // re-sync #kdf-formula's own <option>s before selecting, in case they're stale
        $("kdf-formula").value = item.id;
        recomputeKdfDimensions();
        kdfFormulaeModal.style.display = "none";
      });

      const actionsTd = document.createElement("td");
      actionsTd.className = "lib-table-actions";
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Edit";
      editBtn.className = "secondary";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openKfFormulaEditor(item);
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.className = "secondary";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
        await fetch(`${API_BASE}/api/library/kdf-formulae/${item.id}`, { method: "DELETE" });
        if (kdfFormulaEditingItem?.id === item.id) resetKfDraft();
        renderKdfFormulaeList();
        loadKdfFormulae();
      });
      actionsTd.append(editBtn, delBtn);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    list.innerHTML = "";
    list.appendChild(wrap);
  } catch (err) {
    list.innerHTML = `<p style="font-size:12px;color:var(--muted)">Couldn't reach the API server - is it running? (node packages/api/src/server.js)</p>`;
  }
}

async function loadKdfFormulae() {
  try {
    const res = await fetch(`${API_BASE}/api/library/kdf-formulae`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    kdfFormulaeItems = (await res.json()).items;
  } catch {
    kdfFormulaeItems = [];
  }
  populateKdfFormulaSelect();
}

function populateKdfFormulaSelect() {
  const el = $("kdf-formula");
  const prevValue = el.value;
  el.innerHTML = `<option value="">None</option>`;
  for (const item of kdfFormulaeItems) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name;
    el.appendChild(opt);
  }
  el.value = kdfFormulaeItems.some((i) => i.id === prevValue) ? prevValue : "";
  recomputeKdfDimensions();
}

function recomputeKdfDimensions() {
  const formula = kdfFormulaeItems.find((i) => i.id === $("kdf-formula").value);
  if (!formula) {
    $("kdf-calc-length").value = "";
    $("kdf-calc-width").value = "";
    $("kdf-calc-height").value = "";
    return;
  }
  const ctx = { glueFlap: num("kdf-glueflap") };
  $("kdf-calc-length").value = evaluateKdfFormula(num("kdf-length"), formula.length, ctx).toFixed(4);
  $("kdf-calc-width").value = evaluateKdfFormula(num("kdf-width"), formula.width, ctx).toFixed(4);
  $("kdf-calc-height").value = evaluateKdfFormula(num("kdf-thickness"), formula.height, ctx).toFixed(4);
}

$("kdf-formula").addEventListener("change", recomputeKdfDimensions);
for (const id of ["kdf-length", "kdf-width", "kdf-thickness", "kdf-glueflap"]) {
  $(id).addEventListener("input", recomputeKdfDimensions);
}

$("open-packname-library").addEventListener("click", () => {
  openLibrary(
    "pack-names",
    "Select Pack Name",
    (item) => {
      $("p-packname").value = item.name;
      markSelected("sel-packname", item.name, {
        itemId: item.id,
        onClear: () => {
          $("p-packname").value = "";
        },
      });
    },
    "sel-packname"
  );
});
// Case Content's own Fill Wizard Pack Name (real Cape Pack Cloud
// screenshot: a dropdown showing "Carton") — reuses the SAME "pack-names"
// library and the same free-text-input-plus-picker convention Primary
// Pack's own Pack Name already uses, rather than inventing a second,
// separate preset list with no real evidence for its own contents.
$("open-fw-packname-library").addEventListener("click", () => {
  openLibrary(
    "pack-names",
    "Select Pack Name",
    (item) => {
      $("cc-fw-packname").value = item.name;
      markSelected("sel-fw-packname", item.name, {
        itemId: item.id,
        onClear: () => {
          $("cc-fw-packname").value = "";
        },
      });
    },
    "sel-fw-packname"
  );
});

// "×" (and clicking the dark overlay outside the modal box) used to
// always close the whole modal, even while the Add/Edit form was open —
// user feedback: "when i close edit window i should go one page not to
// the root." Now context-aware: closing while the form is showing steps
// back to the grid/list view underneath it (same as its own Cancel
// button), same as browser/OS dialogs generally don't let one "X" skip
// past an unsaved sub-screen straight to wherever opened the dialog.
// Only closes the whole modal when the grid/list view is what's showing.
function closeLibraryModalOrGoBack() {
  if ($("library-form-view").style.display !== "none") {
    $("library-form-view").style.display = "none";
    $("library-grid-view").style.display = "flex";
  } else {
    modal.style.display = "none";
  }
}
$("library-close").addEventListener("click", closeLibraryModalOrGoBack);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeLibraryModalOrGoBack();
});

// --- Load Details: More Settings (CapePack Load Details > More Settings) ----
// Minimum Load Dimensions, Minimum Area Efficiency, Load Target, and Allow
// Partial Top Layer all live in optimizePallet itself (see optimize.js) and
// propagate through every workflow that funnels through it. Not implemented
// here: No Pattern Gaps (our patterns already place boxes flush with no
// gaps by default, so there's no "with gaps" mode to toggle against),
// Alternate Layers (already exists, at the Report step's Manage Layers
// instead of here), and Clampable Information (report-only fields with no
// effect on the packing computation — see docs/ARCHITECTURE.md).
// Load Details/Compute Edge Crush/Storage Environment are plain buttons
// toggling a hidden panel, not <details> like the Databases menu — same ▸
// rotate-on-open affordance (see .toggle-btn CSS), just driven by JS since
// there's no native disclosure element under a button.
function toggleOptionalSection(buttonId, panelId) {
  const panel = $(panelId);
  const open = panel.style.display === "none";
  panel.style.display = open ? "block" : "none";
  $(buttonId).classList.toggle("open", open);
}

$("ld-toggle").addEventListener("click", () => toggleOptionalSection("ld-toggle", "ld-panel"));

function readLoadOptions() {
  const targetRaw = $("ld-target").value.trim();
  return {
    minLoadLength: num("ld-minlength") || 0,
    minLoadWidth: num("ld-minwidth") || 0,
    minAreaEfficiency: (num("ld-minareaeff") || 0) / 100,
    loadTarget: targetRaw === "" ? null : Number(targetRaw),
    allowPartialTopLayer: $("ld-partial").checked,
  };
}

function readCaseAllowedVertical() {
  const allowed = [];
  if ($("c-vert-length").checked) allowed.push("length");
  if ($("c-vert-width").checked) allowed.push("width");
  if ($("c-vert-height").checked) allowed.push("height");
  return allowed.length ? allowed : ["height"]; // never allow an empty set
}

// Shared by every workflow that searches a new case's own geometry (Create
// a Case, Resize's own caseOptions, Pack Folded Cartons' "New Case" path —
// see wantsCaseSearch/case-options in updateHeadingForWorkflow) — was read
// inline, independently, at 6 separate call sites (3 in the Calculate
// handler, 3 in buildComputeInput for Save/Rerun); one already-missed spot
// meant a saved analysis silently lost whichever setting didn't match on
// rerun. One function now, read once, spread at every call site instead.
// Min/Max OD are optional per axis — omitted (empty string) means "no
// bound on this axis," not 0, so they're left out of odRange entirely
// rather than sent as 0/Infinity.
function readCaseOptions() {
  const odRange = {};
  for (const axis of ["length", "width", "height"]) {
    const min = $(`c-od-min-${axis}`).value.trim();
    const max = $(`c-od-max-${axis}`).value.trim();
    if (min !== "" || max !== "") {
      odRange[axis] = {};
      if (min !== "") odRange[axis].min = Number(min);
      if (max !== "") odRange[axis].max = Number(max);
    }
  }
  const maxWeightRaw = $("c-maxweight").value.trim();
  return {
    minPerCase: num("c-minper") || 1,
    maxPerCase: num("c-maxper"),
    maxFactor: num("c-maxfactor"),
    caseThickness: num("c-thickness"),
    numThicknesses: {
      length: num("c-numthick-length"),
      width: num("c-numthick-width"),
      height: num("c-numthick-height"),
    },
    slackIn: {
      length: num("c-slackin-length") || 0,
      width: num("c-slackin-width") || 0,
      height: num("c-slackin-height") || 0,
    },
    odRange,
    maxCaseWeight: maxWeightRaw === "" ? undefined : Number(maxWeightRaw),
    caseAllowedVertical: readCaseAllowedVertical(),
  };
}

// Inner Pack (docs: N/A — a genuinely new app feature, no CapePack
// equivalent, user request): an optional 4th level between Primary Pack
// and Secondary Pack (e.g. bottles -> a 6-pack -> a case -> a pallet).
// Mirrors readCaseOptions()'s own shape exactly (same
// candidateContainers()-backed search underneath, see optimizeCase.js),
// plus containerWeight — the inner pack's own real material weight,
// added once per inner pack (unlike the case level, which has never had
// a material-weight-adding field of its own — see
// optimizeCaseWithInnerPack.js's own doc comment).
// Mirrors readCaseAllowedVertical() exactly. User ask "have you checked
// inner case logic?" surfaced this real gap: without it, the assembled
// Inner Pack had no orientation control at all — see optimizeCaseWithInnerPack
// (packing-engine), which passes this straight through as the inner pack's
// own allowedVertical once it's treated as a "primary" for the case search.
function readInnerPackAllowedVertical() {
  const allowed = [];
  if ($("ip-vert-length").checked) allowed.push("length");
  if ($("ip-vert-width").checked) allowed.push("width");
  if ($("ip-vert-height").checked) allowed.push("height");
  return allowed.length ? allowed : ["height"]; // never allow an empty set — same rule as readCaseAllowedVertical
}
function readInnerPackOptions() {
  const weightRaw = $("ip-weight").value.trim();
  return {
    minPerCase: num("ip-minper") || 1,
    maxPerCase: num("ip-maxper"),
    maxFactor: num("ip-maxfactor"),
    caseThickness: num("ip-thickness"),
    numThicknesses: {
      length: num("ip-numthick-length"),
      width: num("ip-numthick-width"),
      height: num("ip-numthick-height"),
    },
    containerWeight: weightRaw === "" ? 0 : Number(weightRaw),
    caseAllowedVertical: readInnerPackAllowedVertical(),
  };
}
function setInnerPackOptions(options) {
  $("ip-enabled").checked = !!options;
  const o = options ?? {};
  $("ip-minper").value = o.minPerCase ?? 1;
  $("ip-maxper").value = o.maxPerCase ?? 6;
  $("ip-maxfactor").value = o.maxFactor ?? 6;
  $("ip-thickness").value = o.caseThickness ?? 0.5;
  const nt = o.numThicknesses ?? {};
  $("ip-numthick-length").value = nt.length ?? 2;
  $("ip-numthick-width").value = nt.width ?? 2;
  $("ip-numthick-height").value = nt.height ?? 2;
  $("ip-weight").value = o.containerWeight || "";
  const allowed = o.caseAllowedVertical ?? ["height"];
  $("ip-vert-length").checked = allowed.includes("length");
  $("ip-vert-width").checked = allowed.includes("width");
  $("ip-vert-height").checked = allowed.includes("height");
  updateInnerPackUi();
}
// Case Search's own "Min/Max primary/case" labels mean something
// different once Inner Pack is on (inner packs per case, not primary
// units directly) — relabeled rather than left misleading, same
// discipline as updateStrengthUnitLabels elsewhere in this file.
function updateInnerPackUi() {
  const on = $("ip-enabled").checked;
  $("ip-fields").style.display = on ? "block" : "none";
  $("c-minper-label").textContent = on ? "Min inner packs/case" : "Min primary/case";
  $("c-maxper-label").textContent = on ? "Max inner packs/case" : "Max primary/case";
}
$("ip-enabled").addEventListener("change", updateInnerPackUi);

$("case-canvas-tab-case").addEventListener("click", () => {
  caseDetailView = "case";
  showCaseDetail(currentContext);
});
$("case-canvas-tab-innerpack").addEventListener("click", () => {
  caseDetailView = "innerpack";
  showCaseDetail(currentContext);
});

function readStockCaseAllowedVertical() {
  const allowed = [];
  if ($("sc-vert-length").checked) allowed.push("length");
  if ($("sc-vert-width").checked) allowed.push("width");
  if ($("sc-vert-height").checked) allowed.push("height");
  return allowed.length ? allowed : ["length", "width", "height"]; // never allow an empty set — see the plan's own reasoning for why this default differs from p-vert-*/c-vert-*'s height-only one
}

// Fill a Stock Case's own case-options counterpart to readCaseOptions()
// above — was read inline, independently, at 4 separate call sites (the
// Calculate handler's fillcase/foldedcarton-stock branches, buildComputeInput's
// same two), same "one missed spot loses a setting on rerun" risk.
function readFillCaseOptions() {
  return { minFillEfficiency: num("sc-minfill") / 100 };
}
function setFillCaseOptionFields(options = {}) {
  $("sc-minfill").value = (options.minFillEfficiency ?? 0) * 100;
}

// Build a Pallet's own "Case Content" (real CapePack screenshot,
// user-supplied) — purely descriptive info about what's declared to be
// inside the Secondary Pack placed on the pallet. Confirmed zero effect
// on the packing search (optimizePallet never sees this) or the
// compression calc (strengthInputs() reads none of it — that already has
// its own separate Select Partition library factor, see
// docs/ARCHITECTURE.md). Reads all 4 sub-objects unconditionally
// regardless of the active mode, same as readCaseOptions() etc., so
// switching modes back and forth never drops already-typed values.
function currentCaseContentMode() {
  return [...document.getElementsByName("cc-mode")].find((el) => el.checked)?.value ?? "none";
}
function readCaseContent() {
  return {
    mode: currentCaseContentMode(),
    product: { name: $("cc-product-name").value, quantity: num("cc-product-qty") },
    sheet: { name: $("cc-sheet-name").value, quantity: num("cc-sheet-qty") },
    fillWizard: {
      packName: $("cc-fw-packname").value,
      shape: caseContentFillWizardShape,
      divider: $("cc-fw-divider").value,
      arrangement: { length: num("cc-fw-arr-length") || 1, width: num("cc-fw-arr-width") || 1, height: num("cc-fw-arr-height") || 1 },
      verticalAxis: [...document.getElementsByName("cc-fw-vertical")].find((el) => el.checked)?.value ?? "height",
      switchDirection: [...document.getElementsByName("cc-fw-switch")].find((el) => el.checked)?.value === "on",
    },
  };
}
function updateCaseContentModeUi(mode) {
  for (const el of document.getElementsByName("cc-mode")) el.checked = el.value === mode;
  $("cc-product-fields").style.display = mode === "product" ? "grid" : "none";
  $("cc-sheet-fields").style.display = mode === "sheet" ? "grid" : "none";
  $("cc-fillwizard-fields").style.display = mode === "fillWizard" ? "block" : "none";
}
function updateCaseContentCount() {
  const n = (num("cc-fw-arr-length") || 1) * (num("cc-fw-arr-width") || 1) * (num("cc-fw-arr-height") || 1);
  $("cc-fw-count").textContent = n;
  updateFillWizardPreview();
}

// Real Cape Pack Cloud "Fill Wizard" own live 3D preview (user-supplied
// screenshot) — same lazy-build-once/cheap-rebuild-per-change split this
// app already uses for Cases and Trays' own preview (see
// ensureCasesTraysScene/renderCasesTraysPreview): the renderer/camera/
// controls are built once, the first time this preview actually needs to
// show something; every subsequent Arrangement/shape change just clears
// and rebuilds the box group, not the whole WebGL context.
let fwScene, fwCamera, fwRenderer, fwControls, fwBoxGroup;
function ensureFillWizardScene(container) {
  // preserveDrawingBuffer:true — same real bug this app already hit once
  // for Cases and Trays' own preview (a renderer without it can read back
  // a blank canvas even after successful render calls); copied here from
  // the start instead of waiting to rediscover it a third time.
  fwRenderer?.dispose();
  fwControls?.dispose();
  fwScene = new THREE.Scene();
  fwScene.background = new THREE.Color(0xdcdcdc);
  fwCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  fwRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(fwRenderer.domElement);
  fwControls = new OrbitControls(fwCamera, fwRenderer.domElement);
  addZoomControls(container, fwCamera, fwControls);
  fwScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  fwScene.add(dirLight);
  fwBoxGroup = new THREE.Group();
  fwScene.add(fwBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  fwRenderer.setSize(w, h);
  fwCamera.aspect = w / h;
  fwCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // panel/modal closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, fwRenderer, fwCamera);
    fwControls.update();
    fwRenderer.render(fwScene, fwCamera);
  };
  loop();
}
// Blue/pink checkerboard — matches the real screenshot's own two-color
// grid exactly (a different pair from this app's main pallet-view
// checkerboard, which uses dark charcoal + olive green — real CapePack
// itself apparently uses a different palette per screen, not one fixed
// global pair).
const FW_BLUE = 0x2f5fdb;
const FW_PINK = 0xd6318f;
// Renders a countL x countW x countH grid of unit boxes (or cylinders) —
// NOT the pack's own physical mm dimensions, since Fill Wizard never
// captures those, only counts, matching what the real screenshot itself
// actually shows (a shape grid, not a to-scale box). checker parity
// reuses this app's existing "(i+k)%2 XORed by layer" convention (see
// optimize.js's own `checker` field) for the same brick-offset look.
// Dimension Vertical/Switch Direction are captured (readCaseContent
// above) but deliberately NOT applied here — Fill Wizard has no per-axis
// mm dimension to orient in the first place, and there's no real
// evidence for what Switch Direction visually changes — same "captured
// but not computed" discipline this app already uses for Pack Folded
// Cartons' own Dimensions Vertical field.
function updateFillWizardPreview() {
  const container = $("cc-fw-preview");
  if (!container.isConnected) return;
  if (!fwRenderer || fwRenderer.domElement.parentNode !== container) {
    ensureFillWizardScene(container);
  }
  const countL = Math.max(num("cc-fw-arr-length") || 1, 1);
  const countW = Math.max(num("cc-fw-arr-width") || 1, 1);
  const countH = Math.max(num("cc-fw-arr-height") || 1, 1);
  const isCylinder = caseContentFillWizardShape === "cylinder";

  fwBoxGroup.clear();
  const size = 1;
  const step = size * 1.08; // a thin gap between boxes, echoing the real screenshot's own grid lines
  for (let i = 0; i < countL; i++) {
    for (let j = 0; j < countH; j++) {
      for (let k = 0; k < countW; k++) {
        const parity = ((i + k) % 2) ^ (j % 2);
        const color = parity ? FW_PINK : FW_BLUE;
        const geo = isCylinder
          ? new THREE.CylinderGeometry(size / 2, size / 2, size, 24)
          : new THREE.BoxGeometry(size, size, size);
        // polygonOffset: same coincident face-vs-edges z-fighting fix as
        // the main pallet view's own POLYGON_OFFSET (renderBoxes).
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        mesh.position.set(i * step, j * step, k * step);
        fwBoxGroup.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1c2128 }));
        edges.position.copy(mesh.position);
        fwBoxGroup.add(edges);
      }
    }
  }
  fwBoxGroup.position.set(-((countL - 1) * step) / 2, -((countH - 1) * step) / 2, -((countW - 1) * step) / 2);

  const maxDim = Math.max(countL, countW, countH, 1) * step;
  fwCamera.position.set(maxDim * 1.6, maxDim * 1.3, maxDim * 1.6);
  fwControls.target.set(0, 0, 0);
  fwControls.update();

  $("cc-fw-shape-label").textContent = isCylinder ? "Cylinder" : "Box";
}
function setCaseContentFields(cc = {}) {
  const mode = cc.mode ?? "none";
  updateCaseContentModeUi(mode);
  const product = cc.product ?? {};
  $("cc-product-name").value = product.name ?? "";
  $("cc-product-qty").value = product.quantity ?? 1;
  const sheet = cc.sheet ?? {};
  $("cc-sheet-name").value = sheet.name ?? "";
  $("cc-sheet-qty").value = sheet.quantity ?? 1;
  const fw = cc.fillWizard ?? {};
  $("cc-fw-packname").value = fw.packName ?? "Carton";
  caseContentFillWizardShape = fw.shape ?? "box";
  $("cc-fw-divider").value = fw.divider ?? "None";
  const arr = fw.arrangement ?? {};
  $("cc-fw-arr-length").value = arr.length ?? 1;
  $("cc-fw-arr-width").value = arr.width ?? 1;
  $("cc-fw-arr-height").value = arr.height ?? 1;
  const vertical = fw.verticalAxis ?? "height";
  for (const el of document.getElementsByName("cc-fw-vertical")) el.checked = el.value === vertical;
  for (const el of document.getElementsByName("cc-fw-switch")) el.checked = el.value === (fw.switchDirection ? "on" : "off");
  updateCaseContentCount();
  // no picked-shape summary to restore beyond caseContentFillWizardShape
  // itself — see the open-case-content handler's own summary text, which
  // is derived fresh from the mode/fields above, not a separate stored string.
  $("cc-sel-packtype").style.display = "none";
}

// Hides Case Content entirely outside Build a Pallet OR when the current
// Primary Pack shape isn't a plain box. User-reported real CapePack
// behavior, corrected once from an initial too-narrow guess: "hex jar...
// case content option is not available" was first read as "only shapes
// with engineSupport !== 'full' hide it" (Hex Jar/Oval Tube, both
// bounding-box approximations) — wrong. Follow-up: "can is also the
// same" — a real, fully-supported true cylinder (engineSupport:"full")
// ALSO hides it, which the engineSupport theory can't explain at all.
// The one thing Hex Jar, Oval Tube, AND Can all actually share —
// primaryPackBaseShape !== "box" — is the real rule: Case Content
// describes what's declared inside a real rectangular CASE, which only
// makes sense when the Secondary Pack placed on the pallet genuinely IS
// a box; a can/jar/bottle (or any other non-box shape) sits directly on
// the pallet with no case to describe contents of, regardless of how
// well this engine can compute its own packing geometry.
function updateCaseContentAvailability() {
  const available = $("workflow").value === "pallet" && primaryPackBaseShape === "box";
  $("case-content-row").style.display = available ? "block" : "none";
  if (!available) {
    setCaseContentFields({});
    $("sel-case-content").style.display = "none";
    $("sel-case-content").innerHTML = "";
    if (currentContext?.workflow === "pallet") currentContext.caseContent = { mode: "none" };
  }
}
for (const el of document.getElementsByName("cc-mode")) {
  el.addEventListener("change", () => {
    updateCaseContentModeUi(el.value);
    if (el.value === "fillWizard") updateCaseContentCount(); // first time this panel becomes visible — (re)build the preview now that its container is actually shown
  });
}
["cc-fw-arr-length", "cc-fw-arr-width", "cc-fw-arr-height"].forEach((id) => $(id).addEventListener("input", updateCaseContentCount));
// Shared by both "Select From Library" (an existing shapes-library pick)
// and "Select CAD File" (a freshly-uploaded one) below — applying a picked
// Pack Type to the Fill Wizard is identical either way, only how the item
// was obtained differs.
function applyPackTypeToFillWizard(item) {
  caseContentFillWizardShape = ROUND_BASE_SHAPES.has(item.baseShape) ? "cylinder" : "box";
  $("cc-fw-packname").value = item.name;
  markSelected("cc-sel-packtype", `${item.name} (${item.baseShape ?? "box"})`, {
    itemId: item.id,
    icon: item.icon,
    onClear: () => {
      caseContentFillWizardShape = "box";
      updateFillWizardPreview();
    },
  });
  updateFillWizardPreview();
}
// Real Cape Pack Cloud uses the same "Select From Library" Pack Type
// Library (Explore rail + grid) here as it does for Primary/Secondary
// Pack and Create a Case — user-supplied screenshot, same fix as
// open-packtype-library above. Previously this opened the generic
// #library-modal instead.
$("cc-open-packtype-library").addEventListener("click", () => {
  openPackTypeModal(applyPackTypeToFillWizard, null, { categories: PACK_TYPE_BROWSE_CATEGORIES });
});
// "Select CAD File" — was disabled ("no real CAD/Collada import evidence
// for this specific picker") until this pass. Real evidence already
// existed elsewhere in the app: openShapeEditor is the same Collada-
// upload form Custom Shapes/Browse Shape Library's own "+ Add New" and
// the Pack Type picker's own "Create New Shape" dropzone (pack-type-
// modal-add-new below) already use — a proven upload/parse pipeline, not
// a second implementation. This button is a direct shortcut to that same
// form (skipping the library list/rail entirely, since the user already
// knows they want to upload a file, not browse), applying the saved shape
// to the Fill Wizard exactly like picking an existing one would.
$("cc-open-packtype-cad").addEventListener("click", () => {
  openShapeEditor(null, applyPackTypeToFillWizard);
  $("cs-category").value = "Cases and Trays";
});
function caseContentSummaryText(cc) {
  if (cc.mode === "product") return `Product: ${cc.product.name || "(unnamed)"} × ${cc.product.quantity}`;
  if (cc.mode === "sheet") return `Sheet: ${cc.sheet.name || "(unnamed)"} × ${cc.sheet.quantity}`;
  if (cc.mode === "fillWizard") {
    const { length, width, height } = cc.fillWizard.arrangement;
    return `Fill Wizard: ${cc.fillWizard.packName || "Carton"} (${length}×${width}×${height} = ${length * width * height})`;
  }
  return "";
}
$("open-case-content").addEventListener("click", () => {
  $("case-content-modal").style.display = "flex";
});
$("case-content-modal-close").addEventListener("click", () => {
  $("case-content-modal").style.display = "none";
});
$("case-content-modal").addEventListener("click", (e) => {
  if (e.target === $("case-content-modal")) $("case-content-modal").style.display = "none";
});
$("case-content-apply").addEventListener("click", () => {
  const cc = readCaseContent();
  if (cc.mode === "none") {
    $("sel-case-content").style.display = "none";
    $("sel-case-content").innerHTML = "";
  } else {
    markSelected("sel-case-content", caseContentSummaryText(cc), { onClear: () => setCaseContentFields({}) });
  }
  // Live refresh: editing Case Content after Calculate has already run
  // must not leave the Secondary Pack 3D view showing stale content.
  if (currentContext?.workflow === "pallet") {
    currentContext.caseContent = cc;
    showCaseDetail(currentContext);
  }
  $("case-content-modal").style.display = "none";
});

// --- step 2 -> 3: Calculate --------------------------------------------------
$("calculate").addEventListener("click", () => {
  clearSolutionView(); // see its own comment — guards against a failed calculation leaving the previous one's 3D view/summary stuck on screen
  const primary = readPrimary();
  const pallet = readPallet();
  const searchPallet = searchFootprintPallet(pallet); // overhang/underhang-widened footprint, search only
  const workflow = $("workflow").value;
  const loadOptions = readLoadOptions();

  // topN: 40 everywhere in this file (was 8) — real, user-supplied Cape
  // Pack Cloud output for one real box/pallet combination showed 40
  // distinct solutions where this app, at the time, could only ever find
  // 6: partly a genuinely too-low topN cap, partly optimizePallet's own
  // pattern set missing 4 of CapePack's real 6 pattern types (Trilock/
  // Spiral/Diagonal/Expanded Spiral — see packing-engine/src/patterns/),
  // partly its dedup collapsing real, distinct same-strategy ties too
  // aggressively (see optimize.js's own updated dedup comment). Fixing
  // all three still doesn't reproduce Esko's own internal pattern
  // geometry exactly (undocumented, checked 3 real Esko manuals — see
  // each new pattern file's own doc comment), but does now find a
  // genuinely comparable NUMBER of valid solutions for that same real
  // scenario (16, with the real vertical-axis constraint applied — up
  // from 6) — 40 as the cap here just stops it being the bottleneck
  // again for scenarios with an even richer solution space.
  if (workflow === "pallet") {
    const solutions = optimizePallet(primary, searchPallet, { objective: settings.objective, topN: 40, ...loadOptions });
    showPalletSolutions(solutions, searchPallet, primary, readCaseContent());
  } else if (workflow === "fillcase") {
    const stockCase = readStockCase();
    const results = fillStockCase(primary, stockCase, searchPallet, { ...readFillCaseOptions(), topN: 40, loadOptions });
    showFillCaseSolutions(results, searchPallet, stockCase);
  } else if (workflow === "resize") {
    const variance = readResizeVariance();
    const results = resizePrimaryPack(primary, variance, searchPallet, {
      varyWeight: $("rz-varyweight").checked,
      caseOptions: { ...readCaseOptions(), loadOptions },
      dependentAxis: resizeDependentAxis(variance),
      topN: 40,
    });
    showResizeSolutions(results, searchPallet);
  } else if (workflow === "foldedcarton") {
    const { carton, cartonsPerBundleRange, caseType, cartonsPerCaseRange } = readFoldedCarton();

    if (caseType === "stock") {
      // Stock Case stays on a single fixed cartonsPerBundle (the range's
      // own .min) — no real screenshot evidence yet for how Stock Case's
      // own bundle count search behaves, so this sub-workflow is
      // deliberately left unchanged (see docs/ARCHITECTURE.md).
      const cartonsPerBundle = cartonsPerBundleRange.min;
      const bundle = buildFoldedCartonBundle(carton, cartonsPerBundle);
      const stockCase = readStockCase();
      const rawResults = fillStockCase(bundle, stockCase, searchPallet, { ...readFillCaseOptions(), topN: 40, loadOptions });
      // fillStockCase's own "primary" here is the BUNDLE, not the folded
      // carton (same distinction the New Case path's own cartonsPerCase/
      // totalCartons fields already carry — see optimizeFoldedCartonBundleCount's
      // own doc comment) — found live: Quick Report/Summary were silently
      // showing bundle counts under "Carton/Case"/"Carton/Load" for this
      // sub-workflow (e.g. 25 bundles/case shown instead of the real 500
      // cartons/case), since fillInfo carried no cartonsPerCase/totalCartons
      // fields for quickReportHtml/summaryHtml's existing carton-vs-bundle
      // check to pick up — same shape/field names as the New Case path so
      // the same display-layer check covers both.
      // Same real Folded Carton per Case min/max the New Case path below
      // now enforces (see optimizeFoldedCartonBundleCount's own doc
      // comment) — Stock Case doesn't call that function at all (a fixed
      // single cartonsPerBundle via fillStockCase instead), so it's
      // applied here as the same plain post-filter rather than duplicated
      // engine logic, since both branches share the one UI field.
      const results = rawResults
        .map((r) => ({
          ...r,
          cartonsPerBundle,
          cartonsPerCase: r.primaryPerCase * cartonsPerBundle,
          totalCartons: r.totalPrimaryUnits * cartonsPerBundle,
        }))
        .filter(
          (r) =>
            (cartonsPerCaseRange.min == null || r.cartonsPerCase >= cartonsPerCaseRange.min) &&
            (cartonsPerCaseRange.max == null || r.cartonsPerCase <= cartonsPerCaseRange.max)
        );
      showFillCaseSolutions(results, searchPallet, stockCase, "foldedcarton");
    } else {
      const results = optimizeFoldedCartonBundleCount(carton, cartonsPerBundleRange, searchPallet, {
        caseOptions: readCaseOptions(),
        loadOptions,
        topN: 40,
        cartonsPerCaseRange,
      });
      showFoldedCartonBundleSolutions(results, searchPallet);
    }
  } else if (workflow === "kdf") {
    const { flatblank, bundleCountRange, heightFactor, additionalStrapWeight, glueFlapMm, formulaId } = readKdf();
    // The selected KDF Formula's own real terms are what buildKdfBundle
    // actually needs (not just its id) — a real Cape Pack Cloud export
    // confirmed the formula genuinely drives the bundle's own footprint
    // and per-unit height (FOL/HSC/RSC-style: Thickness*2, a narrower
    // footprint than the raw flatblank), not just the informational KDF
    // Dimensions display recomputeKdfDimensions() already used this same
    // lookup for — see kdf.js's own doc comment.
    const kdfFormula = kdfFormulaeItems.find((i) => i.id === formulaId);
    const results = optimizeKdfBundleCount(flatblank, bundleCountRange, searchPallet, {
      formula: kdfFormula ? { length: kdfFormula.length, width: kdfFormula.width, height: kdfFormula.height } : undefined,
      glueFlapMm,
      heightFactor,
      additionalStrapWeight,
      topN: 40,
      loadOptions,
    });
    showKdfSolutions(results, searchPallet);
  } else if (workflow === "multisize") {
    const products = readMultiSizeProducts();
    const result = loadMultiSizedProducts(products, searchPallet);
    showMultiSizeSolutions(result, searchPallet);
  } else if ($("ip-enabled").checked) {
    const results = optimizeCaseWithInnerPack(primary, searchPallet, readInnerPackOptions(), {
      ...readCaseOptions(),
      topN: 40,
      loadOptions,
    });
    showCaseSolutions(results, searchPallet, primary);
  } else {
    const results = optimizeCase(primary, searchPallet, { ...readCaseOptions(), topN: 40, loadOptions });
    showCaseSolutions(results, searchPallet, primary);
  }

  goToStep("solutions");
});

// --- step 3 -> 4: View Report ------------------------------------------------
$("view-report").addEventListener("click", () => {
  if (!currentContext) return;
  $("report-summary").innerHTML = quickReportHtml(currentContext) + summaryHtml() + co2CostEstimateHtml(grossLoadWeightKg(currentContext));
  $("r-results").style.display = "none";
  $("r-alternate").checked = alternateLayers;
  formatLoadAdjustment = null;
  $("fl-impact").style.display = "none";
  $("mp-results").style.display = "none";
  // Compression Strength/Manage Layers availability (Load Multi-Sized
  // Products/cylinders) resets in renderSummary() now, not here — both
  // panels live inside Utility (#panel-report) and are only reachable
  // once View Report is clicked, but resetting on every solution-select
  // instead keeps them correct even if the user changes solutions after
  // already viewing the report once, without needing a second click here.
  // Always land on the first AVAILABLE Utility tab, not wherever a
  // previous visit left off — Format Load for everything except Multi-
  // Size, where it (like Master Pallet Base/Compression Strength/Manage
  // Layers) isn't available at all (real CapePack: "the only available
  // utility is truck analysis") and would show nothing but an
  // unavailable note.
  showUtilityTab(currentContext.multiSizeResult ? "util-truck" : "util-formatload");
  goToStep("report");
});

$("r-alternate").addEventListener("change", () => {
  alternateLayers = $("r-alternate").checked;
  redraw();
});

// --- Report: Multi-Dimensional Analysis (docs section 6) --------------------
$("md-run").addEventListener("click", () => {
  if (!currentContext) return;
  const box = readPrimary();
  const pallet = currentContext.pallet;
  const mixed = multiDimensionalAnalysis(box, pallet, {});

  $("md-results").style.display = "block";
  if (!mixed) {
    $("md-results").innerHTML = `<div class="line"><span>No mix found</span><span>check more than one Dimension Vertical axis</span></div>`;
    return;
  }

  const mixRows = mixed.layerMix
    .map((t) => `<div class="line"><span>${t.layers}× layer @ vertical=${t.vertical}, h=${t.h}mm</span><span>${t.perLayer}/layer</span></div>`)
    .join("");
  $("md-results").innerHTML = `
    <div class="line"><span>Selected solution total (uniform)</span><span>${currentContext.solution.totalCount}</span></div>
    <div class="line"><span>Mixed total</span><span>${mixed.totalCount}</span></div>
    ${mixRows}
    <div class="line"><span>Load height</span><span>${mixed.loadHeight.toFixed(1)} mm</span></div>
    <div class="line"><span>Total weight</span><span>${mixed.totalWeight.toFixed(1)} kg</span></div>
  `;
});

// Total primary units carried by ONE of the currently selected pallet loads —
// the multiplier Truck Analysis needs, computed the same way regardless of
// which of the four workflows produced the solution.
function unitsPerPallet() {
  const { workflow, solution, caseInfo, fillInfo, resizeInfo, kdfInfo, multiSizeResult } = currentContext;
  if (multiSizeResult) return multiSizeResult.totalCount;
  if (workflow === "pallet") return solution.totalCount;
  if (workflow === "kdf") return kdfInfo.totalFlatblanks;
  // caseInfo/fillInfo presence (not the workflow string) decides the shape,
  // since Pack Folded Cartons reuses both "case" and "fillcase" contexts
  // under its own workflow label.
  // Same carton-vs-bundle gap as quickReportHtml's own cartonInfo (see its
  // doc comment): Pack Folded Cartons' caseInfo.totalPrimaryUnits/
  // fillInfo.totalPrimaryUnits stay BUNDLE counts even though
  // cartonsPerCase/totalCartons (real carton counts) are attached
  // alongside — found live via Truck Analysis/Master Pallet Base's own
  // "Total primary units" silently under-reporting by a factor of
  // cartonsPerBundle versus the (already-correct) Quick Report figure
  // directly above it on the same page.
  if (caseInfo) return caseInfo.totalCartons ?? caseInfo.totalPrimaryUnits;
  if (fillInfo) return fillInfo.totalCartons ?? fillInfo.totalPrimaryUnits;
  return resizeInfo.totalPrimaryUnits;
}

// CapePack's own "Utility" menu (docs section 8: Format Load / Truck
// Analysis / Editing Layers / Filling the Master Pallet Base) — reached one
// tool at a time, same .subtabs pattern New Analysis's own New/Recent
// toggle already uses, instead of every tool's fields stacked continuously
// on the page (user: "new analysis a bit complex after results"). Editing
// Layers briefly moved out to Solution (user ask: "layer editor should be
// under the solutions, so we see the 3d at the same time") then moved back
// here (user, right after: "i was wrong, layer editor should be part of
// the utility but it should be like in the image, like capepack" — see
// #util-layers's own comment). Compression Strength joined the same
// grouping for the same reason (user: "compression strength should be
// also be part of the utility") — real CapePack itself keeps it as a
// peer to Utility, not nested inside it (see the panel-report comment
// above), but this app now groups both under Utility per direct
// instruction, a disclosed deviation.
const UTILITY_TABS = [
  { tab: "util-tab-formatload", panel: "util-formatload" },
  { tab: "util-tab-truck", panel: "util-truck" },
  { tab: "util-tab-layers", panel: "util-layers" },
  { tab: "util-tab-masterpallet", panel: "util-masterpallet" },
  { tab: "util-tab-strength", panel: "util-strength" },
];
function showUtilityTab(activePanel) {
  for (const { tab, panel } of UTILITY_TABS) {
    $(tab).classList.toggle("active", panel === activePanel);
    $(panel).style.display = panel === activePanel ? "block" : "none";
  }
  // Format Load's own Pack Preview lazily builds its WebGL context the
  // first time its tab is actually shown (same discipline as Layer
  // Editor's ml-open-gated render) — cheap to call again on every
  // revisit, since renderFlPreview/renderFlItemList are both idempotent.
  if (activePanel === "util-formatload" && currentContext) {
    renderFlItemList();
    recomputeFormatLoad();
  }
  // Real CapePack shows "Pallet Load Gross Weight"/"Pallet Load Height" as
  // soon as the Truck Analysis tab is open, before Calculate is clicked.
  if (activePanel === "util-truck" && currentContext) {
    refreshTruckPalletLoadInfo();
  }
}
for (const { tab, panel } of UTILITY_TABS) {
  $(tab).addEventListener("click", () => showUtilityTab(panel));
}

// --- Report: Format Load Additions (docs section 8.1) ------------------------
// Only the additions with an unambiguous physical effect are modeled — see
// docs/PACKING_ALGORITHM.md-style honesty note in formatLoad.js itself.
// Real CapePack "Format Load" screenshots (user-supplied, 5 real panels)
// showed a genuinely different UI shape than this app's own earlier flat
// checkbox list: a left-hand item list (Insert Pallet Base/Pallet Base
// Cap/Layer Pads/Layer Trays/Top Board — Straps/Stretch Wrap appended
// after, this app's own pre-existing additions with no confirmed real
// sidebar position of their own) with ONE selected item's own detail panel
// (its own Apply/Remove buttons, not one global button), a live "Pack
// Preview" 3D panel, and an "Impact" table (Old/New Product Dims vs.
// Maximum Load). Rebuilt to match — same underlying "once"/"perLayerGap"/
// "weightOnly" engine model (formatLoad.js), zero engine changes.
const FL_ITEMS = [
  { key: "insertbase", label: "Insert Pallet Base", type: "once", thicknessId: "fl-insertbase-thickness", weightId: "fl-insertbase-weight" },
  { key: "basecap", label: "Pallet Base Cap", type: "once", thicknessId: "fl-pallet-basecap-thickness", weightId: "fl-pallet-basecap-weight" },
  // Layer Pads/Trays' own `type`/thicknessId/weightId below are UNUSED —
  // recomputeFormatLoad special-cases both keys and reads their real
  // per-layer checkbox table (layerPadsState/layerTraysState) instead,
  // one "once" addition per checked row. Left populated only so every
  // FL_ITEMS entry has the same shape; see renderLayerRowsTable's own
  // doc comment for the real screenshot this is confirmed against.
  { key: "layerpads", label: "Layer Pads", type: "perLayerGap", thicknessId: "fl-layerpads-thickness", weightId: "fl-layerpads-weight" },
  // Real "Thickness" field (NOT "Height") is what's confirmed to feed
  // the height math — user-supplied real before/after (Old 1608mm/
  // 68.6968kg → New 1612.20mm/69.6068kg, one layer's tray checked at
  // Weight 0.9100/Thickness 4.2000/Height 127.0000): the real 4.20mm
  // delta matches Thickness exactly, not Height.
  { key: "layertrays", label: "Layer Trays", type: "perLayerGap", thicknessId: "fl-layertrays-thickness", weightId: "fl-layertrays-weight" },
  { key: "topboard", label: "Top Board", type: "once", thicknessId: "fl-topboard-thickness", weightId: "fl-topboard-weight" },
  // This app had no Top Cap entry at all until a real screenshot showed
  // it as a real, distinct addition (its own sidebar row, separate from
  // Top Board). Same "once" formula as Top Board (no real evidence yet
  // that it works differently — both are a single board/cap sitting once
  // at the top of the load).
  { key: "topcap", label: "Top Cap", type: "once", thicknessId: "fl-topcap-thickness", weightId: "fl-topcap-weight" },
  // A first real screenshot's own before/after didn't decompose cleanly
  // (Weight 1.0/Thickness 1.0/Width 150.0 vs. a 17.90mm/5.539kg delta —
  // a likely confound, e.g. Top Cap left active in that same session).
  // A SECOND, cleaner real screenshot resolved it: Weight 3.6000/
  // Thickness 19.0000 → Old 1550mm/130kg → New 1569.00mm/133.6000kg
  // matches the plain "once" formula exactly (19.00mm, 3.6000kg, both
  // to the decimal). Width (146.0000mm, real) doesn't affect Length/
  // Width in that same real Impact table (unchanged in both rows) — it's
  // the frame's own real border width, read only by renderFlPreview's
  // own picture-frame border geometry below, not by the aggregate math.
  { key: "pictureframe", label: "Picture Frame", type: "once", thicknessId: "fl-pictureframe-thickness", weightId: "fl-pictureframe-weight" },
  // Real before/after (3 examples): weight = checked-position count ×
  // per-post Weight (8 × 1.13kg = 9.04kg exact); height = 2×Thickness
  // always, regardless of count (2mm and 12.8mm on 2 real examples,
  // exactly — see formatLoad.js's own "cornerPost" doc comment); Length
  // AND Width each += 1×Width once, only when count > 0 (5 checked
  // positions, Width 20.0000mm → both +20.00mm exactly, third real
  // example). Count comes from the real 8-checkbox grid (Top/Bottom ×
  // Length1/Length2/Width1/Width2), not a single field.
  {
    key: "hcornerposts",
    label: "Horizontal Corner Posts",
    type: "cornerPost",
    thicknessId: "fl-hcornerposts-thickness",
    weightId: "fl-hcornerposts-weight",
    widthId: "fl-hcornerposts-width",
    countFn: () => document.querySelectorAll('#fl-hcornerposts-checkboxes input[type="checkbox"]:checked').length,
  },
  // Real before/after (user-supplied): Weight 1.1300/Thickness 6.4000 →
  // Length/Width both +12.80mm (2×thickness, Shroud's own "both sides"
  // convention — but on Thickness, not the real Width field, which has
  // no confirmed effect here) and Weight +4.5200kg (4×1.13 — a FIXED
  // count of 4, one per pallet corner, since there's no real per-corner
  // checkbox grid the way Horizontal Corner Posts has). Height was
  // UNCHANGED in that same real export (confirms, doesn't just leave
  // undisclosed, that Position has no height effect — see formatLoad.js's
  // own "verticalCornerPost" type comment).
  {
    key: "vcornerposts",
    label: "Vertical Corner Posts",
    type: "verticalCornerPost",
    thicknessId: "fl-vcornerposts-thickness",
    weightId: "fl-vcornerposts-weight",
    countFn: () => 4,
  },
  // Real "Num. of Straps" field (user-supplied before/after: 3 straps ×
  // 0.01kg = 0.03kg exact) — weight scales by count now, not flat. Was
  // plain "Straps" (no Horizontal/Vertical distinction); relabeled once
  // Vertical Straps turned out to be a real, separate addition too — this
  // one already wired to "Horizontal Straps Profiles" regardless.
  { key: "straps", label: "Horizontal Straps", type: "weightOnly", thicknessId: null, weightId: "fl-straps-weight", countFn: () => num("fl-straps-count") },
  // Real screenshot showed this as its own sidebar entry, distinct from
  // Horizontal Straps. Real before/after: (Across Length 2 + Across
  // Width 2) = 4 straps × 0.01kg = 0.04kg exact — count is the SUM of the
  // two real fields, not a separate single count control.
  { key: "vstraps", label: "Vertical Straps", type: "weightOnly", thicknessId: null, weightId: "fl-vstraps-weight", countFn: () => num("fl-vstraps-acrosslength") + num("fl-vstraps-acrosswidth") },
  // Real before/after: Length/Width each +2×Thickness (wraps both
  // sides), Height +1×Thickness (over the top only), Weight flat. See
  // formatLoad.js's own "wrap" type doc comment for the exact numbers
  // this was confirmed against.
  { key: "shroud", label: "Shroud", type: "wrap", thicknessId: "fl-shroud-thickness", weightId: "fl-shroud-weight" },
  { key: "stretchwrap", label: "Stretch Wrap", type: "weightOnly", thicknessId: null, weightId: "fl-stretchwrap-weight" },
];
const flItemsOn = Object.fromEntries(FL_ITEMS.map((it) => [it.key, false]));
let flSelectedItem = FL_ITEMS[0].key;

// Insert Pallet Base's "Under: Layer N" picker (real CapePack UI,
// user-supplied screenshot: a radio list from the topmost layer down to
// Layer 1, one already selected). 1-indexed, bottom-up, matching the
// real labels — layer 1 is the pallet's own bottommost layer. Only
// repositions where the inserted base (and the box layers built ON it)
// render in the Pack Preview; the real before/after showed the aggregate
// height/weight delta is the SAME regardless of which layer is picked
// (still the plain "once" formula, formatLoad.js), so recomputeFormatLoad
// itself doesn't need this value, only renderFlPreview does.
let insertBaseUnderLayer = 1;
function renderInsertBaseLayerList() {
  const container = $("fl-insertbase-layers");
  if (!container || !currentContext?.solution) return;
  const layers = currentContext.solution.layers;
  if (insertBaseUnderLayer > layers) insertBaseUnderLayer = layers;
  const rows = [];
  for (let n = layers; n >= 1; n--) {
    rows.push(
      `<label style="font-weight:400;display:flex;align-items:center;gap:6px"><input type="radio" name="fl-insertbase-layer" value="${n}" ${n === insertBaseUnderLayer ? "checked" : ""} style="width:auto;margin:0" /> Layer ${n}</label>`
    );
  }
  container.innerHTML = rows.join("");
  container.querySelectorAll('input[name="fl-insertbase-layer"]').forEach((el) =>
    el.addEventListener("change", () => {
      insertBaseUnderLayer = Number(el.value);
      renderFlPreview();
    })
  );
}

// Layer Pads/Trays' own real per-layer checkbox table (2 user-supplied
// real screenshots, same shape for both) — each layer row carries its
// OWN independent {checked, weight, thickness[, height], color}, not one
// shared value applied to every gap the way this app used to model it.
// Confirmed exactly for Pads (2 rows checked, 5.2+4.2mm/0.68+0.68kg
// summed to the real +9.40mm/+1.36kg delta) — recomputeFormatLoad's own
// "layerpads"/"layertrays" handling sums one real "once" addition per
// checked row instead of a flat rate × (layers-1). Rows rebuild fresh
// per new solution (currentContext.solution.layers), same reset
// discipline as insertBaseUnderLayer above.
const PAD_DEFAULT_WEIGHT = 0.3,
  PAD_DEFAULT_THICKNESS = 3,
  PAD_DEFAULT_COLOR = "#f3ead9";
const TRAY_DEFAULT_WEIGHT = 0.5,
  TRAY_DEFAULT_THICKNESS = 2,
  TRAY_DEFAULT_HEIGHT = 20,
  TRAY_DEFAULT_COLOR = "#d98e3b";
let layerPadsState = { rows: [], selectedLayer: null };
let layerTraysState = { rows: [], selectedLayer: null };

function layerRowsStateFor(key) {
  return key === "layerpads" ? layerPadsState : layerTraysState;
}

function resetLayerRowsState(key) {
  const state = layerRowsStateFor(key);
  const layers = currentContext?.solution?.layers ?? 0;
  const hasHeight = key === "layertrays";
  state.rows = [];
  for (let n = layers; n >= 1; n--) {
    state.rows.push({
      layer: n,
      checked: false,
      weight: null,
      thickness: null,
      height: hasHeight ? null : undefined,
      color: key === "layerpads" ? PAD_DEFAULT_COLOR : TRAY_DEFAULT_COLOR,
    });
  }
  state.selectedLayer = state.rows[0]?.layer ?? null;
}

// Pulls the selected row's own value into the form fields (called on row
// select and after a new solution resets the table); the inverse,
// applyFormFieldsToRow, is called whenever those fields are edited.
function syncLayerRowFormFields(key) {
  const state = layerRowsStateFor(key);
  const row = state.rows.find((r) => r.layer === state.selectedLayer);
  if (!row) return;
  const defWeight = key === "layerpads" ? PAD_DEFAULT_WEIGHT : TRAY_DEFAULT_WEIGHT;
  const defThickness = key === "layerpads" ? PAD_DEFAULT_THICKNESS : TRAY_DEFAULT_THICKNESS;
  $(`fl-${key}-weight`).value = row.weight ?? defWeight;
  $(`fl-${key}-thickness`).value = row.thickness ?? defThickness;
  if (key === "layertrays") $(`fl-${key}-height`).value = row.height ?? TRAY_DEFAULT_HEIGHT;
  $(`fl-${key}-color`).value = row.color;
}

function applyFormFieldsToRow(key, row) {
  row.weight = num(`fl-${key}-weight`);
  row.thickness = num(`fl-${key}-thickness`);
  if (key === "layertrays") row.height = num(`fl-${key}-height`);
  row.color = $(`fl-${key}-color`).value;
}

function renderLayerRowsTable(key) {
  const state = layerRowsStateFor(key);
  const tbody = $(`fl-${key}-rows`);
  if (!tbody || !currentContext?.solution) return;
  if (state.rows.length !== currentContext.solution.layers) resetLayerRowsState(key);
  const hasHeight = key === "layertrays";
  tbody.innerHTML = state.rows
    .map(
      (row) => `
      <tr data-layer="${row.layer}" style="cursor:pointer;background:${row.layer === state.selectedLayer ? "#dbe4f5" : "transparent"}">
        <td style="padding:4px;text-align:center"><input type="checkbox" data-layer="${row.layer}" ${row.checked ? "checked" : ""} style="width:auto;margin:0" /></td>
        <td style="padding:4px">${row.layer}</td>
        <td style="padding:4px">${row.weight != null ? row.weight.toFixed(4) : "-"}</td>
        <td style="padding:4px">${row.thickness != null ? row.thickness.toFixed(4) : "-"}</td>
        ${hasHeight ? `<td style="padding:4px">${row.height != null ? row.height.toFixed(4) : "-"}</td>` : ""}
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return; // checkbox has its own handler below
      state.selectedLayer = Number(tr.dataset.layer);
      renderLayerRowsTable(key);
      syncLayerRowFormFields(key);
    })
  );
  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener("change", () => {
      const row = state.rows.find((r) => r.layer === Number(cb.dataset.layer));
      state.selectedLayer = row.layer;
      // A row checked for the first time (never edited) seeds itself
      // from the current form fields, so it has a real value to apply
      // rather than nulls that would silently contribute nothing.
      if (cb.checked && row.weight == null) applyFormFieldsToRow(key, row);
      row.checked = cb.checked;
      renderLayerRowsTable(key);
      syncLayerRowFormFields(key);
      recomputeFormatLoad();
    })
  );
}
for (const key of ["layerpads", "layertrays"]) {
  for (const field of key === "layertrays" ? ["weight", "thickness", "height", "color"] : ["weight", "thickness", "color"]) {
    $(`fl-${key}-${field}`).addEventListener("input", () => {
      const state = layerRowsStateFor(key);
      const row = state.rows.find((r) => r.layer === state.selectedLayer);
      if (row) applyFormFieldsToRow(key, row);
      renderLayerRowsTable(key);
    });
  }
}

function renderFlItemList() {
  $("fl-item-list").innerHTML = FL_ITEMS.map(
    (it) => `
      <div class="fl-item ${it.key === flSelectedItem ? "selected" : ""} ${flItemsOn[it.key] ? "on" : ""}" data-key="${it.key}">
        ${it.label}<span class="fl-item-status">${flItemsOn[it.key] ? "On" : ""}</span>
      </div>`
  ).join("");
  $("fl-item-list")
    .querySelectorAll(".fl-item")
    .forEach((el) =>
      el.addEventListener("click", () => {
        flSelectedItem = el.dataset.key;
        renderFlItemList();
        for (const it of FL_ITEMS) $(`fl-panel-${it.key}`).style.display = it.key === flSelectedItem ? "block" : "none";
      })
    );
}
renderFlItemList();
$(`fl-panel-${flSelectedItem}`).style.display = "block";

// Load Multi-Sized Products has no single "layers" count — each product's
// zone stacks to its own height independently — so a synthetic solution
// with layers=1 is used for it: Top Board/Pallet Base Cap/Insert Pallet
// Base/Straps/Stretch Wrap (weight- or once-only) still apply correctly,
// only Layer Pads/Trays (which scale by layer GAPS) would be honestly
// meaningless here.
function recomputeFormatLoad() {
  if (!currentContext) return;
  // Layer Pads/Trays build one real "once" addition PER CHECKED ROW
  // (their own real per-layer table, see renderLayerRowsTable's own doc
  // comment) instead of the generic single-thicknessId/weightId mapping
  // every other FL_ITEMS entry uses below.
  const additions = [];
  for (const it of FL_ITEMS) {
    if (!flItemsOn[it.key]) continue;
    if (it.key === "layerpads" || it.key === "layertrays") {
      for (const row of layerRowsStateFor(it.key).rows) {
        if (row.checked && row.thickness != null && row.weight != null) {
          additions.push({ type: "once", thickness: row.thickness, weight: row.weight });
        }
      }
      continue;
    }
    additions.push({
      type: it.type,
      thickness: it.thicknessId ? num(it.thicknessId) : undefined,
      weight: it.weightId ? num(it.weightId) : undefined,
      width: it.widthId ? num(it.widthId) : undefined,
      count: it.countFn ? it.countFn() : undefined,
    });
  }
  // effectiveLoad() (below) folds in Layer Editor's own edited layer count
  // when a session is active — Layer Pads/Trays' own "once per gap" math
  // needs the EDITED layer count, not the original solve's, or a deleted/
  // added layer wouldn't change how many pad/tray gaps Format Load charges
  // for.
  const formatLoadSolution = currentContext.multiSizeResult
    ? { layers: 1, loadHeight: currentContext.multiSizeResult.loadHeight, totalWeight: currentContext.multiSizeResult.totalWeight }
    : effectiveLoad();
  // null (not a zero-addition object) when nothing's on — every other
  // consumer of formatLoadAdjustment (currentPalletLoad, the exported
  // PDF) treats null as "fall through to the live, un-adjusted number"
  // via `??`. Since showUtilityTab calls this eagerly on every Format
  // Load tab view (even with nothing toggled on, e.g. via view-report's
  // own "always land on the first Utility tab"), always returning a real
  // object here would freeze a stale snapshot the moment ANYTHING else
  // changes afterward (a real bug hit live: opening Layer Editor and
  // deleting a layer AFTER visiting Format Load left the exported PDF's
  // own Load row silently stuck at the pre-edit layer count, because a
  // stale-but-non-null formatLoadAdjustment kept winning over the fresh
  // effectiveLoad() value). null can never go stale — there's nothing
  // frozen in it.
  formatLoadAdjustment = additions.length > 0 ? applyFormatLoadAdditions(formatLoadSolution, additions) : null;
  renderFlImpactTable();
  renderFlPreview();
}

function renderFlImpactTable() {
  if (!currentContext) return;
  const { pallet, multiSizeResult } = currentContext;
  const footLength = pallet.trueLength ?? pallet.length;
  const footWidth = pallet.trueWidth ?? pallet.width;
  const eff = multiSizeResult ? null : effectiveLoad();
  const oldHeight = multiSizeResult ? multiSizeResult.loadHeight : eff.loadHeight;
  const oldWeight = multiSizeResult ? multiSizeResult.totalWeight : eff.totalWeight;
  const newHeight = formatLoadAdjustment ? formatLoadAdjustment.loadHeight : oldHeight;
  const newWeight = formatLoadAdjustment ? formatLoadAdjustment.totalWeight : oldWeight;
  // Length/Width previously never changed between Old/New — every
  // addition before Shroud only ever touched height/weight. Shroud
  // (type "wrap") is the first one that genuinely changes footprint too
  // (real before/after: +2×thickness on each), so New now reflects that
  // when it's on; Old always stays at the plain pallet footprint.
  const newLength = footLength + (formatLoadAdjustment?.addedLength ?? 0);
  const newWidth = footWidth + (formatLoadAdjustment?.addedWidth ?? 0);
  const row = (label, l, w2, h, wt) =>
    `<tr><td style="padding:4px;color:var(--muted)">${label}</td><td style="padding:4px">${l.toFixed(2)}</td><td style="padding:4px">${w2.toFixed(2)}</td><td style="padding:4px">${h.toFixed(2)}</td><td style="padding:4px">${fmtWeight(wt)}</td></tr>`;
  $("fl-impact").style.display = "block";
  $("fl-impact-body").innerHTML =
    row("Old Product Dims", footLength, footWidth, oldHeight, oldWeight) +
    row("New Product Dims", newLength, newWidth, newHeight, newWeight) +
    row("Maximum Load", pallet.maxLength ?? pallet.length ?? 0, pallet.maxWidth ?? pallet.width ?? 0, pallet.maxHeight ?? 0, pallet.maxWeight ?? 0);
}

for (const it of FL_ITEMS) {
  // Guards a genuinely button-less panel (none currently exist, but kept
  // since a future item might disclose-only like Picture Frame used to).
  const applyBtn = $(`fl-${it.key}-apply`);
  if (!applyBtn) continue;
  applyBtn.addEventListener("click", () => {
    flItemsOn[it.key] = true;
    renderFlItemList();
    recomputeFormatLoad();
  });
  $(`fl-${it.key}-remove`).addEventListener("click", () => {
    flItemsOn[it.key] = false;
    renderFlItemList();
    recomputeFormatLoad();
  });
}

// Format Load Profiles (Databases > Format Load, docs section 11.5) existed
// but nothing actually read from it — every addition below was manual-entry
// only. "Select From Library" per addition loads a saved profile's
// thickness/weight and turns the addition on; fields stay editable
// afterward, same as every other library pick in this app. Pallet Base Cap
// has no matching Format Load Profile category in CapePack's own database
// (docs section 11.5's own list doesn't include one either) — stays
// manual-entry only, honestly, rather than inventing a category that isn't
// real. Insert Pallet Base/Layer Trays are new categories this pass added
// (no real items seeded yet — filters to an empty list until someone adds
// one under Databases, same as any other real-but-unpopulated category).
function wireFormatLoadProfilePicker(buttonId, selId, itemKey, thicknessId, defaultThickness, weightId, defaultWeight, category) {
  $(buttonId).addEventListener("click", () => {
    openLibrary(
      "format-load-profiles",
      `Select ${category.replace(" Profiles", "")} Profile`,
      (item) => {
        flItemsOn[itemKey] = true;
        if (thicknessId) $(thicknessId).value = item.thickness; // Straps/Stretch Wrap have no thickness field in this app
        $(weightId).value = item.weight;
        renderFlItemList();
        recomputeFormatLoad();
        markSelected(selId, item.name, {
          itemId: item.id,
          icon: item.icon,
          onClear: () => {
            flItemsOn[itemKey] = false;
            if (thicknessId) $(thicknessId).value = defaultThickness;
            $(weightId).value = defaultWeight;
            renderFlItemList();
            recomputeFormatLoad();
          },
        });
      },
      selId,
      category
    );
  });
}
wireFormatLoadProfilePicker("fl-insertbase-library", "sel-fl-insertbase", "insertbase", "fl-insertbase-thickness", 12, "fl-insertbase-weight", 8, "Insert Pallet Base Profiles");
wireFormatLoadProfilePicker("fl-topboard-library", "sel-fl-topboard", "topboard", "fl-topboard-thickness", 15, "fl-topboard-weight", 1.5, "Top Board Profiles");
wireFormatLoadProfilePicker("fl-topcap-library", "sel-fl-topcap", "topcap", "fl-topcap-thickness", 12.7, "fl-topcap-weight", 3.63, "Top Cap Profiles");
// Layer Pads/Trays' own per-row table means "pick a profile" has nowhere
// generic to land — it fills the CURRENTLY SELECTED row's own fields
// (and checks that row, since picking a real profile is a real intent to
// use it, unlike every other item here where Apply is still a separate
// click) rather than one shared thicknessId/weightId pair.
function wireLayerRowsProfilePicker(buttonId, selId, key, category) {
  $(buttonId).addEventListener("click", () => {
    openLibrary(
      "format-load-profiles",
      `Select ${category.replace(" Profiles", "")} Profile`,
      (item) => {
        const state = layerRowsStateFor(key);
        const row = state.rows.find((r) => r.layer === state.selectedLayer);
        if (!row) return;
        $(`fl-${key}-thickness`).value = item.thickness;
        $(`fl-${key}-weight`).value = item.weight;
        if (key === "layertrays" && item.height != null) $(`fl-${key}-height`).value = item.height;
        if (item.color) $(`fl-${key}-color`).value = item.color;
        applyFormFieldsToRow(key, row);
        row.checked = true;
        flItemsOn[key] = true;
        renderFlItemList();
        renderLayerRowsTable(key);
        syncLayerRowFormFields(key);
        recomputeFormatLoad();
        markSelected(selId, item.name, { itemId: item.id, icon: item.icon });
      },
      selId,
      category
    );
  });
}
wireLayerRowsProfilePicker("fl-layerpads-library", "sel-fl-layerpads", "layerpads", "Layer Pads Profiles");
wireLayerRowsProfilePicker("fl-layertrays-library", "sel-fl-layertrays", "layertrays", "Layer Trays Profiles");
// Picture Frame's real profile schema also carries Width/Color (see
// "Picture Frame Profiles" in the library seed data) — wireFormatLoad
// ProfilePicker only fills thickness/weight, so those two extra real
// fields are picked up here instead of extending that generic helper
// for one caller.
$("fl-pictureframe-library").addEventListener("click", () => {
  openLibrary(
    "format-load-profiles",
    "Select Picture Frame Profile",
    (item) => {
      flItemsOn.pictureframe = true;
      $("fl-pictureframe-thickness").value = item.thickness;
      $("fl-pictureframe-weight").value = item.weight;
      if (item.width != null) $("fl-pictureframe-width").value = item.width;
      if (item.color) $("fl-pictureframe-color").value = item.color;
      renderFlItemList();
      recomputeFormatLoad();
      markSelected("sel-fl-pictureframe", item.name, {
        itemId: item.id,
        icon: item.icon,
        onClear: () => {
          flItemsOn.pictureframe = false;
          $("fl-pictureframe-thickness").value = 19;
          $("fl-pictureframe-weight").value = 3.6;
          $("fl-pictureframe-width").value = 146;
          renderFlItemList();
          recomputeFormatLoad();
        },
      });
    },
    "sel-fl-pictureframe",
    "Picture Frame Profiles"
  );
});
// Horizontal Straps' own real profile schema (Databases > Format Load >
// Horizontal Straps Profiles) carries real numberOfStraps/width/weight/
// color fields — the generic wireFormatLoadProfilePicker only fills
// weight (and has no thickness field for this item at all), so a saved
// profile's own real strap count/band width/color were silently dropped
// until now.
$("fl-straps-library").addEventListener("click", () => {
  openLibrary(
    "format-load-profiles",
    "Select Horizontal Straps Profile",
    (item) => {
      flItemsOn.straps = true;
      if (item.numberOfStraps != null) $("fl-straps-count").value = item.numberOfStraps;
      $("fl-straps-weight").value = item.weight;
      if (item.width != null) $("fl-straps-width").value = item.width;
      if (item.color) $("fl-straps-color").value = item.color;
      renderFlItemList();
      recomputeFormatLoad();
      markSelected("sel-fl-straps", item.name, { itemId: item.id, icon: item.icon });
    },
    "sel-fl-straps",
    "Horizontal Straps Profiles"
  );
});
// Vertical Straps' own real profile schema (Databases > Format Load >
// Vertical Straps Profiles) carries real acrossLength/acrossWidth/width/
// weight/includePalletBase/color fields — the generic thickness/weight-
// only wireFormatLoadProfilePicker would silently drop all but weight.
$("fl-vstraps-library").addEventListener("click", () => {
  openLibrary(
    "format-load-profiles",
    "Select Vertical Straps Profile",
    (item) => {
      flItemsOn.vstraps = true;
      if (item.acrossLength != null) $("fl-vstraps-acrosslength").value = item.acrossLength;
      if (item.acrossWidth != null) $("fl-vstraps-acrosswidth").value = item.acrossWidth;
      $("fl-vstraps-weight").value = item.weight;
      if (item.width != null) $("fl-vstraps-width").value = item.width;
      $("fl-vstraps-includepalletbase").checked = !!item.includePalletBase;
      if (item.color) $("fl-vstraps-color").value = item.color;
      renderFlItemList();
      recomputeFormatLoad();
      markSelected("sel-fl-vstraps", item.name, { itemId: item.id, icon: item.icon });
    },
    "sel-fl-vstraps",
    "Vertical Straps Profiles"
  );
});
wireFormatLoadProfilePicker("fl-stretchwrap-library", "sel-fl-stretchwrap", "stretchwrap", null, null, "fl-stretchwrap-weight", 0.3, "Stretch Wrap Profiles");
wireFormatLoadProfilePicker("fl-shroud-library", "sel-fl-shroud", "shroud", "fl-shroud-thickness", 4.2, "fl-shroud-weight", 3.5, "Shroud Profiles");
// Horizontal Corner Posts' own real profile schema (Databases > Format
// Load > Horizontal Corner Posts Profiles) carries real Width/Length(%)/
// Color fields AND the same 8 real checkbox positions as this panel's
// own #fl-hcornerposts-checkboxes (topLength1/topLength2/topWidth1/
// topWidth2/bottomLength1/bottomLength2/bottomWidth1/bottomWidth2) — a
// saved profile DOES have a real "which corners" attribute, so picking
// one restores the checkboxes too, unlike the generic
// wireFormatLoadProfilePicker (thickness/weight only) used elsewhere.
const HCORNERPOSTS_CHECKBOX_KEYS = {
  topLength1: "fl-hcornerposts-top-l1",
  topLength2: "fl-hcornerposts-top-l2",
  topWidth1: "fl-hcornerposts-top-w1",
  topWidth2: "fl-hcornerposts-top-w2",
  bottomLength1: "fl-hcornerposts-bottom-l1",
  bottomLength2: "fl-hcornerposts-bottom-l2",
  bottomWidth1: "fl-hcornerposts-bottom-w1",
  bottomWidth2: "fl-hcornerposts-bottom-w2",
};
$("fl-hcornerposts-library").addEventListener("click", () => {
  openLibrary(
    "format-load-profiles",
    "Select Horizontal Corner Posts Profile",
    (item) => {
      flItemsOn.hcornerposts = true;
      $("fl-hcornerposts-thickness").value = item.thickness;
      $("fl-hcornerposts-weight").value = item.weight;
      if (item.width != null) $("fl-hcornerposts-width").value = item.width;
      if (item.length != null) $("fl-hcornerposts-lengthpct").value = item.length;
      if (item.color) $("fl-hcornerposts-color").value = item.color;
      for (const [itemKey, id] of Object.entries(HCORNERPOSTS_CHECKBOX_KEYS)) $(id).checked = !!item[itemKey];
      renderFlItemList();
      recomputeFormatLoad();
      markSelected("sel-fl-hcp", item.name, { itemId: item.id, icon: item.icon });
    },
    "sel-fl-hcp",
    "Horizontal Corner Posts Profiles"
  );
});
$("fl-hcornerposts-selectall").addEventListener("change", (e) => {
  for (const id of Object.values(HCORNERPOSTS_CHECKBOX_KEYS)) $(id).checked = e.target.checked;
});
// Same reasoning as Horizontal Corner Posts' own dedicated picker above —
// the real "Vertical Corner Posts Profiles" schema also carries Width/
// Length(%)/Position/Color, which the generic thickness/weight-only
// wireFormatLoadProfilePicker would silently drop.
$("fl-vcornerposts-library").addEventListener("click", () => {
  openLibrary(
    "format-load-profiles",
    "Select Vertical Corner Posts Profile",
    (item) => {
      flItemsOn.vcornerposts = true;
      $("fl-vcornerposts-thickness").value = item.thickness;
      $("fl-vcornerposts-weight").value = item.weight;
      if (item.width != null) $("fl-vcornerposts-width").value = item.width;
      if (item.length != null) $("fl-vcornerposts-lengthpct").value = item.length;
      if (item.position) $("fl-vcornerposts-position").value = item.position;
      if (item.color) $("fl-vcornerposts-color").value = item.color;
      renderFlItemList();
      recomputeFormatLoad();
      markSelected("sel-fl-vcp", item.name, { itemId: item.id, icon: item.icon });
    },
    "sel-fl-vcp",
    "Vertical Corner Posts Profiles"
  );
});

// Real CapePack "Format Load" own live "Pack Preview" 3D panel
// (user-supplied screenshot) — same lazy-build-once split as
// ensureLayerEditorPreviewScene/ensureTruckAnalysisScene. Renders the
// unmodified solution's own box stack (buildBoxLayout, unaffected by
// Format Load — additions don't change WHICH boxes go where, only the
// total height/weight) plus 2 informational plate meshes: a bottom plate
// (Insert Pallet Base + Pallet Base Cap's combined thickness, when either
// is on — this app doesn't model their real separate stacking positions,
// see #fl-panel-insertbase's own doc note, so both are drawn as one
// combined plate rather than fabricating an order) and a top plate (Top
// Board). Layer Pads/Trays are shown as extra spacing BETWEEN layers
// (their own real thickness/height added to each layer's own z-step) —
// an honest visual signal without needing N-1 separate slab meshes.
let flScene, flCamera, flRenderer, flControls, flPalletGroup, flBoxGroup;
function ensureFormatLoadPreviewScene(container) {
  flRenderer?.dispose();
  flControls?.dispose();
  flScene = new THREE.Scene();
  flScene.background = new THREE.Color(0xdcdcdc);
  flCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  flRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(flRenderer.domElement);
  flControls = new OrbitControls(flCamera, flRenderer.domElement);
  addZoomControls(container, flCamera, flControls);
  flScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  flScene.add(dirLight);
  flPalletGroup = new THREE.Group();
  flScene.add(flPalletGroup);
  flBoxGroup = new THREE.Group();
  flScene.add(flBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  flRenderer.setSize(w, h);
  flCamera.aspect = w / h;
  flCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // Utility tab/panel closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, flRenderer, flCamera);
    flControls.update();
    flRenderer.render(flScene, flCamera);
  };
  loop();
}
function renderFlPreview() {
  const container = $("fl-preview");
  if (!container.isConnected || !currentContext || currentContext.multiSizeResult) return;
  if (!flRenderer || flRenderer.domElement.parentNode !== container) {
    ensureFormatLoadPreviewScene(container);
  }
  const { pallet, solution } = currentContext;
  const deckHeight = pallet.deckHeight ?? 0;
  const trueLength = pallet.trueLength ?? pallet.length;
  const trueWidth = pallet.trueWidth ?? pallet.width;
  // User report: "vertical corner posts... one of them touches to the
  // model but the others are completely out of the model. check all
  // these kind of missalignments in the format load - additions
  // section." Real, confirmed bug: pallet.length/width is the possibly
  // OVERHANG-WIDENED search rectangle (see searchFootprintPallet), not
  // the true pallet's own edges — the true footprint sits CENTERED
  // within it (pallet.length/2, sized trueLength), so its own near/far
  // edges are at pallet.length/2 ± trueLength/2, not at 0/pallet.length.
  // Slab-style additions (addSlab, Shroud, Stretch Wrap) only ever
  // center at pallet.length/2 with trueLength/trueWidth-sized geometry,
  // so they were already correct regardless of overhang — but every
  // EDGE-relative addition below (Picture Frame's border, Horizontal/
  // Vertical Straps, Horizontal/Vertical Corner Posts) used raw 0/
  // pallet.length/pallet.width as if those WERE the true edges, which
  // only happened to look right at zero overhang. edgeOffsetX/Z (0 when
  // overhang is 0, confirmed live) is the correction: every "0" below
  // becomes edgeOffsetX/Z, every "pallet.length"/"pallet.width" becomes
  // edgeOffsetX + trueLength / edgeOffsetZ + trueWidth.
  const edgeOffsetX = (pallet.length - trueLength) / 2;
  const edgeOffsetZ = (pallet.width - trueWidth) / 2;

  // Insert Pallet Base's real "Under: Layer N" picker (user-supplied
  // screenshot, radio list Layer 1..layers) — drawn below the picked
  // layer inside the box loop, not unconditionally at the bottom; see
  // insertBaseUnderLayer/insertOffset below. Pallet Base Cap is a
  // SEPARATE element stacked at the TOP instead — a user-supplied real
  // screenshot showed it as its own open-lattice structure sitting above
  // the topmost layer, not combined with Insert Pallet Base into one
  // bottom plate the way this used to assume.
  const insertBaseThickness = flItemsOn.insertbase ? num("fl-insertbase-thickness") : 0;
  // 0-indexed layer the base sits below (layer 1 = bottommost = index 0,
  // matching layerIdx below); clamped in case the solution changed layer
  // count since the radio list was last rendered.
  const insertBaseLayerIdx0 = Math.min(insertBaseUnderLayer, solution.layers) - 1;
  const capThickness = flItemsOn.basecap ? num("fl-pallet-basecap-thickness") : 0;
  const topBoardThickness = flItemsOn.topboard ? num("fl-topboard-thickness") : 0;
  const topCapThickness = flItemsOn.topcap ? num("fl-topcap-thickness") : 0;
  const pictureFrameThickness = flItemsOn.pictureframe ? num("fl-pictureframe-thickness") : 0;
  // Real per-layer table (see renderLayerRowsTable) — each checked row
  // contributes its OWN thickness/color at its OWN gap, not one shared
  // rate applied to every gap. 0-indexed layer→thickness/color lookups,
  // built only from checked rows when the item is actually on.
  const padByLayerIdx0 = new Map();
  if (flItemsOn.layerpads) {
    for (const row of layerPadsState.rows) if (row.checked && row.thickness) padByLayerIdx0.set(row.layer - 1, row);
  }
  const trayByLayerIdx0 = new Map();
  if (flItemsOn.layertrays) {
    for (const row of layerTraysState.rows) if (row.checked && row.thickness) trayByLayerIdx0.set(row.layer - 1, row);
  }

  flPalletGroup.clear();
  const palletGeo = new THREE.BoxGeometry(trueLength, deckHeight || 10, trueWidth);
  const palletMesh = new THREE.Mesh(palletGeo, new THREE.MeshStandardMaterial({ color: palletColor }));
  palletMesh.position.set(pallet.length / 2, (deckHeight || 10) / 2, pallet.width / 2);
  flPalletGroup.add(palletMesh);

  // Shared by every flat slab this preview draws (pallet base/cap, layer
  // pads/trays, top board/cap) — one box mesh centered at the given z,
  // spanning the pallet's own true footprint.
  const addSlab = (z, thickness, color) => {
    const geo = new THREE.BoxGeometry(trueLength, thickness, trueWidth);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
    mesh.position.set(pallet.length / 2, z + thickness / 2, pallet.width / 2);
    flPalletGroup.add(mesh);
  };

  let zCursor = deckHeight;

  flBoxGroup.clear();
  const CHECKER_COLOR = 0xc0328c;
  // Same coincident face-vs-edges z-fighting fix as renderBoxes' own
  // POLYGON_OFFSET.
  const mat = new THREE.MeshStandardMaterial({ color: boxColor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const matChecker = new THREE.MeshStandardMaterial({ color: CHECKER_COLOR, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321 });
  // Layer Pads/Trays now get their own real slab(s) at every CHECKED gap
  // (not every gap — see padByLayerIdx0/trayByLayerIdx0 above), each
  // using that row's own thickness and color.
  let lastLayerIdx = -1;
  // Running extra height added so far by Insert Pallet Base and Layer
  // Pads/Trays once each is drawn — 0 below the first thing that adds
  // height, growing as the loop crosses each contributing gap. Replaces
  // the old flat "layerIdx × sharedRate" math now that pads/trays can
  // each carry a different thickness per layer.
  let insertOffset = 0;
  let insertBaseDrawn = false;
  let gapOffset = 0;
  for (const b of buildBoxLayout(solution, pallet, { alternateLayers })) {
    const layerIdx = Math.round((b.z - deckHeight) / solution.boxFootprint.h);
    if (layerIdx > lastLayerIdx) {
      if (insertBaseThickness > 0 && !insertBaseDrawn && layerIdx === insertBaseLayerIdx0) {
        const slabZ = zCursor + insertOffset + gapOffset + (b.z - deckHeight);
        addSlab(slabZ, insertBaseThickness, 0xcaa869);
        insertOffset += insertBaseThickness;
        insertBaseDrawn = true;
      }
      const padRow = padByLayerIdx0.get(layerIdx);
      const trayRow = trayByLayerIdx0.get(layerIdx);
      if (layerIdx > 0 && (padRow || trayRow)) {
        let gapZ = zCursor + insertOffset + gapOffset + (b.z - deckHeight);
        if (padRow) {
          addSlab(gapZ, padRow.thickness, padRow.color);
          gapZ += padRow.thickness;
          gapOffset += padRow.thickness;
        }
        if (trayRow) {
          addSlab(gapZ, trayRow.thickness, trayRow.color);
          gapOffset += trayRow.thickness;
        }
      }
      lastLayerIdx = layerIdx;
    }
    const z = zCursor + insertOffset + gapOffset + (b.z - deckHeight);
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mesh = new THREE.Mesh(geo, b.checker ? matChecker : mat);
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, z + b.h / 2);
    mesh.position.copy(center);
    flBoxGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    flBoxGroup.add(edges);
  }

  // Top stack, in order: Pallet Base Cap, then Top Board, then Top Cap —
  // no real evidence for a different order across all three applied
  // together at once, so this just stacks whichever are on, in this
  // app's own Additions list order.
  let topZ = zCursor + insertOffset + gapOffset + (solution.loadHeight - deckHeight);
  if (capThickness > 0) {
    addSlab(topZ, capThickness, 0xd9c06a);
    topZ += capThickness;
  }
  if (topBoardThickness > 0) {
    addSlab(topZ, topBoardThickness, 0x4a9950);
    topZ += topBoardThickness;
  }
  if (topCapThickness > 0) {
    addSlab(topZ, topCapThickness, 0xe8a3b3);
    topZ += topCapThickness;
  }
  // Picture Frame — a real border, not a solid plate (matches the real
  // screenshot's own open-center look): 4 beams around the load's own
  // true footprint, each as wide as the real Width field, resting right
  // on top of whatever else is stacked below it.
  if (pictureFrameThickness > 0) {
    const frameWidth = Math.min(num("fl-pictureframe-width"), Math.min(trueLength, trueWidth) / 2);
    const frameColor = $("fl-pictureframe-color").value;
    const frameMat = new THREE.MeshStandardMaterial({ color: frameColor });
    const frontBackGeo = new THREE.BoxGeometry(trueLength, pictureFrameThickness, frameWidth);
    const sideGeo = new THREE.BoxGeometry(frameWidth, pictureFrameThickness, Math.max(trueWidth - 2 * frameWidth, 0));
    for (const [geo, x, zPos] of [
      [frontBackGeo, pallet.length / 2, edgeOffsetZ + frameWidth / 2],
      [frontBackGeo, pallet.length / 2, edgeOffsetZ + trueWidth - frameWidth / 2],
      [sideGeo, edgeOffsetX + frameWidth / 2, pallet.width / 2],
      [sideGeo, edgeOffsetX + trueLength - frameWidth / 2, pallet.width / 2],
    ]) {
      const mesh = new THREE.Mesh(geo, frameMat);
      mesh.position.set(x, topZ + pictureFrameThickness / 2, zPos);
      flPalletGroup.add(mesh);
    }
    topZ += pictureFrameThickness;
  }

  // Shroud (real "wrap" formula — see FL_ITEMS' own comment): a single
  // translucent box wrapping the whole assembled load (deck through the
  // top stack), inflated by its own thickness on every side — matches the
  // real confirmed geometry exactly, not an approximation like the straps/
  // corner posts below.
  let shroudTop = topZ;
  if (flItemsOn.shroud) {
    const t = num("fl-shroud-thickness");
    const geo = new THREE.BoxGeometry(trueLength + 2 * t, topZ - deckHeight + t, trueWidth + 2 * t);
    const shroudMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe8d477, transparent: true, opacity: 0.45 }));
    shroudMesh.position.set(pallet.length / 2, deckHeight + (topZ - deckHeight + t) / 2, pallet.width / 2);
    flPalletGroup.add(shroudMesh);
    shroudTop = topZ + t;
  }
  // Stretch Wrap — real formula adds weight only, no geometry change (see
  // FL_ITEMS' own weightOnly entry), so this renders as a thin skin AT
  // the load's real boundary rather than inflating it, more transparent
  // and cooler-toned than Shroud so the two read as visually distinct
  // even though neither has an exactly-confirmed visual style, only a
  // confirmed formula.
  if (flItemsOn.stretchwrap) {
    const geo = new THREE.BoxGeometry(trueLength + 2, shroudTop - deckHeight, trueWidth + 2);
    const wrapMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9fb8c9, transparent: true, opacity: 0.25 }));
    wrapMesh.position.set(pallet.length / 2, deckHeight + (shroudTop - deckHeight) / 2, pallet.width / 2);
    flPalletGroup.add(wrapMesh);
  }

  // Straps — real formula only confirmed weight-scales-by-count (see
  // FL_ITEMS' own weightOnly entries); Horizontal Straps' own real band
  // thickness/color ARE now real confirmed fields (Width/Color, read
  // below) even though they have no aggregate height/weight/footprint
  // effect of their own. Exact strap POSITIONING (evenly spaced, 4 short
  // segments per band wrapping the perimeter) is still a reasonable
  // simplification, not confirmed geometry — same disclosed spirit as
  // Straps' own real Across Length/Width fields not affecting position
  // math either. Offset a real margin OUTSIDE the load's own true
  // footprint (not flush with it) — flush geometry z-fights with the box
  // faces and is invisible.
  const STRAP_MARGIN = 15;
  const strapMat = new THREE.MeshStandardMaterial({ color: flItemsOn.straps ? $("fl-straps-color").value : 0x3f7fc4 });
  const addHorizontalStrapBand = (z, thickness) => {
    const front = new THREE.BoxGeometry(trueLength + 2 * STRAP_MARGIN, thickness, STRAP_MARGIN);
    const side = new THREE.BoxGeometry(STRAP_MARGIN, thickness, trueWidth + 2 * STRAP_MARGIN);
    for (const [geo, x, zPos] of [
      [front, pallet.length / 2, edgeOffsetZ - STRAP_MARGIN / 2],
      [front, pallet.length / 2, edgeOffsetZ + trueWidth + STRAP_MARGIN / 2],
      [side, edgeOffsetX - STRAP_MARGIN / 2, pallet.width / 2],
      [side, edgeOffsetX + trueLength + STRAP_MARGIN / 2, pallet.width / 2],
    ]) {
      const mesh = new THREE.Mesh(geo, strapMat);
      mesh.position.set(x, z, zPos);
      flPalletGroup.add(mesh);
    }
  };
  if (flItemsOn.straps) {
    const count = Math.max(1, num("fl-straps-count"));
    const strapThickness = num("fl-straps-width"); // real confirmed field — was a hardcoded 12 before
    const span = shroudTop - deckHeight;
    for (let i = 0; i < count; i++) addHorizontalStrapBand(deckHeight + span * ((i + 1) / (count + 1)), strapThickness);
  }
  if (flItemsOn.vstraps) {
    const count = Math.max(1, num("fl-vstraps-acrosslength") + num("fl-vstraps-acrosswidth"));
    // Real confirmed fields (see #fl-panel-vstraps' own doc comment) —
    // Width/Color were hardcoded (14, blue) before this evidence.
    const vw = num("fl-vstraps-width");
    const postBottom = $("fl-vstraps-includepalletbase").checked ? 0 : deckHeight;
    const vGeo = new THREE.BoxGeometry(vw, shroudTop - postBottom, vw);
    const vMat = new THREE.MeshStandardMaterial({ color: $("fl-vstraps-color").value });
    const m = STRAP_MARGIN / 2;
    const corners = [
      [edgeOffsetX - m, edgeOffsetZ - m],
      [edgeOffsetX + trueLength + m, edgeOffsetZ - m],
      [edgeOffsetX - m, edgeOffsetZ + trueWidth + m],
      [edgeOffsetX + trueLength + m, edgeOffsetZ + trueWidth + m],
    ];
    for (let i = 0; i < Math.min(count, corners.length); i++) {
      const mesh = new THREE.Mesh(vGeo, vMat);
      mesh.position.set(corners[i][0], postBottom + (shroudTop - postBottom) / 2, corners[i][1]);
      flPalletGroup.add(mesh);
    }
  }

  // Corner Posts — real formula confirmed (height +2×thickness always,
  // weight scales by checked-position count, Length/Width footprint
  // +1×Width once when count>0; see formatLoad.js's own "cornerPost"
  // comment) — draws one real beam per CHECKED real position (up to 4
  // top + 4 bottom, matching the real 8-checkbox grid), each beam's own
  // cross-section now the real confirmed Width field rather than a fixed
  // display-only constant.
  if (flItemsOn.hcornerposts) {
    // Real confirmed field (see formatLoad.js's own "cornerPost" width
    // comment) — was a fixed display-only constant before that evidence.
    const w = num("fl-hcornerposts-width");
    // Length (%) — real CapePack field, "captured only" (formatLoad.js's
    // own doc comment: no confirmed effect on the weight/height/footprint
    // formula, which this app deliberately leaves untouched). But unlike
    // Format Load Additions' other unconfirmed fields, this one now DOES
    // control something real here: every one of these 8 posts IS already a
    // beam that literally runs along the load's own Length or Width edge
    // (l1/l2 along Length, w1/w2 along Width) — "what % of that edge this
    // beam visually covers" is the one reading of a field named "Length
    // (%)" that needs no new evidence to justify, only the field's own
    // name and the geometry it's already attached to. Centered on the
    // edge's own midpoint (not flush to either end) since nothing confirms
    // a different anchor. Disclosed as a reasonable visual choice, same
    // spirit as the strap positioning above — not a guessed formula,
    // because it changes no weight/height/footprint number at all.
    const lengthPct = Math.min(100, Math.max(0, num("fl-hcornerposts-lengthpct"))) / 100;
    const postMat = new THREE.MeshStandardMaterial({ color: $("fl-hcornerposts-color").value });
    // Offset a full w/2 OUTSIDE the load's own true edge (not straddling
    // it) — same z-fighting reasoning as the strap bands above; a beam
    // centered exactly on the edge is half-embedded, half-visible.
    const positions = [
      ["fl-hcornerposts-top-l1", pallet.length / 2, edgeOffsetZ - w / 2, topZ - w / 2, trueLength * lengthPct, w],
      ["fl-hcornerposts-top-l2", pallet.length / 2, edgeOffsetZ + trueWidth + w / 2, topZ - w / 2, trueLength * lengthPct, w],
      ["fl-hcornerposts-top-w1", edgeOffsetX - w / 2, pallet.width / 2, topZ - w / 2, w, trueWidth * lengthPct],
      ["fl-hcornerposts-top-w2", edgeOffsetX + trueLength + w / 2, pallet.width / 2, topZ - w / 2, w, trueWidth * lengthPct],
      ["fl-hcornerposts-bottom-l1", pallet.length / 2, edgeOffsetZ - w / 2, deckHeight + w / 2, trueLength * lengthPct, w],
      ["fl-hcornerposts-bottom-l2", pallet.length / 2, edgeOffsetZ + trueWidth + w / 2, deckHeight + w / 2, trueLength * lengthPct, w],
      ["fl-hcornerposts-bottom-w1", edgeOffsetX - w / 2, pallet.width / 2, deckHeight + w / 2, w, trueWidth * lengthPct],
      ["fl-hcornerposts-bottom-w2", edgeOffsetX + trueLength + w / 2, pallet.width / 2, deckHeight + w / 2, w, trueWidth * lengthPct],
    ];
    for (const [id, x, zPos, y, l, wd] of positions) {
      if (!$(id).checked) continue;
      const geo = new THREE.BoxGeometry(l, w, wd);
      const mesh = new THREE.Mesh(geo, postMat);
      mesh.position.set(x, y, zPos);
      flPalletGroup.add(mesh);
    }
  }

  // Vertical Corner Posts — real formula confirmed (Length/Width each
  // +2×Thickness, Weight ×a fixed 4, NO height effect; see formatLoad.js's
  // own "verticalCornerPost" comment) — a FIXED count of 4, one per
  // pallet corner (no real per-corner checkbox grid like the horizontal
  // version). Width (the real, captured-only field) sizes the post's own
  // cross-section. Length (%) and Position used to have no visual effect
  // at all — same fix as Horizontal Corner Posts' own Length (%) above,
  // extended here the same way: a vertical post's own "run axis" IS the
  // height axis, so "Length (%)" reads the same way here as it does for a
  // horizontal beam (% of its own full extent), and Position
  // (Bottom/Center/Top) is the one already-real field that answers the
  // one question Length(%) alone can't: WHERE that partial extent anchors
  // within the load's full height. Neither changes the confirmed weight/
  // footprint formula (still NO height effect on the numbers, exactly as
  // formatLoad.js's own comment already established) — this only changes
  // what's drawn. Disclosed as a visual interpretation of two real,
  // previously-inert fields, not a guessed formula.
  if (flItemsOn.vcornerposts) {
    const pw = num("fl-vcornerposts-width");
    const lengthPct = Math.min(100, Math.max(0, num("fl-vcornerposts-lengthpct"))) / 100;
    const fullSpan = topZ - deckHeight;
    const postSpan = fullSpan * lengthPct;
    const position = $("fl-vcornerposts-position").value;
    const postBottom =
      position === "top" ? deckHeight + fullSpan - postSpan : position === "center" ? deckHeight + (fullSpan - postSpan) / 2 : deckHeight;
    const postMat = new THREE.MeshStandardMaterial({ color: $("fl-vcornerposts-color").value });
    const geo = new THREE.BoxGeometry(pw, postSpan, pw);
    const corners = [
      [edgeOffsetX - pw / 2, edgeOffsetZ - pw / 2],
      [edgeOffsetX + trueLength + pw / 2, edgeOffsetZ - pw / 2],
      [edgeOffsetX - pw / 2, edgeOffsetZ + trueWidth + pw / 2],
      [edgeOffsetX + trueLength + pw / 2, edgeOffsetZ + trueWidth + pw / 2],
    ];
    for (const [x, zPos] of corners) {
      const mesh = new THREE.Mesh(geo, postMat);
      mesh.position.set(x, postBottom + postSpan / 2, zPos);
      flPalletGroup.add(mesh);
    }
  }

  const totalHeight = Math.max(shroudTop, topZ);
  const center = new THREE.Vector3(pallet.length / 2, totalHeight / 2, pallet.width / 2);
  const radius = 0.5 * Math.sqrt(pallet.length ** 2 + pallet.width ** 2 + totalHeight ** 2);
  fitCameraToSphere(flCamera, flControls, center, radius, CAMERA_DIRECTION);
}

// --- Report: Manage Layers (docs section 8.3) + Edit Pattern -----------------
// editedLayers is bottom-to-top internally (matches z-ordering); the list UI
// displays top-down, matching CapePack's own "Layers are listed in top-down
// order." Each entry just tracks whether that layer is 180°-flipped — the
// same geometric operation Alternate Layers already uses, now controllable
// per layer instead of only as a blanket alternate-every-other-one toggle.
// Each entry: { flipped, boxes? }. `boxes` is absent until Edit Pattern
// (below) first touches that layer — absent means "use the calculated
// pattern (optionally 180°-flipped)"; once present, it's a full per-layer
// copy of layerPositions that Edit Pattern mutates directly, letting one
// layer diverge from the shared calculated pattern without needing a
// second, parallel per-box data model.
let editedLayers = null;
// The real CapePack Layer Editor's own Manage Layers table (user-supplied
// screenshot) has a SELECTED row (one at a time, highlighted) whose Flip
// Directions and Add/Up/Down/Delete toolbar act on it — not per-row inline
// buttons. Bottom-to-top index into editedLayers, same convention as the
// array itself.
let selectedLayerIdx = 0;
// Edit Pattern's own selection, one level down from selectedLayerIdx — an
// index into that layer's own position array (layerPositionsFor below), or
// null when nothing's picked. Tied to a specific layer, not global, so
// every entry point that changes selectedLayerIdx or restructures
// editedLayers also resets this back to null (see each one's own comment).
let selectedBoxIdx = null;

function defaultEditedLayers() {
  const { solution } = currentContext;
  selectedLayerIdx = solution.layers - 1; // top layer, matching this app's own existing top-down list convention
  selectedBoxIdx = null;
  return Array.from({ length: solution.layers }, (_, i) => ({
    flipped: alternateLayers && i % 2 === 1,
  }));
}

// The position array a given layer currently renders with — its own Edit
// Pattern override if it has one, else the shared calculated pattern
// (optionally 180°-flipped). Shared by editedLayerBoxes (3D, every layer)
// and Edit Pattern's own floor plan (2D, selected layer only) so there's
// one definition of "what does layer i actually look like right now."
function layerPositionsFor(i) {
  const { pallet, solution } = currentContext;
  const layer = editedLayers[i];
  // Edit Pattern's own override always wins — a layer with manually
  // placed boxes doesn't have the well-defined column/row grid Spread
  // needs, so Spread is a deliberate no-op once boxes exists (see
  // ml-spread's own comment, index.html) rather than guessing at how to
  // reconcile the two.
  if (layer.boxes) return layer.boxes;
  let positions = layer.flipped ? flipLayer180(solution.layerPositions, pallet.length, pallet.width) : solution.layerPositions;
  if (layer.spread) positions = spreadLayer(positions, pallet.length, pallet.width);
  return positions;
}

function editedLayerBoxes() {
  const { pallet, solution } = currentContext;
  const deckHeight = pallet.deckHeight ?? 0;
  const boxes = [];
  editedLayers.forEach((layer, i) => {
    const z = deckHeight + i * solution.boxFootprint.h;
    for (const pos of layerPositionsFor(i)) {
      boxes.push({
        x: pos.x, y: pos.y, z, l: pos.l, w: pos.w, h: solution.boxFootprint.h,
        rotated: !!pos.rotated,
        checker: ((pos.checker ?? 0) + i) % 2,
      });
    }
  });
  return boxes;
}

// Copy-on-write: the first Edit Pattern action on layer i materializes its
// own full position array (a plain deep copy of whatever it was rendering
// with a moment ago, via layerPositionsFor) so it can diverge from the
// shared calculated pattern; later actions just mutate that same array in
// place. Layers never touched by Edit Pattern keep sharing the calculated
// pattern object directly (no unnecessary copies).
function ensureLayerBoxesEditable(i) {
  const layer = editedLayers[i];
  if (!layer.boxes) layer.boxes = layerPositionsFor(i).map((p) => ({ ...p }));
  return layer.boxes;
}

// A box is valid where the pattern search itself would have allowed it:
// fully on the pallet's own length/width footprint, not overlapping any
// other box already in the same layer. Deliberately not checked against
// pallet.trueLength/trueWidth (the overhang-inflated outer frame the
// floor-plan/report drawings use) — overhang is allowance for the LOAD to
// hang past the deck, not room for a container to be dragged there.
function editPatternBoxValid(boxes, idx, pallet) {
  const b = boxes[idx];
  if (b.x < 0 || b.y < 0 || b.x + b.l > pallet.length || b.y + b.w > pallet.width) return false;
  for (let j = 0; j < boxes.length; j++) {
    if (j === idx) continue;
    const o = boxes[j];
    if (b.x < o.x + o.l && b.x + b.l > o.x && b.y < o.y + o.w && b.y + b.w > o.y) return false;
  }
  return true;
}

const EDIT_PATTERN_NUDGE_MM = 10;

function nudgeSelectedBox(dx, dy) {
  if (selectedBoxIdx === null) return;
  const boxes = ensureLayerBoxesEditable(selectedLayerIdx);
  const b = boxes[selectedBoxIdx];
  const prevX = b.x, prevY = b.y;
  b.x += dx;
  b.y += dy;
  if (!editPatternBoxValid(boxes, selectedBoxIdx, currentContext.pallet)) {
    b.x = prevX;
    b.y = prevY;
    $("ep-status").textContent = "Can't move there — overlaps another container or leaves the pallet.";
  } else {
    $("ep-status").textContent = "";
  }
  renderLayerEditor();
}

function rotateSelectedBox() {
  if (selectedBoxIdx === null) return;
  const boxes = ensureLayerBoxesEditable(selectedLayerIdx);
  const b = boxes[selectedBoxIdx];
  const prev = { x: b.x, y: b.y, l: b.l, w: b.w, rotated: b.rotated };
  // Rotate in place around the box's own center, not its corner — a plain
  // l/w swap alone would shift the box's min-corner and read as an
  // unrelated move happening at the same time as the rotate.
  const cx = b.x + b.l / 2, cy = b.y + b.w / 2;
  b.l = prev.w;
  b.w = prev.l;
  b.x = cx - b.l / 2;
  b.y = cy - b.w / 2;
  b.rotated = !prev.rotated;
  if (!editPatternBoxValid(boxes, selectedBoxIdx, currentContext.pallet)) {
    Object.assign(b, prev);
    $("ep-status").textContent = "Can't rotate here — overlaps another container or leaves the pallet.";
  } else {
    $("ep-status").textContent = "";
  }
  renderLayerEditor();
}

// Flat, unfilled top-down SVG, one <rect> per box in the selected layer —
// same approach as the PDF report's own buildTopDownFloorPlanSvg (see its
// comment), just against this layer's own layerPositionsFor instead of
// solution.layerPositions directly, and with click-to-select instead of
// being purely decorative.
function buildEditPatternFloorPlanSvg(boxes, pallet, selectedIdx) {
  const pl = pallet.length, pw = pallet.width;
  const pad = Math.max(pl, pw) * 0.05;
  const vbW = pl + pad * 2, vbH = pw + pad * 2;
  const strokeW = Math.max(pl, pw) * 0.003;
  const rects = boxes
    .map((b, i) => {
      const selected = i === selectedIdx;
      return `<rect data-idx="${i}" x="${b.x + pad}" y="${b.y + pad}" width="${b.l}" height="${b.w}" fill="${selected ? "#dbe4ff" : "#fff"}" stroke="${selected ? "#3b5bdb" : "#444"}" stroke-width="${selected ? strokeW * 2.5 : strokeW}" style="cursor:pointer" />`;
    })
    .join("");
  return `<svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block">
    <rect x="${pad}" y="${pad}" width="${pl}" height="${pw}" fill="none" stroke="#999" stroke-width="${strokeW * 1.3}" />
    ${rects}
  </svg>`;
}

// Re-renders the floor plan for whichever layer is currently selected in
// Manage Layers above, and the selection-dependent controls beside it —
// called at the end of renderLayerEditor() so it always reflects the
// latest editedLayers/selectedLayerIdx/selectedBoxIdx state, same
// rebuild-the-whole-thing-on-any-change pattern renderLayerEditor already
// uses for the ml-list table.
function renderEditPattern() {
  const { pallet } = currentContext;
  const boxes = layerPositionsFor(selectedLayerIdx);
  if (selectedBoxIdx !== null && selectedBoxIdx >= boxes.length) selectedBoxIdx = null;
  $("ep-floorplan").innerHTML = buildEditPatternFloorPlanSvg(boxes, pallet, selectedBoxIdx);
  $("ep-floorplan").querySelectorAll("rect[data-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedBoxIdx = Number(el.dataset.idx);
      renderLayerEditor();
    });
  });

  const hasSelection = selectedBoxIdx !== null;
  for (const id of ["ep-up", "ep-down", "ep-left", "ep-right", "ep-rotate"]) $(id).disabled = !hasSelection;
  $("ep-reset-layer").disabled = !editedLayers[selectedLayerIdx].boxes;
  if (hasSelection) {
    const b = boxes[selectedBoxIdx];
    $("ep-selected-label").textContent = `Selected: ${fmtLength(b.l)} × ${fmtLength(b.w)}${b.rotated ? " (rotated)" : ""}`;
  } else {
    $("ep-selected-label").textContent = "Click a container to select it.";
  }
}

// Real CapePack "Layer Editor" own live "Preview Load" panel (user-supplied
// screenshot, breadcrumb "Report Builder / Layer Editor") — a second,
// independent Three.js context so it can sit beside Manage Layers inside
// the Utility tab without disturbing the main pallet view/canvas. Same
// lazy-build-once/cheap-rebuild-per-change split as ensureFillWizardScene:
// built once, then cheaply rebuilt from editedLayerBoxes() on every
// flip/reorder/copy/delete via renderLayerEditor() below.
let mlScene, mlCamera, mlRenderer, mlControls, mlPalletGroup, mlBoxGroup;
function ensureLayerEditorPreviewScene(container) {
  mlRenderer?.dispose();
  mlControls?.dispose();
  mlScene = new THREE.Scene();
  mlScene.background = new THREE.Color(0xdcdcdc);
  mlCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  mlRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(mlRenderer.domElement);
  mlControls = new OrbitControls(mlCamera, mlRenderer.domElement);
  addZoomControls(container, mlCamera, mlControls);
  mlScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  mlScene.add(dirLight);
  mlPalletGroup = new THREE.Group();
  mlScene.add(mlPalletGroup);
  mlBoxGroup = new THREE.Group();
  mlScene.add(mlBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  mlRenderer.setSize(w, h);
  mlCamera.aspect = w / h;
  mlCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // Utility tab/panel closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, mlRenderer, mlCamera);
    mlControls.update();
    mlRenderer.render(mlScene, mlCamera);
  };
  loop();
}

// Plain boxes only (no cylinder/custom-shape/checker-tint-from-graphics
// branch) — a deliberate, disclosed scope narrowing matching the real
// screenshot itself (plain boxes regardless of the primary pack's actual
// shape) and this app's own existing "Layer Editor covers whole-layer
// operations only" scope note (see #util-layers' own doc comment).
function renderLayerEditorPreview() {
  const container = $("ml-preview");
  if (!container.isConnected || !currentContext || !editedLayers) return;
  if (!mlRenderer || mlRenderer.domElement.parentNode !== container) {
    ensureLayerEditorPreviewScene(container);
  }
  const { pallet, solution } = currentContext;
  const deckHeight = pallet.deckHeight ?? 0;

  mlPalletGroup.clear();
  const trueLength = pallet.trueLength ?? pallet.length;
  const trueWidth = pallet.trueWidth ?? pallet.width;
  const palletGeo = new THREE.BoxGeometry(trueLength, deckHeight || 10, trueWidth);
  const palletMesh = new THREE.Mesh(palletGeo, new THREE.MeshStandardMaterial({ color: palletColor }));
  palletMesh.position.set(pallet.length / 2, (deckHeight || 10) / 2, pallet.width / 2);
  mlPalletGroup.add(palletMesh);

  mlBoxGroup.clear();
  const CHECKER_COLOR = 0xc0328c; // same magenta accent convention as the main pallet view's own renderBoxes
  // Same coincident face-vs-edges z-fighting fix as renderBoxes' own
  // POLYGON_OFFSET.
  const mat = new THREE.MeshStandardMaterial({ color: boxColor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const matChecker = new THREE.MeshStandardMaterial({ color: CHECKER_COLOR, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321 });
  for (const b of editedLayerBoxes()) {
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mesh = new THREE.Mesh(geo, b.checker ? matChecker : mat);
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2);
    mesh.position.copy(center);
    mlBoxGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    mlBoxGroup.add(edges);
  }

  const loadHeight = deckHeight + editedLayers.length * solution.boxFootprint.h;
  const center = new THREE.Vector3(pallet.length / 2, loadHeight / 2, pallet.width / 2);
  const radius = 0.5 * Math.sqrt(pallet.length ** 2 + pallet.width ** 2 + loadHeight ** 2);
  fitCameraToSphere(mlCamera, mlControls, center, radius, CAMERA_DIRECTION);
}

function renderLayerEditor() {
  const { pallet, solution } = currentContext;
  renderPallet(pallet);
  renderBoxes(editedLayerBoxes());
  const deckHeight = pallet.deckHeight ?? 0;
  const editedLoadHeight = deckHeight + editedLayers.length * solution.boxFootprint.h;
  frameCamera(pallet, editedLoadHeight);
  renderPalletDimensionLabels(pallet, editedLoadHeight);
  renderLayerEditorPreview();

  // Real CapePack Manage Layers table (user-supplied screenshot): Layer /
  // Pattern / Flip Layer(s) columns, one SELECTED row at a time (clicked,
  // highlighted) driving a shared Flip Directions dropdown + Add/Up/Down/
  // Delete toolbar below — not per-row inline buttons (this app's own
  // earlier design). "Pattern" shows this solution's real winning strategy
  // (patternLabel(solution.strategy), e.g. "Interlock"), with "(edited)"
  // appended once Edit Pattern (below) has given that specific layer its
  // own diverged positions — the real algorithm name is still more
  // informative than a placeholder for every layer that hasn't been
  // touched, which is still the common case.
  selectedLayerIdx = Math.min(selectedLayerIdx, editedLayers.length - 1);
  const list = $("ml-list");
  list.innerHTML = "";
  // Top-down display order (docs: "layers are listed in top-down order").
  for (let displayIdx = editedLayers.length - 1; displayIdx >= 0; displayIdx--) {
    const i = displayIdx; // underlying index == display index since array is bottom-to-top
    const layer = editedLayers[i];
    const row = document.createElement("tr");
    if (i === selectedLayerIdx) row.classList.add("selected");
    row.innerHTML = `
      <td>${i + 1}${i === editedLayers.length - 1 ? " (top)" : i === 0 ? " (bottom)" : ""}</td>
      <td>${patternLabel(solution.strategy)}${layer.boxes ? " (edited)" : ""}</td>
      <td>${layer.flipped ? "Both" : "None"}</td>
      <td>${layer.spread ? "Yes" : "No"}</td>
    `;
    row.addEventListener("click", () => {
      selectedLayerIdx = i;
      selectedBoxIdx = null; // Edit Pattern's own selection is per-layer — stale once the layer changes
      renderLayerEditor();
    });
    list.appendChild(row);
  }
  $("ml-flip-select").value = editedLayers[selectedLayerIdx].flipped ? "both" : "none";
  $("ml-spread").checked = !!editedLayers[selectedLayerIdx].spread;
  $("ml-up").disabled = selectedLayerIdx >= editedLayers.length - 1;
  $("ml-down").disabled = selectedLayerIdx <= 0;
  $("ml-delete").disabled = editedLayers.length <= 1;

  const perUnitWeight = solution.totalWeight / solution.totalCount;
  const editedTotalCount = editedLayers.length * solution.perLayer;
  const editedTotalWeight = editedTotalCount * perUnitWeight;
  $("ml-totals").innerHTML = `
    <div class="line"><span>Layers</span><span>${editedLayers.length} (was ${solution.layers})</span></div>
    <div class="line"><span>Total count</span><span>${editedTotalCount} (was ${solution.totalCount})</span></div>
    <div class="line"><span>Total weight</span><span>${fmtWeight(editedTotalWeight)}</span></div>
    <div class="line"><span>Load height</span><span>${fmtLength(editedLoadHeight)}</span></div>
  `;
  renderEditPattern();
}

// User ask: "Open Layer Editor should be collapsable." Reuses this app's
// own existing toggle-btn/.toggle-arrow convention (Load Details: More
// Settings, Compute Edge Crush from Materials, Storage Environment) rather
// than a bespoke one — but NOT toggleOptionalSection itself, since opening
// here does real work beyond visibility (seeding editedLayers/rendering the
// list), and — the part that actually needs its own logic — collapsing and
// reopening should keep any in-progress edits, only seeding a fresh
// editedLayers the very first time (editedLayers still null) or after
// "Reset to Calculated Solution"/a new solution selection already cleared
// it (see renderSummary's own reset). Re-seeding on every open would have
// silently thrown away whatever the user had already changed.
$("ml-open").addEventListener("click", () => {
  if (!currentContext) return;
  const panel = $("ml-editor");
  const opening = panel.style.display === "none";
  $("ml-open").classList.toggle("open", opening);
  if (!opening) {
    panel.style.display = "none";
    return;
  }
  if (!editedLayers) editedLayers = defaultEditedLayers();
  panel.style.display = "block";
  renderLayerEditor();
});

$("ml-reset").addEventListener("click", () => {
  if (!currentContext) return;
  editedLayers = defaultEditedLayers(); // also resets selectedBoxIdx
  renderLayerEditor();
});

// Manage Layers table's own shared Flip Directions + Add/Up/Down/Delete
// toolbar (real CapePack screenshot) — acts on the currently SELECTED row
// (selectedLayerIdx), not a per-row inline button set. Wired once here,
// same as ml-open/ml-reset above, rather than re-attached on every
// renderLayerEditor() call. Every handler below also clears
// selectedBoxIdx: Edit Pattern's own selection is meaningless once the
// layer it pointed into has been reordered, replaced, or removed.
$("ml-flip-select").addEventListener("change", () => {
  if (!editedLayers) return;
  const layer = editedLayers[selectedLayerIdx];
  const wantFlipped = $("ml-flip-select").value === "both";
  // A layer Edit Pattern has already diverged (layer.boxes set) no longer
  // reads `flipped` at all (layerPositionsFor prefers `boxes`) — flip its
  // actual positions directly too, or this control would silently do
  // nothing for that one layer while working everywhere else.
  if (layer.boxes && wantFlipped !== layer.flipped) {
    layer.boxes = flipLayer180(layer.boxes, currentContext.pallet.length, currentContext.pallet.width);
  }
  layer.flipped = wantFlipped;
  selectedBoxIdx = null;
  renderLayerEditor();
});
// Real Format Load > Layer Actions > Spread/UnSpread (user-supplied
// screenshots) — confirmed real before/after: a layer's own bounding
// footprint grew from 1068×918mm to exactly 1200×1000mm (the pallet's own
// Maximum Load) after Spread was applied. See spreadLayer's own doc
// comment (packing-engine/src/layerActions.js) for the full derivation.
// Unlike ml-flip-select above, deliberately NOT applied directly to
// layer.boxes when an Edit Pattern override exists: flipLayer180 is its
// own inverse (flipping twice restores the original), so mutating .boxes
// in place is safe either direction; spreadLayer has no such clean
// inverse (there's no well-defined "unspread these exact manually-placed
// boxes back to what they were"). Rather than leave the checkbox and the
// actual geometry able to disagree, this stays a pure flag with no effect
// at all on a layer Edit Pattern has already touched — layerPositionsFor
// ignores .spread whenever .boxes is set, so the checkbox and the render
// always agree, even though checking it visibly does nothing there.
$("ml-spread").addEventListener("change", () => {
  if (!editedLayers) return;
  const layer = editedLayers[selectedLayerIdx];
  layer.spread = $("ml-spread").checked;
  selectedBoxIdx = null;
  renderLayerEditor();
});
$("ml-add").addEventListener("click", () => {
  if (!editedLayers) return;
  const source = editedLayers[selectedLayerIdx];
  // Duplicates the source layer's ACTUAL current pattern, edited or not —
  // carrying over .boxes (a fresh copy, not a shared reference the two
  // layers would otherwise both mutate) alongside .flipped/.spread.
  editedLayers.splice(selectedLayerIdx + 1, 0, {
    flipped: source.flipped,
    spread: source.spread,
    ...(source.boxes ? { boxes: source.boxes.map((p) => ({ ...p })) } : {}),
  });
  selectedLayerIdx += 1;
  selectedBoxIdx = null;
  renderLayerEditor();
});
$("ml-up").addEventListener("click", () => {
  if (!editedLayers || selectedLayerIdx >= editedLayers.length - 1) return;
  [editedLayers[selectedLayerIdx], editedLayers[selectedLayerIdx + 1]] = [editedLayers[selectedLayerIdx + 1], editedLayers[selectedLayerIdx]];
  selectedLayerIdx += 1;
  selectedBoxIdx = null;
  renderLayerEditor();
});
$("ml-down").addEventListener("click", () => {
  if (!editedLayers || selectedLayerIdx <= 0) return;
  [editedLayers[selectedLayerIdx], editedLayers[selectedLayerIdx - 1]] = [editedLayers[selectedLayerIdx - 1], editedLayers[selectedLayerIdx]];
  selectedLayerIdx -= 1;
  selectedBoxIdx = null;
  renderLayerEditor();
});
$("ml-delete").addEventListener("click", () => {
  if (!editedLayers || editedLayers.length <= 1) return;
  editedLayers.splice(selectedLayerIdx, 1);
  selectedLayerIdx = Math.min(selectedLayerIdx, editedLayers.length - 1);
  selectedBoxIdx = null;
  renderLayerEditor();
});

// Edit Pattern's own toolbar — nudge/rotate the selected box (see
// nudgeSelectedBox/rotateSelectedBox's own comments for the move/rotate +
// validate/revert logic), wired once here like the Manage Layers toolbar
// above rather than re-attached on every render. "Up"/"Down" move along
// -y/+y — the same screen-down-is-+y convention the floor plan itself
// draws in (SVG y grows downward), not a physical up/down.
$("ep-up").addEventListener("click", () => nudgeSelectedBox(0, -EDIT_PATTERN_NUDGE_MM));
$("ep-down").addEventListener("click", () => nudgeSelectedBox(0, EDIT_PATTERN_NUDGE_MM));
$("ep-left").addEventListener("click", () => nudgeSelectedBox(-EDIT_PATTERN_NUDGE_MM, 0));
$("ep-right").addEventListener("click", () => nudgeSelectedBox(EDIT_PATTERN_NUDGE_MM, 0));
$("ep-rotate").addEventListener("click", () => rotateSelectedBox());
$("ep-reset-layer").addEventListener("click", () => {
  if (!editedLayers) return;
  delete editedLayers[selectedLayerIdx].boxes;
  selectedBoxIdx = null;
  renderLayerEditor();
});

// Shared by Truck Analysis and Master Pallet Base: the current load's
// footprint/height/weight, using Format Load-adjusted numbers when present.
// The pallet's own tare weight (a real field CapePack tracks — a default
// wood pallet is easily 20-25kg) is added on top of the box weight here:
// Truck Analysis and Master Pallet Base are about how much physical, fully
// loaded pallet mass fits/stacks, and previously this silently dropped the
// pallet's own weight entirely.
// Layer Editor's own edited layer count/totals (editedLayers, when a Layer
// Editor session is active for the CURRENT solution — reordered/copied/
// deleted/flipped layers) — used wherever this app would otherwise read
// the raw, un-edited solution.layers/totalCount/loadHeight/totalWeight
// directly. A real, previously-silent gap: editing layers visibly changes
// Manage Layers' own on-screen totals, but Truck Analysis/Master Pallet
// Base (via currentPalletLoad) and the exported PDF both kept reading the
// original calculated solution regardless — fixed by routing both through
// this one shared function instead of `solution.*` directly. Doesn't apply
// to Load Multi-Sized Products (editedLayers is never set there — Manage
// Layers is gated off for it, see renderSummary).
function effectiveLoad() {
  const { pallet, solution } = currentContext;
  if (!editedLayers) {
    return { layers: solution.layers, totalCount: solution.totalCount, loadHeight: solution.loadHeight, totalWeight: solution.totalWeight };
  }
  const deckHeight = pallet.deckHeight ?? 0;
  const perUnitWeight = solution.totalWeight / solution.totalCount;
  const totalCount = editedLayers.length * solution.perLayer;
  return {
    layers: editedLayers.length,
    totalCount,
    loadHeight: deckHeight + editedLayers.length * solution.boxFootprint.h,
    totalWeight: totalCount * perUnitWeight,
  };
}

function currentPalletLoad() {
  const { pallet, multiSizeResult } = currentContext;
  const eff = multiSizeResult ? null : effectiveLoad();
  const loadHeight = multiSizeResult ? multiSizeResult.loadHeight : eff.loadHeight;
  const loadWeight = multiSizeResult ? multiSizeResult.totalWeight : eff.totalWeight;
  return {
    length: pallet.trueLength ?? pallet.length,
    width: pallet.trueWidth ?? pallet.width,
    height: formatLoadAdjustment?.loadHeight ?? loadHeight,
    weight: (formatLoadAdjustment?.totalWeight ?? loadWeight) + (pallet.weight ?? 0),
  };
}

// --- Report: Master Pallet Base (docs section 8.4) ---------------------------
// Same decomposition as Truck Analysis one more level up: nest copies of the
// current pallet load onto a larger master base.

// Real CapePack "Fill Master Pallet Base" own live 3D preview
// (user-supplied screenshot: a real wood-toned master pallet deck with the
// nested pallet loads stacked on top, dimension lines on 3 edges). Same
// lazy-build-once split as ensureLayerEditorPreviewScene/
// ensureTruckAnalysisScene. Unlike Truck Analysis' shell, a master base IS
// a real pallet (not a container) — rendered the same way
// renderLayerEditorPreview renders its own pallet deck, just with the
// master base's own length/width standing in for a deckHeight the
// #util-masterpallet form never actually captures (this app's own
// pallet-object convention already falls back to a 10mm visual deck
// whenever deckHeight is 0/absent — see renderPallet — reused unchanged
// here rather than inventing a different fallback).
let mpScene, mpCamera, mpRenderer, mpControls, mpPalletGroup, mpBoxGroup;
function ensureMasterPalletScene(container) {
  mpRenderer?.dispose();
  mpControls?.dispose();
  mpScene = new THREE.Scene();
  mpScene.background = new THREE.Color(0xdcdcdc);
  mpCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  mpRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(mpRenderer.domElement);
  mpControls = new OrbitControls(mpCamera, mpRenderer.domElement);
  addZoomControls(container, mpCamera, mpControls);
  mpScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  mpScene.add(dirLight);
  mpPalletGroup = new THREE.Group();
  mpScene.add(mpPalletGroup);
  mpBoxGroup = new THREE.Group();
  mpScene.add(mpBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  mpRenderer.setSize(w, h);
  mpCamera.aspect = w / h;
  mpCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // Utility tab/panel closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, mpRenderer, mpCamera);
    mpControls.update();
    mpRenderer.render(mpScene, mpCamera);
  };
  loop();
}

function renderMasterPalletPreview(best, masterBase) {
  const container = $("mp-preview");
  if (!container.isConnected) return;
  if (!mpRenderer || mpRenderer.domElement.parentNode !== container) {
    ensureMasterPalletScene(container);
  }
  mpPalletGroup.clear();
  mpBoxGroup.clear();
  $("mp-preview-placeholder").style.display = best ? "none" : "block";
  if (!best) return;

  const deckHeight = 10; // visual-only — #util-masterpallet's own form has no deckHeight field, see this function's own doc comment
  const palletGeo = new THREE.BoxGeometry(masterBase.length, deckHeight, masterBase.width);
  const palletMesh = new THREE.Mesh(palletGeo, new THREE.MeshStandardMaterial({ color: palletColor }));
  palletMesh.position.set(masterBase.length / 2, deckHeight / 2, masterBase.width / 2);
  mpPalletGroup.add(palletMesh);

  const CHECKER_COLOR = 0xc0328c; // same magenta accent convention as the main pallet view's own renderBoxes
  // Same coincident face-vs-edges z-fighting fix as renderBoxes' own
  // POLYGON_OFFSET.
  const mat = new THREE.MeshStandardMaterial({ color: boxColor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const matChecker = new THREE.MeshStandardMaterial({ color: CHECKER_COLOR, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321 });
  for (const b of buildBoxLayout(best, { ...masterBase, deckHeight }, { alternateLayers })) {
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mesh = new THREE.Mesh(geo, b.checker ? matChecker : mat);
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2);
    mesh.position.copy(center);
    mpBoxGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    mpBoxGroup.add(edges);
  }

  const loadHeight = deckHeight + best.loadHeight;
  const center = new THREE.Vector3(masterBase.length / 2, loadHeight / 2, masterBase.width / 2);
  const radius = 0.5 * Math.sqrt(masterBase.length ** 2 + masterBase.width ** 2 + loadHeight ** 2);
  fitCameraToSphere(mpCamera, mpControls, center, radius, CAMERA_DIRECTION);
}

$("mp-calc").addEventListener("click", () => {
  if (!currentContext) return;
  const palletLoad = currentPalletLoad();
  const masterBase = {
    length: num("mp-length"),
    width: num("mp-width"),
    maxHeight: num("mp-maxheight"),
    maxWeight: num("mp-maxweight"),
  };

  const [best] = packPalletsOntoMasterBase(palletLoad, masterBase, { objective: settings.objective, topN: 1 });
  const unitsPer = unitsPerPallet();

  $("mp-results").style.display = "block";
  $("mp-results").innerHTML = best
    ? `
      <div class="line"><span>Strategy</span><span>${patternLabel(best.strategy)}</span></div>
      <div class="line"><span>Pallets/layer × layers</span><span>${best.perLayer} × ${best.layers}</span></div>
      <div class="line"><span>Pallets / master base</span><span>${best.totalCount}</span></div>
      <div class="line"><span>Total primary units</span><span>${best.totalCount * unitsPer}</span></div>
      <div class="line"><span>Total weight</span><span>${fmtWeight(best.totalWeight)}</span></div>
    `
    : `<div class="line"><span colspan="2">No feasible fit - the pallet load doesn't fit on this master base.</span></div>`;

  renderMasterPalletPreview(best, masterBase);
});

$("open-master-library").addEventListener("click", () => {
  openLibrary(
    "pallets",
    "Select Master Base",
    (item) => {
      $("mp-length").value = item.length;
      $("mp-width").value = item.width;
      $("mp-maxweight").value = item.maxWeight;
      markSelected("sel-master", item.name, {
        itemId: item.id,
        icon: item.icon,
        onClear: () => {
          $("mp-length").value = 2400;
          $("mp-width").value = 1200;
          $("mp-maxweight").value = 5000;
        },
      });
    },
    "sel-master"
  );
});

// --- Report: Truck Analysis (docs section 8.2) -------------------------------
// No new math: the current pallet load becomes the "box," the truck/container
// becomes the "pallet" — same Level 1/2 search one level up.

// Real CapePack "Truck Analysis" own live 3D preview (user-supplied
// screenshot: a yellow container shell with the pallet loads packed
// inside). Same lazy-build-once/cheap-rebuild-per-change split as
// ensureFillWizardScene/ensureLayerEditorPreviewScene. Reuses the engine's
// own buildBoxLayout on `best` (a real optimizePallet-shaped solution —
// packPalletsIntoTruck is just optimizePallet one level up, see its own
// doc comment) rather than reimplementing layout — the pallet LOADS are
// the boxes here, the truck/container is the "pallet."
let taScene, taCamera, taRenderer, taControls, taTruckGroup, taBoxGroup;
function ensureTruckAnalysisScene(container) {
  taRenderer?.dispose();
  taControls?.dispose();
  taScene = new THREE.Scene();
  taScene.background = new THREE.Color(0xdcdcdc);
  taCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  taRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(taRenderer.domElement);
  taControls = new OrbitControls(taCamera, taRenderer.domElement);
  addZoomControls(container, taCamera, taControls);
  taScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  taScene.add(dirLight);
  taTruckGroup = new THREE.Group();
  taScene.add(taTruckGroup);
  taBoxGroup = new THREE.Group();
  taScene.add(taBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  taRenderer.setSize(w, h);
  taCamera.aspect = w / h;
  taCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // Utility tab/panel closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, taRenderer, taCamera);
    taControls.update();
    taRenderer.render(taScene, taCamera);
  };
  loop();
}

// Truck/container shell rendered as a translucent yellow box + edges —
// echoes the real screenshot's own solid-yellow-walls look without
// modeling individual open/closed faces (floor vs. side walls vs. open
// front/top) — a disclosed simplification, no evidence for exactly which
// faces real CapePack itself omits.
function renderTruckAnalysisPreview(best, truck) {
  const container = $("tr-preview");
  if (!container.isConnected) return;
  if (!taRenderer || taRenderer.domElement.parentNode !== container) {
    ensureTruckAnalysisScene(container);
  }
  taTruckGroup.clear();
  taBoxGroup.clear();
  $("tr-preview-placeholder").style.display = best ? "none" : "block";
  if (!best) return;

  // Real CapePack shows the container shell at its own PHYSICAL Height,
  // separate from the (possibly lower) Maximum Load Height limit that
  // actually caps stacking — falls back to maxHeight if height is ever
  // omitted, so this stays safe even if called without it.
  const shellHeight = truck.height ?? truck.maxHeight;
  const shellGeo = new THREE.BoxGeometry(truck.length, shellHeight, truck.width);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xf5d020, transparent: true, opacity: 0.15, depthWrite: false });
  const shellMesh = new THREE.Mesh(shellGeo, shellMat);
  shellMesh.position.set(truck.length / 2, shellHeight / 2, truck.width / 2);
  taTruckGroup.add(shellMesh);
  const shellEdges = new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), new THREE.LineBasicMaterial({ color: 0xb8960a }));
  shellEdges.position.copy(shellMesh.position);
  taTruckGroup.add(shellEdges);

  const CHECKER_COLOR = 0xc0328c; // same magenta accent convention as the main pallet view's own renderBoxes
  // Same coincident face-vs-edges z-fighting fix as renderBoxes' own
  // POLYGON_OFFSET.
  const mat = new THREE.MeshStandardMaterial({ color: boxColor, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const matChecker = new THREE.MeshStandardMaterial({ color: CHECKER_COLOR, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x5c4321 });
  const partialGapFront = truckPartialGapSide() === "front";
  const rawBoxes = truckBoxLayout(best, truck, { alternateLayers, partialGapFront });
  const boxes = applyLoadingDirection(rawBoxes, truck, truckLoadingDirection());
  for (const b of boxes) {
    const geo = new THREE.BoxGeometry(b.l, b.h, b.w);
    const mesh = new THREE.Mesh(geo, b.checker ? matChecker : mat);
    const center = toScene(b.x + b.l / 2, b.y + b.w / 2, b.z + b.h / 2);
    mesh.position.copy(center);
    taBoxGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgesMat);
    edges.position.copy(center);
    taBoxGroup.add(edges);
  }

  const center = new THREE.Vector3(truck.length / 2, shellHeight / 2, truck.width / 2);
  const radius = 0.5 * Math.sqrt(truck.length ** 2 + truck.width ** 2 + shellHeight ** 2);
  fitCameraToSphere(taCamera, taControls, center, radius, CAMERA_DIRECTION);
}

// Real CapePack Truck Analysis (user-supplied screenshot) rebuild — see
// #util-truck's own doc comment (index.html) for the full feature list.
// Multiple solutions (up to 40, navigable) + a real "Select Loading
// Patterns" checklist replace the old single-best/topN:1 call; this
// engine already searches every strategy unconditionally on every call
// (see optimize.js), so pattern selection is a client-side filter over a
// wide topN fetch, not a new engine option.
let truckSolutions = [];
let truckSolutionIndex = 0;
let truckObj = null;

const TRUCK_PATTERN_CHECKS = [
  ["tr-pattern-column", ["column"]],
  ["tr-pattern-diagonal", ["diagonal"]],
  ["tr-pattern-interlock", ["interlock"]],
  ["tr-pattern-spiral", ["spiral"]],
  ["tr-pattern-trilock", ["trilock"]],
  ["tr-pattern-expandedspiral", ["expanded-spiral"]],
  ["tr-pattern-guillotine", ["guillotine-split-length", "guillotine-split-width"]],
  ["tr-pattern-pinwheel", ["pinwheel"]],
];

function truckPartialGapSide() {
  return [...document.getElementsByName("tr-partialgap")].find((el) => el.checked)?.value ?? "back";
}
function truckLoadingDirection() {
  return [...document.getElementsByName("tr-direction")].find((el) => el.checked)?.value ?? "center";
}

$("tr-allowpartial").addEventListener("change", () => {
  $("tr-partialgap-wrap").style.display = $("tr-allowpartial").checked ? "block" : "none";
});
// Partial Top Layer Gap/Product Loading Direction are pure render-time
// choices (no effect on which solutions exist or their own stats — see
// truckBoxLayout/applyLoadingDirection's own doc comments), so re-render
// the current solution's preview immediately on change rather than
// waiting for the next row click/Calculate, which would otherwise leave
// the on-screen preview stale relative to the radio the user just picked.
for (const name of ["tr-partialgap", "tr-direction"]) {
  for (const el of document.getElementsByName(name)) {
    el.addEventListener("change", () => {
      if (truckSolutions.length) renderTruckAnalysisPreview(truckSolutions[truckSolutionIndex], truckObj);
    });
  }
}

// Real CapePack "Partial Top Layer Gap" (Back/Front) — buildBoxLayout's
// own partial-top-layer handling (shared with every other workflow, where
// this Back/Front concept doesn't exist) always takes the pattern's FIRST
// N positions for the partial layer. "Front" here swaps in the LAST N
// instead, giving a real, visually distinct alternative without changing
// that shared function's own default behavior for anyone else.
function truckBoxLayout(solution, truck, { alternateLayers, partialGapFront }) {
  const boxes = buildBoxLayout(solution, truck, { alternateLayers });
  if (!partialGapFront || solution.partialTopLayerCount <= 0) return boxes;
  const deckHeight = truck.deckHeight ?? 0;
  const topZ = deckHeight + solution.layers * solution.boxFootprint.h;
  const kept = boxes.filter((b) => b.z !== topZ);
  const reversed = solution.layerPositions.slice(-solution.partialTopLayerCount);
  for (const pos of reversed) {
    kept.push({
      x: pos.x,
      y: pos.y,
      z: topZ,
      l: pos.l,
      w: pos.w,
      h: solution.boxFootprint.h,
      rotated: !!pos.rotated,
      checker: ((pos.checker ?? 0) + solution.layers) % 2,
    });
  }
  return kept;
}

// Real CapePack "Product Loading Direction" (Center/Back) — Center splits
// the truck's own leftover length evenly on both ends; Back (this app's
// existing default, boxes already start at x=0) leaves the load flush to
// one consistent end. No real screenshot confirms which physical end
// "Back" refers to in CapePack's own coordinate convention — disclosed
// rather than guessed at further than "a real, consistent offset."
function applyLoadingDirection(boxes, truck, direction) {
  if (!boxes.length || direction !== "center") return boxes;
  const loadLength = Math.max(...boxes.map((b) => b.x + b.l));
  const offsetX = Math.max(truck.length - loadLength, 0) / 2;
  if (offsetX === 0) return boxes;
  return boxes.map((b) => ({ ...b, x: b.x + offsetX }));
}

function renderTruckSolutionNav() {
  const has = truckSolutions.length > 0;
  $("tr-solution-nav").style.display = has ? "flex" : "none";
  if (has) $("tr-solution-label").textContent = `Showing Solution ${truckSolutionIndex + 1} of ${truckSolutions.length}`;
}

function selectTruckSolution(i) {
  if (!truckSolutions.length) return;
  truckSolutionIndex = Math.max(0, Math.min(i, truckSolutions.length - 1));
  $("tr-solutions-body").querySelectorAll("tr").forEach((r, idx) => r.classList.toggle("selected", idx === truckSolutionIndex));
  renderTruckSolutionNav();
  renderTruckAnalysisPreview(truckSolutions[truckSolutionIndex], truckObj);
}
$("tr-prev").addEventListener("click", () => selectTruckSolution(truckSolutionIndex - 1));
$("tr-next").addEventListener("click", () => selectTruckSolution(truckSolutionIndex + 1));

// Real CapePack solution table columns exactly (Sol. No./Pattern Type/
// # Per Load/# Per Layer/# of Layers/SP Per Pallet/SP Per Truck/Dim.
// Vertical/Cube Eff./Area Eff./Length Under/Width Under/Product Length/
// Width/Height/Weight) — user-supplied screenshot, 40-row export. "SP"
// (Secondary Pack, i.e. the case) counts are the CURRENT pallet solution's
// own totalCount (spPerPallet, constant across every truck row) times
// however many pallets fit per truck row; "Length/Width Under" is the
// truck's own unused slack on each axis (truck dim minus the achieved
// load footprint), same real field CapePack's own screenshot shows.
function renderTruckSolutionsTable(spPerPallet, palletLoad) {
  const body = $("tr-solutions-body");
  body.innerHTML = "";
  truckSolutions.forEach((s, i) => {
    const loadLength = Math.max(...s.layerPositions.map((p) => p.x + p.l));
    const loadWidth = Math.max(...s.layerPositions.map((p) => p.y + p.w));
    const lengthUnder = Math.max(truckObj.length - loadLength, 0);
    const widthUnder = Math.max(truckObj.width - loadWidth, 0);
    const layersLabel = s.partialTopLayerCount > 0 ? `${s.layers} + ${s.partialTopLayerCount} partial` : `${s.layers}`;
    const tr = document.createElement("tr");
    tr.className = "solution-row" + (i === truckSolutionIndex ? " selected" : "");
    tr.innerHTML = `
      <td style="padding:4px 8px">${i + 1}</td>
      <td style="padding:4px 8px">${patternLabel(s.strategy)}</td>
      <td style="padding:4px 8px;text-align:right">${s.totalCount}</td>
      <td style="padding:4px 8px;text-align:right">${s.perLayer}</td>
      <td style="padding:4px 8px;text-align:right">${layersLabel}</td>
      <td style="padding:4px 8px;text-align:right">${spPerPallet}</td>
      <td style="padding:4px 8px;text-align:right">${spPerPallet * s.totalCount}</td>
      <td style="padding:4px 8px">${s.vertical.charAt(0).toUpperCase()}${s.vertical.slice(1)}</td>
      <td style="padding:4px 8px;text-align:right">${(s.cubeEfficiency * 100).toFixed(1)}</td>
      <td style="padding:4px 8px;text-align:right">${(s.areaEfficiency * 100).toFixed(1)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtLength(lengthUnder)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtLength(widthUnder)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtLength(palletLoad.length)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtLength(palletLoad.width)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtLength(palletLoad.height)}</td>
      <td style="padding:4px 8px;text-align:right">${fmtWeight(palletLoad.weight)}</td>`;
    tr.addEventListener("click", () => selectTruckSolution(i));
    body.appendChild(tr);
  });
  $("tr-solutions-wrap").style.display = truckSolutions.length ? "block" : "none";
}

// Real CapePack shows "Pallet Load Gross Weight"/"Pallet Load Height" as
// soon as a pallet solution exists (before Calculate is even clicked) —
// refreshed here and also whenever the Truck Analysis tab is opened (see
// showUtilityTab).
function refreshTruckPalletLoadInfo() {
  if (!currentContext) return;
  const palletLoad = currentPalletLoad(); // handles multiSizeResult internally — see its own doc comment
  $("tr-palletgrossweight").textContent = fmtWeight(palletLoad.weight);
  $("tr-palletheight").textContent = fmtLength(palletLoad.height);
}

$("tr-calc").addEventListener("click", () => {
  if (!currentContext) return;
  const palletLoad = currentPalletLoad();
  const truck = {
    length: num("tr-length"),
    width: num("tr-width"),
    maxHeight: num("tr-maxheight"), // Maximum Load Height (may be less than the physical Height below)
    maxWeight: num("tr-maxweight"), // Maximum Load Weight (this app's own payload-capacity field, see the trucks library schema's own comment)
    height: num("tr-height"), // physical container Height — Pack Preview's own shell size, not the packing calc's own limit
    tareWeight: num("tr-tareweight"), // informational only — not counted against Maximum Load Weight, same convention as a pallet's own weight
  };
  truckObj = truck;
  refreshTruckPalletLoadInfo();

  const allowPartialTopLayer = $("tr-allowpartial").checked;
  const allowedStrategies = new Set(TRUCK_PATTERN_CHECKS.filter(([id]) => $(id).checked).flatMap(([, strategies]) => strategies));

  // topN wide enough that filtering down to only the checked patterns
  // afterward still leaves up to 40 rows (real CapePack's own cap) when
  // multiple patterns are selected — cheap: patterns are independent,
  // computing extra ones costs nothing beyond a slightly bigger initial
  // array.
  const allSolutions = packPalletsIntoTruck(palletLoad, truck, { objective: settings.objective, topN: 200, allowPartialTopLayer });
  truckSolutions = allSolutions.filter((s) => allowedStrategies.has(s.strategy)).slice(0, 40);
  truckSolutionIndex = 0;

  // effectiveLoad() reads currentContext.solution directly, which doesn't
  // exist for Load Multi-Sized Products (no single shared per-pallet case
  // count there, same reasoning Format Load's own multi-size gate already
  // uses) — multiSizeResult.totalCount is its own real equivalent.
  const spPerPallet = currentContext.multiSizeResult ? currentContext.multiSizeResult.totalCount : effectiveLoad().totalCount;
  renderTruckSolutionsTable(spPerPallet, palletLoad);
  renderTruckSolutionNav();
  $("tr-nofit").style.display = truckSolutions.length ? "none" : "block";

  renderTruckAnalysisPreview(truckSolutions[0] ?? null, truck);
});

// --- Report: Compression Strength (McKee) ------------------------------------
function strengthInputs() {
  const { workflow, solution, caseInfo, fillInfo, resizeInfo } = currentContext;
  // KDF bundles go straight onto the pallet just like Build a Pallet's box —
  // same solution shape (boxFootprint set directly), so they share this branch.
  if (workflow === "pallet" || workflow === "kdf") {
    return {
      l: solution.boxFootprint.l,
      w: solution.boxFootprint.w,
      weightPerUnitKg: solution.totalWeight / solution.totalCount,
      layers: solution.layers,
    };
  }
  if (workflow === "resize") {
    return {
      l: resizeInfo.caseResult.caseDimensions.length,
      w: resizeInfo.caseResult.caseDimensions.width,
      weightPerUnitKg: resizeInfo.caseResult.caseDimensions.weight,
      layers: solution.layers,
    };
  }
  // fillInfo presence (not the workflow string) decides the shape, since
  // Pack Folded Cartons reuses both "case" and "fillcase" contexts under
  // its own workflow label.
  if (fillInfo) {
    return {
      l: solution.boxFootprint.l,
      w: solution.boxFootprint.w,
      weightPerUnitKg: fillInfo.caseWeight,
      layers: solution.layers,
    };
  }
  return {
    l: caseInfo.caseDimensions.length,
    w: caseInfo.caseDimensions.width,
    weightPerUnitKg: caseInfo.caseDimensions.weight,
    layers: solution.layers,
  };
}

// Real CapePack "Compression Strength" own report summary (user-supplied
// screenshot: "Weight on Bottom Layer" / "Weight on Bottom Case" fields,
// paired with a Strength Database results table) — reverse-engineered
// exactly from that screenshot's own real numbers (Cases per Layer=10,
// Layers per Load=7, Case Weight=1.5kg, Pallet Weight=130kg [=105kg
// product + 25kg pallet tare, matching this app's own currentPalletLoad()
// convention], Environmental Factors' Pallets Stacked=2): Weight on Bottom
// Layer = (layers-1)*perLayer*caseWeight + (palletsStacked-1)*one full
// pallet load's own total weight = 6*10*1.5 + 1*130 = 220.0kg exactly;
// Weight on Bottom Case = that ÷ perLayer = 22.0kg exactly — the whole
// layer's load (including any extra whole stacked pallet load) spreads
// evenly across the bottom layer's own cases via the pallet deck, not
// just straight down one column. This REPLACES the app's own earlier
// weightAbove formula (weightPerUnit*(layers-1), no perLayer multiplier
// at all) — that older formula was never checked against a real export
// and is now known wrong: the real screenshot's own downstream Safety
// Factors (Base Strength ÷ 22.0 — matches all 4 real rows exactly, e.g.
// 665.25/22=30.24) and Safety Margin % ((Life Cycle Strength ÷ 22.0 - 1)
// × 100 — matches all 4 real rows exactly, e.g. (153.01/22-1)*100=595.5)
// both depend on this corrected divisor, not the old one.
function weightOnBottomCase({ weightPerUnit, perLayer, layers, palletsStacked, totalPalletWeight, internalSupport }) {
  const weightOnBottomLayer = Math.max(
    0,
    (layers - 1) * perLayer * weightPerUnit + Math.max(0, palletsStacked - 1) * totalPalletWeight - internalSupport
  );
  return { weightOnBottomLayer, weightOnBottomCase: weightOnBottomLayer / perLayer };
}

// --- Report: Strength Database (real CapePack "Compression Strength" own
// batch results table, user-supplied screenshot: Single/Double/Triple Wall
// tabs, Flutes filter, Sort By, a checkbox+row table across every board
// grade in the selected wall category) ---------------------------------
// Reuses the SAME Strength Factor Chain fields already on this page
// (#r-casetype.../#r-seasonal below) rather than duplicating them — the
// real screen's own "Environmental Factors" column and this results table
// share one set of inputs, not two.
let sdbWall = "single";
let sdbBoards = [];

// "23-23-23" etc. — liner1/medium1/liner2[/medium2/liner3[/medium3/liner4]]
// joined by wall depth, confirmed against the real board-grades library's
// own demo entries (e.g. sw-r01: liner1/medium1/liner2 = "23"/"23"/"23",
// matching the real screenshot's own "23-23-23" column exactly). Entries
// without these fields (the plainer ectRc/caliperIn-only demo rows) show
// "—" rather than fabricate a combination.
function materialCombination(item, wall) {
  if (!item.liner1) return "-";
  const parts =
    wall === "single"
      ? [item.liner1, item.medium1, item.liner2]
      : wall === "double"
        ? [item.liner1, item.medium1, item.liner2, item.medium2, item.liner3]
        : [item.liner1, item.medium1, item.liner2, item.medium2, item.liner3, item.medium3, item.liner4];
  const joined = parts.filter((p) => p !== undefined && p !== null && p !== "").join("-");
  return joined || "-";
}

async function fetchBoardGrades(wall) {
  let items;
  try {
    const res = await fetch(`${API_BASE}/api/library/board-grades`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    items = (await res.json()).items;
  } catch {
    items = await fetch(`../library/board-grades.json`).then((r) => r.json());
  }
  return items.filter((i) => i.wall === wall && i.includeInList !== false);
}

function populateSdbFlutes(items) {
  const select = $("sdb-flutes");
  const current = select.value;
  const flutes = [...new Set(items.map((i) => i.flute).filter(Boolean))].sort();
  select.innerHTML = `<option value="">All</option>` + flutes.map((f) => `<option value="${f}">${f}</option>`).join("");
  if (flutes.includes(current)) select.value = current;
}

async function switchSdbWall(wall) {
  sdbWall = wall;
  for (const w of ["single", "double", "triple"]) $(`sdb-tab-${w}`).classList.toggle("active", w === wall);
  $("sdb-results").style.display = "none";
  $("sdb-empty").style.display = "none";
  sdbBoards = await fetchBoardGrades(wall);
  populateSdbFlutes(sdbBoards);
}
for (const wall of ["single", "double", "triple"]) {
  $(`sdb-tab-${wall}`).addEventListener("click", () => switchSdbWall(wall));
}
switchSdbWall(sdbWall); // seed the default Single Wall tab's own Flutes list on load

$("sdb-select-all").addEventListener("change", () => {
  const checked = $("sdb-select-all").checked;
  $("sdb-tbody")
    .querySelectorAll('input[type="checkbox"]')
    .forEach((cb) => {
      cb.checked = checked;
      cb.closest("tr").style.display = checked ? "" : "none";
    });
});

$("sdb-calc").addEventListener("click", async () => {
  if (!currentContext) return;
  const { l, w, weightPerUnitKg, layers } = strengthInputs();
  const isMetric = settings.units === "metric";
  const perimeterInStrengthUnits = isMetric ? (2 * (l + w)) / 10 : (2 * (l + w)) / 25.4;
  const weightInStrengthUnits = isMetric ? weightPerUnitKg : weightPerUnitKg * 2.20462;
  const palletsStacked = num("r-palletsstacked");
  const internalSupport = num("r-internalsupport");
  const totalPalletWeightInStrengthUnits = weightInStrengthUnits * currentContext.solution.totalCount;
  const bottomCase = weightOnBottomCase({
    weightPerUnit: weightInStrengthUnits,
    perLayer: currentContext.solution.perLayer,
    layers,
    palletsStacked,
    totalPalletWeight: totalPalletWeightInStrengthUnits,
    internalSupport,
  });

  const flute = $("sdb-flutes").value;
  if (!sdbBoards.length) sdbBoards = await fetchBoardGrades(sdbWall);
  const items = sdbBoards.filter((i) => i.ectRc != null && i.caliperIn != null).filter((i) => !flute || i.flute === flute);

  if (!items.length) {
    $("sdb-results").style.display = "none";
    $("sdb-empty").style.display = "block";
    return;
  }
  $("sdb-empty").style.display = "none";

  const chainFactors = {
    caseTypeFactor: num("r-casetype"),
    printingFactor: num("r-printing"),
    partitionFactor: num("r-partition"),
    caseProportionFactor: num("r-caseproportion"),
    flutingOrientationFactor: num("r-fluting"),
    productionFactorPct: num("r-production"),
    lifeCycleDegradationPct: num("r-lifecycle"),
    seasonalDegradationPct: num("r-seasonal"),
  };

  const rows = items.map((item) => {
    const ectDisplay = ectLbInToDisplay(item.ectRc);
    const calDisplay = caliperMilsToDisplay(item.caliperIn * 1000);
    const base = isMetric
      ? mckeeBaseStrengthMetric({ ectKnM: ectDisplay, caliperMm: calDisplay, perimeterCm: perimeterInStrengthUnits })
      : mckeeBaseStrengthImperial({ ectLbIn: ectDisplay, caliperMils: calDisplay, perimeterIn: perimeterInStrengthUnits });
    const chain = applyStrengthFactorChain(base, chainFactors);
    // Safety Factors = Base Strength ÷ Weight on Bottom Case, Safety Margin
    // (%) = (Life Cycle Strength ÷ Weight on Bottom Case - 1) × 100 — both
    // verified exactly against the real screenshot's own 4 rows (see
    // weightOnBottomCase's own doc comment). "Loads High" reuses this
    // app's own pre-existing loadsHigh() (floor(strength/weight)) against
    // the same corrected divisor for internal consistency, but — unlike
    // Safety Factors/Margin above — its exact real-screenshot value
    // (e.g. "12.08", not a whole number, so evidently not this same
    // floor-based formula) was NOT independently reverse-engineered; a
    // real, disclosed gap rather than a forced fit.
    const high = loadsHigh(chain.lifeCycleStrength, bottomCase.weightOnBottomCase);
    const safetyFactor = bottomCase.weightOnBottomCase > 0 ? chain.baseStrength / bottomCase.weightOnBottomCase : null;
    const marginPct = bottomCase.weightOnBottomCase > 0 ? safetyMargin(chain.lifeCycleStrength, bottomCase.weightOnBottomCase) : null;
    return { item, chain, high, safetyFactor, marginPct };
  });

  const sortKey = $("sdb-sort").value;
  rows.sort((a, b) => a.chain[sortKey] - b.chain[sortKey]);

  $("sdb-tbody").innerHTML = rows
    .map(
      (r, i) => `
      <tr data-idx="${i}">
        <td style="padding:4px"><input type="checkbox" checked style="width:auto;margin:0" /></td>
        <td style="padding:4px">${r.item.name}</td>
        <td style="padding:4px">${r.item.burstTestLb ?? "-"}</td>
        <td style="padding:4px">${materialCombination(r.item, sdbWall)}</td>
        <td style="padding:4px">${r.item.flute ?? "-"}</td>
        <td style="padding:4px">${r.chain.baseStrength.toFixed(2)}</td>
        <td style="padding:4px">${r.chain.productionStrength.toFixed(2)}</td>
        <td style="padding:4px">${r.chain.lifeCycleStrength.toFixed(2)}</td>
        <td style="padding:4px">${r.high}</td>
        <td style="padding:4px">${r.safetyFactor === null ? "-" : r.safetyFactor.toFixed(2)}</td>
        <td style="padding:4px">${r.marginPct === null ? "-" : r.marginPct.toFixed(2)}</td>
        <td style="padding:4px">${r.chain.seasonalStrength.toFixed(2)}</td>
      </tr>`
    )
    .join("");
  $("sdb-tbody")
    .querySelectorAll('input[type="checkbox"]')
    .forEach((cb) =>
      cb.addEventListener("change", () => {
        cb.closest("tr").style.display = cb.checked ? "" : "none";
      })
    );
  $("sdb-select-all").checked = true;
  $("sdb-results").style.display = "block";
});

// --- Case Configuration Database (docs "Strength" tab) ----------------------
$("open-casetype-library").addEventListener("click", () => {
  openLibrary(
    "case-configurations",
    "Select Case Type",
    (item) => {
      $("r-casetype").value = item.caseTypeFactor;
      markSelected("sel-casetype", `${item.name} (${item.caseTypeFactor}×)`, {
        itemId: item.id,
        onClear: () => {
          $("r-casetype").value = 1;
        },
      });
    },
    "sel-casetype"
  );
});

// The other 4 real Case Configuration sub-databases (Printing/Partition/
// Case Proportion/Fluting Orientation) all share the exact same {name,
// factor} shape and "pick one, copy its factor into a plain × field"
// behavior as Case Type above — one small helper instead of repeating
// that wiring 4 times. Case Proportion stays a manual pick like Case
// Type/Storage Environment's own enum factors, not auto-derived from the
// case's own L/H/W — see applyStrengthFactorChain's own comment for why.
function wireFactorLibraryPicker(buttonId, type, title, inputId, selId) {
  $(buttonId).addEventListener("click", () => {
    openLibrary(
      type,
      title,
      (item) => {
        $(inputId).value = item.factor;
        markSelected(selId, `${item.name} (${item.factor}×)`, {
          itemId: item.id,
          onClear: () => {
            $(inputId).value = 1;
          },
        });
      },
      selId
    );
  });
}
wireFactorLibraryPicker("open-printing-library", "printing-factors", "Select Printing", "r-printing", "sel-printing");
wireFactorLibraryPicker("open-partition-library", "partition-factors", "Select Partition", "r-partition", "sel-partition");
wireFactorLibraryPicker(
  "open-caseproportion-library",
  "case-proportion-factors",
  "Select Case Proportion",
  "r-caseproportion",
  "sel-caseproportion"
);
wireFactorLibraryPicker(
  "open-fluting-library",
  "fluting-orientation-factors",
  "Select Fluting Orientation",
  "r-fluting",
  "sel-fluting"
);

// --- Material Factors Database: compute Edge Crush from liner/medium/flute --
// CapePack's own Formulae screen (Strength tab > Database > Formulae). Single
// Wall only (1 medium + 2 liners) — Double/Double Wall math exists in the
// engine (stfiDoubleWall/stfiTripleWall) but isn't wired to a picker here yet.
$("mf-toggle").addEventListener("click", () => toggleOptionalSection("mf-toggle", "mf-panel"));

let mfLiner1 = null;
let mfLiner2 = null;
let mfMedium = null;
let mfFlute = null;

$("open-liner1-library").addEventListener("click", () => {
  openLibrary(
    "liner-materials",
    "Select Liner 1",
    (item) => {
      mfLiner1 = item;
      markSelected("sel-liner1", `${item.name} (RC ${item.ringCrush}, STFI ${item.stfi})`, {
        itemId: item.id,
        onClear: () => {
          mfLiner1 = null;
        },
      });
    },
    "sel-liner1"
  );
});
$("open-liner2-library").addEventListener("click", () => {
  openLibrary(
    "liner-materials",
    "Select Liner 2",
    (item) => {
      mfLiner2 = item;
      markSelected("sel-liner2", `${item.name} (RC ${item.ringCrush}, STFI ${item.stfi})`, {
        itemId: item.id,
        onClear: () => {
          mfLiner2 = null;
        },
      });
    },
    "sel-liner2"
  );
});
$("open-medium-library").addEventListener("click", () => {
  openLibrary(
    "medium-materials",
    "Select Medium",
    (item) => {
      mfMedium = item;
      markSelected("sel-medium", `${item.name} (RC ${item.ringCrush}, STFI ${item.stfi})`, {
        itemId: item.id,
        onClear: () => {
          mfMedium = null;
        },
      });
    },
    "sel-medium"
  );
});
$("open-flute-library").addEventListener("click", () => {
  openLibrary(
    "flute-takeup-factors",
    "Select Flute",
    (item) => {
      mfFlute = item;
      markSelected("sel-flute", `${item.name} (takeup ${item.takeupFactor})`, {
        itemId: item.id,
        onClear: () => {
          mfFlute = null;
        },
      });
    },
    "sel-flute"
  );
});

$("mf-compute").addEventListener("click", () => {
  if (!mfLiner1 || !mfLiner2 || !mfMedium || !mfFlute) {
    $("mf-status").textContent = "Select both liners, a medium, and a flute first.";
    return;
  }
  const burstTestLb = num("mf-bursttest");
  const formula = $("mf-formula").value;
  let ect;
  if (formula === "stfi") {
    ect = stfiSingleWall({
      medium: { stfi: mfMedium.stfi, takeupFactor: mfFlute.takeupFactor },
      liners: [{ stfi: mfLiner1.stfi }, { stfi: mfLiner2.stfi }],
    });
  } else {
    // Efficiency Factor: now a real editable database (see
    // lookupEfficiencyFactor) instead of a hardcoded 0.13/0.21 ternary.
    const efficiencyFactor = lookupEfficiencyFactor(burstTestLb);
    ect = combinedEdgeCrushRingCrush({
      liners: [{ rc: mfLiner1.ringCrush }, { rc: mfLiner2.ringCrush }],
      mediums: [{ rc: mfMedium.ringCrush, takeupFactor: mfFlute.takeupFactor }],
      burstTestLb,
      efficiencyFactor,
    });
  }
  // Material Factors Database values (and this formula's output) are
  // inherently imperial-sourced — convert to the current display units the
  // same way the board-grade library picker does.
  const ectDisplay = roundTo(ectLbInToDisplay(ect), 4);
  const caliperMils = mfFlute.caliperIn * 1000;
  $("r-ect").value = ectDisplay;
  $("r-cal").value = roundTo(caliperMilsToDisplay(caliperMils), 4);
  $("mf-status").textContent = `✓ Computed ECT ${ectDisplay} (${formula === "stfi" ? "STFI" : "Ring Crush"} formula) - filled into ECT/Caliper above.`;
});

// --- Storage Environment Database (docs "Strength" tab) ---------------------
// Real CapePack behavior (docs 11.6.2): the six factor groups below are
// stored in an editable database (Databases > Strength > Storage
// Environment), not hardcoded — so this app's own storage-environment-
// factors library type is the live source of truth for both the six
// dropdowns below and the Apply calculation, falling back to the compiled-
// in defaults (storageEnvironmentFactor's own STORAGE_ENVIRONMENT_DEFAULTS)
// only when the API/database is unavailable, matching every other picker's
// offline-degradation pattern.
$("se-toggle").addEventListener("click", () => toggleOptionalSection("se-toggle", "se-panel"));

let storageEnvironmentItems = null; // raw API rows, grouped by .category as needed; null when unavailable (falls back to hardcoded HTML options + the engine's own compiled-in defaults)

const SEF_GROUP_SELECT = {
  "Storage Environment: Humidity": "se-humidity",
  "Storage Environment: Days of Storage": "se-days",
  "Storage Environment: Case Orientation": "se-orientation",
  "Storage Environment: Stacking": "se-stacking",
  "Storage Environment: Pallet Overhang": "se-overhang",
  "Storage Environment: Pallet Surface": "se-surface",
};
const SEF_BRACKET_CATEGORIES = new Set([
  "Storage Environment: Humidity",
  "Storage Environment: Days of Storage",
  "Storage Environment: Pallet Overhang",
]);
const SEF_ENGINE_GROUP = {
  "Storage Environment: Humidity": "humidityPct",
  "Storage Environment: Days of Storage": "daysStored",
  "Storage Environment: Case Orientation": "caseOrientation",
  "Storage Environment: Stacking": "stacking",
  "Storage Environment: Pallet Overhang": "palletOverhangPct",
  "Storage Environment: Pallet Surface": "palletSurface",
};

async function loadStorageEnvironmentFactors() {
  try {
    const res = await fetch(`${API_BASE}/api/library/storage-environment-factors`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    storageEnvironmentItems = (await res.json()).items;
  } catch {
    storageEnvironmentItems = null;
  }
  populateStorageEnvironmentSelects();
}

function populateStorageEnvironmentSelects() {
  if (!storageEnvironmentItems) return; // keep the hardcoded HTML <option>s as the offline fallback
  for (const category of STORAGE_ENV_FACTOR_CATEGORIES) {
    // Humidity/Days/Overhang are raw-number inputs now, not <select>s (the
    // engine's own bracketFactor already resolves any raw value against
    // whatever brackets buildStorageEnvironmentTable below builds from this
    // same database) — nothing to sync options into for those three.
    if (SEF_BRACKET_CATEGORIES.has(category)) continue;
    const items = storageEnvironmentItems.filter((i) => i.category === category);
    if (!items.length) continue; // nothing saved for this group yet — keep the hardcoded fallback options rather than emptying the select
    const el = $(SEF_GROUP_SELECT[category]);
    const prevValue = el.value;
    el.innerHTML = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.matchValue;
      opt.textContent = item.name;
      el.appendChild(opt);
    }
    if ([...el.options].some((o) => o.value === prevValue)) el.value = prevValue;
  }
}

// Rebuilds storageEnvironmentFactor's own bracket-array/enum-map table shape
// from the live database rows. Returns undefined (letting the engine fall
// back to its compiled-in STORAGE_ENVIRONMENT_DEFAULTS) whenever the
// database is unavailable or any group is empty — a partially-custom table
// would silently misinterpret whichever groups it's missing.
function buildStorageEnvironmentTable() {
  if (!storageEnvironmentItems) return undefined;
  const table = {};
  for (const category of STORAGE_ENV_FACTOR_CATEGORIES) {
    const items = storageEnvironmentItems.filter((i) => i.category === category);
    if (!items.length) return undefined;
    const group = SEF_ENGINE_GROUP[category];
    if (SEF_BRACKET_CATEGORIES.has(category)) {
      table[group] = items.map((i) => ({ max: Number(i.matchValue), factor: i.factor })).sort((a, b) => a.max - b.max);
    } else {
      table[group] = {};
      for (const i of items) table[group][i.matchValue] = i.factor;
    }
  }
  return table;
}

function computeAndApplyStorageEnvironment() {
  const factor = storageEnvironmentFactor(
    {
      humidityPct: num("se-humidity"),
      daysStored: num("se-days"),
      caseOrientation: $("se-orientation").value,
      stacking: $("se-stacking").value,
      palletOverhangPct: num("se-overhang"),
      palletSurface: $("se-surface").value,
    },
    buildStorageEnvironmentTable()
  );
  const degradationPct = Math.round((1 - factor) * 1000) / 10;
  $("r-lifecycle").value = degradationPct;
  $("se-status").textContent = `✓ Combined factor ${factor.toFixed(3)} → Life cycle set to −${degradationPct}%.`;
}
$("se-apply").addEventListener("click", computeAndApplyStorageEnvironment);

// --- Efficiency Factors Database (Material Factors' 4th real sub-database) --
// Was a hardcoded `burstTestLb <= 200 ? 0.13 : 0.21` ternary inline in
// mf-compute below — the exact right real values (Esko's own Master
// Strength Database default), just not editable like Liner/Medium/Takeup
// Factors are. Same bracket-lookup shape as storageEnvironmentFactor's own
// humidity/days/overhang groups, so this mirrors that pattern rather than
// inventing a new one: cache the live rows, fall back to the compiled-in
// 0.13/0.21 default when the database is unavailable or empty.
let efficiencyFactorItems = null;
async function loadEfficiencyFactors() {
  try {
    const res = await fetch(`${API_BASE}/api/library/efficiency-factors`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    efficiencyFactorItems = (await res.json()).items;
  } catch {
    efficiencyFactorItems = null;
  }
}
function lookupEfficiencyFactor(burstTestLb) {
  if (!efficiencyFactorItems?.length) return burstTestLb <= 200 ? 0.13 : 0.21;
  const brackets = efficiencyFactorItems
    .map((i) => ({ max: Number(i.maxBurstTestLb), factor: i.factor }))
    .sort((a, b) => a.max - b.max);
  const hit = brackets.find((b) => burstTestLb <= b.max);
  return (hit ?? brackets[brackets.length - 1]).factor;
}

$("r-calc").addEventListener("click", () => {
  if (!currentContext) return;
  const { l, w, weightPerUnitKg, layers } = strengthInputs();
  const isMetric = settings.units === "metric";

  // Real CapePack's own McKee formula has two genuinely distinct forms (see
  // compression.js) — ECT/Caliper/Perimeter/output are all in different
  // units between them, not just relabeled. ectLbInToDisplay's own note
  // explains why this ties to Report Units instead of CapePack's separate
  // Strength-only unit selector.
  const perimeterInStrengthUnits = isMetric ? (2 * (l + w)) / 10 : (2 * (l + w)) / 25.4;
  const units = isMetric ? "metric" : "imperial";
  const useCustomFormula =
    $("r-use-custom-formula").checked && settings.customFormula && settings.customFormula.units === units;
  const base = useCustomFormula
    ? evaluateCustomFormula(settings.customFormula, {
        edgeCrushValue: num("r-ect"),
        caliperValue: num("r-cal"),
        casePerimeter: perimeterInStrengthUnits,
      })
    : isMetric
      ? mckeeBaseStrengthMetric({
          ectKnM: num("r-ect"),
          caliperMm: num("r-cal"),
          perimeterCm: perimeterInStrengthUnits,
        })
      : mckeeBaseStrengthImperial({
          ectLbIn: num("r-ect"),
          caliperMils: num("r-cal"),
          perimeterIn: perimeterInStrengthUnits,
        });
  const weightInStrengthUnits = isMetric ? weightPerUnitKg : weightPerUnitKg * 2.20462;
  const unitLabel = isMetric ? "kg" : "lb";

  const chain = applyStrengthFactorChain(base, {
    caseTypeFactor: num("r-casetype"),
    printingFactor: num("r-printing"),
    partitionFactor: num("r-partition"),
    caseProportionFactor: num("r-caseproportion"),
    flutingOrientationFactor: num("r-fluting"),
    productionFactorPct: num("r-production"),
    lifeCycleDegradationPct: num("r-lifecycle"),
    seasonalDegradationPct: num("r-seasonal"),
  });

  // Per docs section 7.2: Loads High and Safety Margin are determined using
  // Life Cycle Strength, not the raw Base Strength.
  const palletsStacked = num("r-palletsstacked");
  // r-internalsupport already displays in the same unit as unitLabel (see
  // applyStrengthDefaults' weightLbToDisplay call) — no further conversion.
  const internalSupport = num("r-internalsupport");
  const totalPalletWeightInStrengthUnits = weightInStrengthUnits * currentContext.solution.totalCount;
  const bottomCase = weightOnBottomCase({
    weightPerUnit: weightInStrengthUnits,
    perLayer: currentContext.solution.perLayer,
    layers,
    palletsStacked,
    totalPalletWeight: totalPalletWeightInStrengthUnits,
    internalSupport,
  });
  const high = loadsHigh(chain.lifeCycleStrength, bottomCase.weightOnBottomCase);
  const marginPct = bottomCase.weightOnBottomCase > 0 ? safetyMargin(chain.lifeCycleStrength, bottomCase.weightOnBottomCase) : null;
  const marginText = marginPct === null ? "- (nothing stacked above)" : `${marginPct.toFixed(0)}%`;

  // Real screen's "Safety Margin Required %" toggle+threshold — a minimum
  // required value for the safety margin line directly above, not a new
  // formula of its own.
  const marginRequired = $("r-safetymargin-enabled").checked ? num("r-safetymargin-pct") : null;
  const marginCheckHtml =
    marginRequired === null
      ? ""
      : marginPct === null
        ? `<div class="line"><span>Safety margin required (≥${marginRequired}%)</span><span>- (nothing stacked above to check)</span></div>`
        : `<div class="line"><span>Safety margin required (≥${marginRequired}%)</span><span>${marginPct >= marginRequired ? "✓ Pass" : "✗ Fail"}</span></div>`;

  $("r-results").style.display = "block";
  $("r-results").innerHTML = `
    <div class="line"><span>Base strength (${useCustomFormula ? "Custom Formula" : "McKee"})</span><span>${chain.baseStrength.toFixed(1)} ${unitLabel}</span></div>
    <div class="line"><span>Production strength</span><span>${chain.productionStrength.toFixed(1)} ${unitLabel}</span></div>
    <div class="line"><span>Life cycle strength</span><span>${chain.lifeCycleStrength.toFixed(1)} ${unitLabel}</span></div>
    <div class="line"><span>Seasonal strength</span><span>${chain.seasonalStrength.toFixed(1)} ${unitLabel}</span></div>
    <div class="line"><span>Loads high (vs. life cycle)</span><span>${high}</span></div>
    <div class="line"><span>Weight on bottom layer</span><span>${bottomCase.weightOnBottomLayer.toFixed(1)} ${unitLabel} (${layers - 1} unit layer(s)${palletsStacked > 1 ? ` + ${palletsStacked - 1} pallet(s) stacked above` : ""})</span></div>
    <div class="line"><span>Weight on bottom case</span><span>${bottomCase.weightOnBottomCase.toFixed(1)} ${unitLabel} (÷ ${currentContext.solution.perLayer} cases/layer)</span></div>
    <div class="line"><span>Safety margin (vs. life cycle)</span><span>${marginText}</span></div>
    ${marginCheckHtml}
  `;
});

// --- Report: PDF export (native browser print-to-PDF) -----------------------
// No PDF library dependency: build a print-only view and let the browser's
// own "Save as PDF" in the print dialog produce the file. Robust, always
// available, and keeps the engine/UI dependency-free.
const WORKFLOW_LABELS = {
  pallet: "Build a Pallet",
  case: "Create a Case",
  fillcase: "Fill a Stock Case",
  resize: "Resize a Primary Pack",
  foldedcarton: "Pack Folded Cartons",
  kdf: "Palletize Knocked-Down Flat",
  multisize: "Load Multi-Sized Products",
};

// Populates the Saved Analyses "Workflow" filter (see analysesWorkflowFilter
// above) now that WORKFLOW_LABELS exists — runs once at load, same as every
// other static <select> population in this file.
for (const [value, label] of Object.entries(WORKFLOW_LABELS)) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  $("analyses-workflow-filter").appendChild(opt);
}

// mm^3 -> cm^3 for small volumes, m^3 for large ones — matches a real Cape
// Pack Cloud report's own convention (Case OD shown in cm^3, Product/Load
// in m^3), picked by magnitude rather than hardcoded per row so this stays
// correct regardless of which row it's applied to.
function fmtVolume(mm3) {
  if (mm3 < 1_000_000_000) return `${Math.round(mm3 / 1000).toLocaleString()} cm^3`;
  return `${(mm3 / 1_000_000_000).toFixed(2)} m^3`;
}

// The currently-picked Pallet library item's own display name (e.g.
// "UKSTD / UK Standard 1200x1000x150"), read from the same #sel-pallet DOM
// state markSelected()/pickPallet() already maintain — no separate tracked
// variable needed. null when no library pallet was picked (manual entry),
// matching the report's own "omit the row rather than fabricate a name"
// requirement.
function palletTypeName() {
  const el = $("sel-pallet");
  if (!el || el.style.display === "none") return null;
  const span = el.querySelector(".lib-selected-content span");
  if (!span) return null;
  return span.textContent.replace(/^✓ Selected:\s*/, "").trim() || null;
}

// The "Case (OD)" row's own dimensions for whichever workflow produced the
// current solution — reuses getCaseDetailInfo's own already-correct
// branching (case/fillcase/resize/pallet+fillWizard) rather than
// re-deriving it; falls back to the primary pack's own dims for plain
// Build a Pallet (no separate case, the primary pack IS the placed unit —
// matching the real report example itself, "Build a Pallet - Cases/Trays").
function reportCaseOd(ctx) {
  return getCaseDetailInfo(ctx)?.od ?? ctx.primary ?? null;
}

// Flat, unfilled top-down floor plan — one <rect> per box position plus
// pallet length/width labels, matching a real Cape Pack Cloud report's own
// 2D pattern diagram (outlined cells, no 3D, no color fill). Pure SVG from
// data already in hand (solution.layerPositions), no new rendering
// infrastructure.
function buildTopDownFloorPlanSvg(solution, pallet) {
  const pl = pallet.trueLength ?? pallet.length;
  const pw = pallet.trueWidth ?? pallet.width;
  const pad = Math.max(pl, pw) * 0.08;
  const vbW = pl + pad * 2;
  const vbH = pw + pad * 2;
  const rects = solution.layerPositions
    .map((p) => `<rect x="${p.x + pad}" y="${p.y + pad}" width="${p.l}" height="${p.w}" fill="#fff" stroke="#444" stroke-width="${Math.max(pl, pw) * 0.003}" />`)
    .join("");
  const fontSize = Math.max(pl, pw) * 0.035;
  return `<svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${pad}" y="${pad}" width="${pl}" height="${pw}" fill="none" stroke="#999" stroke-width="${Math.max(pl, pw) * 0.004}" />
    ${rects}
    <text x="${pad + pl / 2}" y="${pad * 0.6}" font-size="${fontSize}" text-anchor="middle" fill="#555">${Math.round(pl)}</text>
    <text x="${pad * 0.5}" y="${pad + pw / 2}" font-size="${fontSize}" text-anchor="middle" fill="#555" transform="rotate(-90 ${pad * 0.5} ${pad + pw / 2})">${Math.round(pw)}</text>
  </svg>`;
}

// User report, a real Cape Pack Cloud PDF export: "our reports are not
// like this. look at 3d views here" — the real report's own Pallet
// Load/Single Layer images show Length/Width/Height dimension callouts
// directly on the box; ours didn't. Root cause: the dimension LINES
// (makeDimensionLine) are real WebGL THREE.Line geometry, so
// renderer.domElement.toDataURL() already captured those fine — but the
// dimension TEXT LABELS (makeDimensionLabel) are CSS2DObjects, a
// separate absolutely-positioned HTML overlay on top of the canvas, not
// part of its pixel buffer at all. toDataURL() on the raw canvas simply
// never saw them.
//
// Fix: draw the WebGL canvas onto a fresh 2D canvas, then re-draw each
// currently-visible .dimension-label element's own pill+text on top at
// its real on-screen position (read via getBoundingClientRect(), scaled
// from CSS pixels to the canvas's own pixel-buffer size — robust to any
// devicePixelRatio rather than assuming 1:1). Matches the live label's
// own CSS (.dimension-label, index.html) closely enough to read as the
// same element, not pixel-identical (Canvas 2D text metrics don't match
// browser text layout exactly, which is fine for a report image).
function snapshotWithLabels(canvasEl, cssContainerEl) {
  const wrapRect = cssContainerEl.getBoundingClientRect();
  const scaleX = canvasEl.width / wrapRect.width;
  const scaleY = canvasEl.height / wrapRect.height;

  const out = document.createElement("canvas");
  out.width = canvasEl.width;
  out.height = canvasEl.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(canvasEl, 0, 0);

  const fontPx = 11 * scaleY;
  ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const label of cssContainerEl.querySelectorAll(".dimension-label")) {
    const r = label.getBoundingClientRect();
    const cx = (r.left + r.width / 2 - wrapRect.left) * scaleX;
    const cy = (r.top + r.height / 2 - wrapRect.top) * scaleY;
    const text = label.textContent;
    const padX = 6 * scaleX;
    const w = ctx.measureText(text).width + padX * 2;
    const h = fontPx * 1.5;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.strokeStyle = "#dfe3e8";
    ctx.lineWidth = Math.max(scaleX, 1);
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1c2128";
    ctx.fillText(text, cx, cy);
  }
  return out.toDataURL("image/png");
}

// Waits for one real, composited animation frame — not just a synchronous
// renderer.render() call. User report: "make sure the 3d views are always
// visible and at the center." Re-centering the camera right before a report
// snapshot (see the export-pdf handler below) sometimes produced a blank
// capture specifically right after the user had just been dragging/
// rotating the live OrbitControls view — reproduced live: renderer.render()
// followed immediately by a synchronous canvas readback (toDataURL/
// drawImage) can race the GPU's own compositing of that render, especially
// right after a burst of drag-driven frames, even with
// preserveDrawingBuffer:true. A single rAF tick (which is also when the
// animate() loop's own render() call runs) is enough to let that settle —
// confirmed live: the exact same capture that came back blank immediately
// came back correct moments later with no other change.
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Renders solution truncated to exactly 1 layer via the SAME renderer/draw()
// pipeline the live interactive view uses, snapshots it, then restores the
// real full solution — reuses 100% of existing rendering code, no new
// Three.js scene. Must be called with the SAME pallet/renderInfo the live
// view is currently showing, or the "restore" step would show the wrong
// thing.
async function snapshotSingleLayer(solution, pallet, renderInfo) {
  // renderer.render() only actually happens inside the animate() loop's own
  // requestAnimationFrame callback — draw() just mutates the scene graph,
  // it doesn't render synchronously. Without an explicit render() call
  // here, toDataURL() would capture whatever the canvas last drew on a
  // PREVIOUS frame (i.e. the full solution, not this truncated one) —
  // caught live: the single-layer and full-pallet snapshots came back
  // byte-identical before this fix.
  const singleLayer = { ...solution, layers: 1, partialTopLayerCount: 0, loadHeight: (pallet.deckHeight ?? 0) + solution.boxFootprint.h };
  draw(singleLayer, pallet, renderInfo);
  renderer.render(scene, camera);
  cssRenderer.render(scene, camera); // same staleness risk as the WebGL render above — the label DOM positions need to match THIS frame before snapshotWithLabels reads them
  await nextFrame(); // see nextFrame's own comment — guards the readback below against the same race
  const snapshot = snapshotWithLabels(renderer.domElement, cssRenderer.domElement);
  draw(solution, pallet, renderInfo); // restore the real, full solution
  renderer.render(scene, camera);
  cssRenderer.render(scene, camera);
  return snapshot;
}

// window.print() must wait for #print-report's own <img src="data:..."> tags
// to actually finish decoding first — setting .innerHTML and calling
// window.print() on the very next line (the original code) is a real race:
// the DOM update is synchronous but image decode is NOT, so the print
// engine can capture the page before a freshly-inserted data: URL image has
// anything paintable yet. User report: "3ds in the pdf are still empty" —
// reproduced live: the images' own data was confirmed valid (real,
// non-trivial byte length, correct naturalWidth/Height once given time to
// settle), and the inline SVG floor plan (synchronous, no decode step)
// rendered fine right beside them — only the two <img> snapshots were
// blank, pointing straight at a decode-timing race rather than a data
// problem. img.decode() resolves once an image is actually ready to paint;
// .catch(() => {}) so one truly broken image (not expected here) doesn't
// block printing the rest of the report.
async function waitForPrintReportImages() {
  const imgs = [...$("print-report").querySelectorAll("img")];
  await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
}
$("export-pdf").addEventListener("click", async () => {
  if (!currentContext) return;
  const ctx = currentContext;
  const { solution, pallet } = ctx;

  // Load Multi-Sized Products has no single `solution` object at all (each
  // zone has its own footprint/stack height — see multiSizeResult), so the
  // dimensions table/diagram-grid logic below (which all assumes a normal
  // optimizePallet-shaped solution) doesn't apply. Falls back to a simpler
  // banner + meta + snapshot + summaryHtml report instead of crashing.
  if (!solution) {
    // User report: "make sure the 3d views are always visible and at the
    // center." redraw() re-frames the camera to its own canonical centered
    // position as a side effect (frameCamera, inside drawMultiSize) —
    // re-running it right before the snapshot guarantees this image is
    // centered even if the user rotated/zoomed the live view via
    // OrbitControls since the last real redraw. nextFrame() guards the
    // readback below against a real, reproduced race (see its own comment).
    resize();
    redraw();
    renderer.render(scene, camera);
    await nextFrame();
    const snapshot = renderer.domElement.toDataURL("image/png");
    const meta = {
      product: $("meta-product").value || "(untitled)",
      code: $("meta-code").value,
    };
    $("print-report").innerHTML = `
      <div class="pr-banner">
        <img src="assets/logo-header.jpeg" alt="SimPallet" />
        <div class="pr-banner-text">
          <h1>${meta.product}</h1>
          <p>${WORKFLOW_LABELS[ctx.workflow] ?? ctx.workflow}</p>
        </div>
      </div>
      <div class="pr-date">${new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</div>
      ${meta.code ? `<div class="meta">Code: ${meta.code}</div>` : ""}
      <h2>Solution</h2>
      ${summaryHtml()}
      ${co2CostEstimateHtml(grossLoadWeightKg(ctx))}
      <h2>3D Preview</h2>
      <img src="${snapshot}" alt="Load preview" />
      <div class="pr-footer">Generated by SimPallet · ${new Date().toLocaleString()}</div>
    `;
    await waitForPrintReportImages();
    window.print();
    return;
  }

  const deckHeight = pallet.deckHeight ?? 0;

  // User report: "make sure the 3d views are always visible and at the
  // center." Re-running redraw()/showCaseDetail() here re-frames each
  // camera to its own canonical centered position (frameCamera /
  // fitCameraToSphere, called as a side effect of both) — without this, a
  // snapshot just captures whatever the live view's OrbitControls were
  // last rotated/zoomed/panned to, which is very often off-center or
  // partially out of frame. resize() first as cheap insurance against a
  // stale camera.aspect. nextFrame() (see its own comment above
  // snapshotSingleLayer) guards each readback against a real, reproduced
  // race: capturing immediately after render() came back blank specifically
  // right after the user had just been dragging the view, self-corrected a
  // moment later with no other change — a GPU-compositing timing issue,
  // not a logic bug in the redraw itself.
  resize();
  redraw();
  renderer.render(scene, camera);
  cssRenderer.render(scene, camera);
  await nextFrame();
  const fullPalletSnapshot = snapshotWithLabels(renderer.domElement, cssRenderer.domElement);
  const floorPlanSvg = solution.layerPositions ? buildTopDownFloorPlanSvg(solution, pallet) : "";
  const singleLayerSnapshot = solution.layerPositions ? await snapshotSingleLayer(solution, pallet, buildRenderInfo(ctx)) : "";
  const caseDetail = getCaseDetailInfo(ctx);
  let caseSnapshot = "";
  let innerPackSnapshot = "";
  if (caseDetail) {
    resizeCaseDetail();
    // showCaseDetail renders whichever of "case"/"innerpack" caseDetailView
    // currently is — previously this snapshotted ONLY that one, so
    // whichever tab the user wasn't looking at when they exported silently
    // never made it into the PDF at all. User report: "inner case does not
    // exist in the pdf if that exists." Fixed by forcing both views in
    // turn when Inner Pack exists, then restoring whichever one the user
    // actually had open on screen.
    const originalCaseDetailView = caseDetailView;
    caseDetailView = "case";
    showCaseDetail(ctx); // re-frames caseDetailCamera to center — same reasoning as draw() above
    caseDetailRenderer.render(caseDetailScene, caseDetailCamera);
    caseDetailCssRenderer.render(caseDetailScene, caseDetailCamera);
    await nextFrame();
    caseSnapshot = snapshotWithLabels(caseDetailRenderer.domElement, caseDetailCssRenderer.domElement);
    if (ctx.caseInfo?.innerPack) {
      caseDetailView = "innerpack";
      showCaseDetail(ctx);
      caseDetailRenderer.render(caseDetailScene, caseDetailCamera);
      caseDetailCssRenderer.render(caseDetailScene, caseDetailCamera);
      await nextFrame();
      innerPackSnapshot = snapshotWithLabels(caseDetailRenderer.domElement, caseDetailCssRenderer.domElement);
    }
    caseDetailView = originalCaseDetailView;
    showCaseDetail(ctx); // restore the on-screen view exactly as the user left it
  }

  const strengthHtml = $("r-results").style.display === "block" ? $("r-results").innerHTML : "";
  // Strength Database's own batch table (#sdb-results, a real CapePack-
  // matching addition this session — see ARCHITECTURE.md) lived alongside
  // the older single-board calculator above but was never wired into the
  // PDF at all until this fix; captures the whole #sdb-results div (not
  // just its <tbody>) so the real <table>/<thead> headers come along too.
  const strengthDbHtml = $("sdb-results").style.display === "block" ? $("sdb-results").outerHTML : "";
  // Truck Analysis's own real solutions table (#tr-solutions-wrap) replaced
  // the old plain-text #tr-results block entirely — captures the whole
  // table (heading + all rows currently shown, up to the real 40-row cap),
  // same "outerHTML so the real headers come along too" reasoning as
  // strengthDbHtml below.
  const truckHtml = $("tr-solutions-wrap").style.display === "block" ? $("tr-solutions-wrap").outerHTML : "";
  // Master Pallet Base (#mp-results) had the identical gap — a real
  // Utility tab with real results, never once included in the PDF.
  const masterPalletHtml = $("mp-results").style.display === "block" ? $("mp-results").innerHTML : "";
  // User report: "in the reports, i don't see the truck or any utility
  // related 3Ds" — truckHtml/masterPalletHtml above only ever captured
  // the TEXT stats (#tr-results/#mp-results), never the live 3D preview
  // sitting right next to them on screen (#tr-preview/#mp-preview, their
  // own taRenderer/mpRenderer canvases) — a real, disclosed gap, not a
  // sizing bug like the one just above. Both renderers are created lazily
  // (only once that Utility tab's own Calculate button has been clicked
  // at least once), so guarded the same way truckHtml/masterPalletHtml
  // already are — display:block on the results div is the closest signal
  // to "there's a real solution currently shown." No CSS2DRenderer/
  // dimension-label overlay exists for either scene (unlike the main
  // pallet/case-detail views), so a plain toDataURL() capture is enough —
  // snapshotWithLabels would have nothing of its own to bake in here.
  let truckSnapshot = "";
  if (truckHtml && taRenderer) {
    taRenderer.render(taScene, taCamera);
    truckSnapshot = taRenderer.domElement.toDataURL("image/png");
  }
  let masterPalletSnapshot = "";
  if (masterPalletHtml && mpRenderer) {
    mpRenderer.render(mpScene, mpCamera);
    masterPalletSnapshot = mpRenderer.domElement.toDataURL("image/png");
  }
  const meta = {
    product: $("meta-product").value || "(untitled)",
    code: $("meta-code").value,
    customer: $("meta-customer").value,
    project: $("meta-project").value,
  };

  // Dimensions table — Case (OD) / Product / Load / Overhang rows, each
  // value already verified against a real Cape Pack Cloud report's own
  // numbers (see docs/ARCHITECTURE.md): Product net/gross weight =
  // totalCount x case net/gross weight; Load net weight = Product's own
  // gross weight; Load gross weight = Load net + pallet weight (already
  // what "Gross weight (load + pallet)" computes elsewhere in this file).
  // effectiveLoad() folds in Layer Editor's own edited layer count when a
  // session is active (see its own doc comment) — Product/Load's own
  // height/weight/count below previously read solution.* directly, so an
  // edited layer count (deleted/added/reordered) never showed up in the
  // exported PDF even though Manage Layers' own on-screen totals had
  // already changed.
  const eff = effectiveLoad();
  const caseOd = reportCaseOd(ctx);
  const caseNetWeight = $("p-netweight").value ? num("p-netweight") : null;
  const caseGrossWeight = solution.totalCount > 0 ? solution.totalWeight / solution.totalCount : null;
  // Inner Pack (this app's own feature — optimizeCaseWithInnerPack.js) had
  // no row anywhere in the exported PDF at all — user report: "inner case
  // does not exist in the pdf if that exists." Real, confirmed gap: the
  // on-screen Case Detail view already shows it (showCaseDetail's own
  // "Case"/"Inner Pack" tabs), but nothing about it made it into the
  // report. Net/Gross weight are the case's own (caseNetWeight/
  // caseGrossWeight above) divided evenly across however many inner packs
  // make up one case — this app's own feature with no CapePack reference
  // to match, so a self-consistent derivation (same "divide the container
  // above evenly among what's inside it" logic every other row already
  // uses) rather than a fabricated formula.
  const innerPack = ctx.caseInfo?.innerPack;
  const innerPacksPerCase = innerPack ? ctx.caseInfo.primaryGrid.nx * ctx.caseInfo.primaryGrid.ny * ctx.caseInfo.primaryGrid.nz : 0;
  const innerNetWeight = innerPack && caseNetWeight != null && innerPacksPerCase > 0 ? caseNetWeight / innerPacksPerCase : null;
  const innerGrossWeight = innerPack && caseGrossWeight != null && innerPacksPerCase > 0 ? caseGrossWeight / innerPacksPerCase : null;
  const productLength = solution.layerPositions ? Math.max(...solution.layerPositions.map((p) => p.x + p.l)) : null;
  const productWidth = solution.layerPositions ? Math.max(...solution.layerPositions.map((p) => p.y + p.w)) : null;
  const productHeight = eff.loadHeight - deckHeight;
  const productNetWeight = caseNetWeight != null ? eff.totalCount * caseNetWeight : null;
  const productGrossWeight = eff.totalWeight;
  // "Load" = the fully-dressed unit ready to ship — Product PLUS whatever
  // Format Load Additions are currently on (formatLoadAdjustment, same
  // field Truck Analysis/Master Pallet Base's own currentPalletLoad()
  // already reads) — distinct from "Product" above, which is deliberately
  // just the packed units themselves. Previously this read solution.own
  // loadHeight/totalWeight directly, silently ignoring Format Load
  // entirely — a real, disclosed bug: Insert Pallet Base/Top Board/Layer
  // Pads etc. could be switched on with a visibly different Impact table
  // on-screen, yet the exported PDF's own Load row still showed the
  // un-adjusted numbers.
  const loadLength = pallet.trueLength ?? pallet.length;
  const loadWidth = pallet.trueWidth ?? pallet.width;
  const loadHeight = formatLoadAdjustment?.loadHeight ?? eff.loadHeight;
  const loadNetWeight = formatLoadAdjustment?.totalWeight ?? productGrossWeight;
  const loadGrossWeight = loadNetWeight + (pallet.weight ?? 0);

  const dimRow = (label, l, w, h, net, gross, vol) => `
    <tr>
      <td>${label}</td>
      <td>${l != null ? fmtLength(l) : "-"}</td>
      <td>${w != null ? fmtLength(w) : "-"}</td>
      <td>${h != null ? fmtLength(h) : "-"}</td>
      <td>${net != null ? fmtWeight(net) : "-"}</td>
      <td>${gross != null ? fmtWeight(gross) : "-"}</td>
      <td>${l != null && w != null && h != null ? fmtVolume(l * w * h) : "-"}</td>
    </tr>`;

  const palletType = palletTypeName();
  const solutionNumber = ctx.solutionNumber ?? 1;
  // Case Content (Build a Pallet only — see readCaseContent's own doc
  // comment) was never surfaced in the exported PDF at all before this —
  // an earlier pass deliberately left it out ("no real CapePack reference
  // for what it should say there," docs/ARCHITECTURE.md, 2026-09-13). No
  // new reference has turned up since, so rather than invent a CapePack-
  // specific layout for it, this reuses the SAME real, already-verified
  // summary text the on-screen "✓ Selected: …" badge already shows
  // (caseContentSummaryText) — one line, same convention as Pallet Type
  // directly above it, not a fabricated new section.
  const caseContentText =
    ctx.caseContent && ctx.caseContent.mode !== "none" ? caseContentSummaryText(ctx.caseContent) : "";

  $("print-report").innerHTML = `
    <div class="pr-banner">
      <img src="assets/logo-header.jpeg" alt="SimPallet" />
      <div class="pr-banner-text">
        <h1>${meta.product}</h1>
        <p>${WORKFLOW_LABELS[ctx.workflow] ?? ctx.workflow}</p>
      </div>
    </div>
    <div class="pr-date">${new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</div>

    <div class="pr-meta-grid">
      <div>
        <div class="pr-meta-row"><span>Product Name</span><span>${meta.product}</span></div>
        ${meta.code ? `<div class="pr-meta-row"><span>Product Code</span><span>${meta.code}</span></div>` : ""}
        <div class="pr-meta-row"><span>Analysis Date</span><span>${new Date().toLocaleDateString()}</span></div>
        <div class="pr-meta-row"><span>Load Ref</span><span>${solutionNumber}</span></div>
        <div class="pr-meta-row"><span>Cube Used</span><span>${(solution.cubeEfficiency * 100).toFixed(1)}%</span></div>
        <div class="pr-meta-row"><span>Area Used</span><span>${(solution.areaEfficiency * 100).toFixed(1)}%</span></div>
        ${palletType ? `<div class="pr-meta-row"><span>Pallet Type</span><span>${palletType}</span></div>` : ""}
        ${caseContentText ? `<div class="pr-meta-row"><span>Case Content</span><span>${caseContentText}</span></div>` : ""}
      </div>
      <div>
        <div class="pr-meta-row"><span>Case / Layer</span><span>${solution.perLayer}</span></div>
        <div class="pr-meta-row"><span>Layer / Load</span><span>${eff.layers}</span></div>
        <div class="pr-meta-row"><span>Case / Load</span><span>${eff.totalCount}</span></div>
      </div>
    </div>

    <table class="pr-dims-table">
      <thead><tr><th></th><th>Length</th><th>Width</th><th>Height</th><th>Net Weight</th><th>Gross Weight</th><th>Volume</th></tr></thead>
      <tbody>
        ${caseOd ? dimRow("Case (OD)", caseOd.length, caseOd.width, caseOd.height, caseNetWeight, caseGrossWeight, null) : ""}
        ${innerPack ? dimRow("Inner Pack (OD)", innerPack.dimensions.length, innerPack.dimensions.width, innerPack.dimensions.height, innerNetWeight, innerGrossWeight, null) : ""}
        ${productLength != null ? dimRow("Product", productLength, productWidth, productHeight, productNetWeight, productGrossWeight, null) : ""}
        ${dimRow("Load", loadLength, loadWidth, loadHeight, loadNetWeight, loadGrossWeight, null)}
        <tr><td>Overhang</td><td>${fmtLength(num("pl-overhang-length"))}</td><td>${fmtLength(num("pl-overhang-width"))}</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>
      </tbody>
    </table>

    ${co2CostEstimateHtml(loadGrossWeight)}

    <div class="pr-diagram-grid">
      <div class="pr-diagram-cell"><img src="${fullPalletSnapshot}" alt="Full pallet load" /><div class="pr-diagram-caption">Pallet Load</div></div>
      ${floorPlanSvg ? `<div class="pr-diagram-cell">${floorPlanSvg}<div class="pr-diagram-caption">Layer Pattern</div></div>` : ""}
      ${singleLayerSnapshot ? `<div class="pr-diagram-cell"><img src="${singleLayerSnapshot}" alt="Single layer" /><div class="pr-diagram-caption">Single Layer</div></div>` : ""}
      ${caseSnapshot ? `<div class="pr-diagram-cell"><img src="${caseSnapshot}" alt="Case detail" /><div class="pr-diagram-caption">Case</div></div>` : ""}
      ${innerPackSnapshot ? `<div class="pr-diagram-cell"><img src="${innerPackSnapshot}" alt="Inner pack detail" /><div class="pr-diagram-caption">Inner Pack</div></div>` : ""}
    </div>

    <h2>Format Load</h2>
    <div class="line"><span>Alternate Layers</span><span>${alternateLayers ? "On" : "Off"}</span></div>
    ${FL_ITEMS.filter((it) => flItemsOn[it.key])
      .map((it) => `<div class="line"><span>${it.label}</span><span>On</span></div>`)
      .join("")}
    ${formatLoadAdjustment && (formatLoadAdjustment.addedHeight > 0 || formatLoadAdjustment.addedWeight > 0) ? `<div class="line"><span>Added height / weight</span><span>${fmtLength(formatLoadAdjustment.addedHeight)} / ${fmtWeight(formatLoadAdjustment.addedWeight)}</span></div>` : ""}
    ${formatLoadAdjustment && (formatLoadAdjustment.addedLength > 0 || formatLoadAdjustment.addedWidth > 0) ? `<div class="line"><span>Added length / width</span><span>${fmtLength(formatLoadAdjustment.addedLength)} / ${fmtLength(formatLoadAdjustment.addedWidth)}</span></div>` : ""}

    ${
      truckHtml
        ? `<h2>Truck Analysis</h2>
    ${truckSnapshot ? `<div class="pr-diagram-grid" style="grid-template-columns:1fr"><div class="pr-diagram-cell"><img src="${truckSnapshot}" alt="Truck load preview" /><div class="pr-diagram-caption">Truck Load</div></div></div>` : ""}
    ${truckHtml}`
        : ""
    }

    ${
      masterPalletHtml
        ? `<h2>Master Pallet Base</h2>
    ${masterPalletSnapshot ? `<div class="pr-diagram-grid" style="grid-template-columns:1fr"><div class="pr-diagram-cell"><img src="${masterPalletSnapshot}" alt="Master pallet base preview" /><div class="pr-diagram-caption">Master Pallet Base</div></div></div>` : ""}
    ${masterPalletHtml}`
        : ""
    }

    ${strengthHtml ? `<h2>Compression Strength (McKee)</h2>${strengthHtml}` : ""}

    ${strengthDbHtml ? `<h2>Strength Database</h2>${strengthDbHtml}` : ""}

    <div class="pr-footer">Generated by SimPallet · ${new Date().toLocaleString()}</div>
  `;

  await waitForPrintReportImages();
  window.print();
});

// --- Download 3D Model (user ask: "we should also be able to download
// the 3d model as either collada or .step. or even maybe other 3d formats
// if it is possible") — see the button's own comment in index.html for why
// this is GLTF/OBJ/STL, not Collada/STEP (no exporter for either exists in
// three.js). Lazily imports whichever exporter is actually picked, same
// "don't load it until it's used" discipline as occt-import-js/jszip
// elsewhere in this file. Exports the live `scene` as-is — every exporter
// here only ever picks up real geometry (meshes) from it regardless of
// what else (lights, the OrbitControls target, camera) is also present, so
// no separate "just the load" subgraph is needed.
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Hand-rolled minimal COLLADA (.dae) writer — three.js ships no Collada
// exporter (see the Download 3D Model comment above, index.html: only a
// STEP/Collada IMPORTER path exists in this app, via occt-import-js/
// ColladaLoader). Bakes every Mesh in the scene into world space and writes
// them as one combined <geometry>, the same "flatten the whole scene into
// one file" approach OBJExporter/STLExporter already take here for
// multi-mesh scenes (many box instances plus the pallet/truck).
//
// Units/orientation: this app's scene already uses raw mm as Three.js scene
// units (a 1200mm pallet is a BoxGeometry of width 1200 — see parseZaeCollada's
// own comment on this), and X=Length/Y=Height(up)/Z=Width. So the numbers
// written here are raw scene units with <unit meter="0.001"/> (1 unit = 1mm)
// and <up_axis>Y_UP</up_axis> — telling any real Collada reader to treat them
// as millimeters directly, no separate rescale needed on write.
//
// Verified (not just assumed) by round-tripping the emitted XML back through
// this app's own ColladaLoader (the same one parseZaeCollada already uses for
// .zae import) and confirming it parses with a non-zero vertex count and a
// bounding box matching the source scene's, scaled by the declared meter unit.
function exportSceneToCollada(scene) {
  const positions = [];
  const normals = [];
  const indices = [];
  let vertexOffset = 0;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  scene.updateMatrixWorld(true);
  scene.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) return;
    const normAttr = geometry.getAttribute("normal");
    normalMatrix.getNormalMatrix(child.matrixWorld);

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(child.matrixWorld);
      positions.push(v.x, v.y, v.z);
      if (normAttr) n.fromBufferAttribute(normAttr, i).applyMatrix3(normalMatrix).normalize();
      else n.set(0, 1, 0);
      normals.push(n.x, n.y, n.z);
    }

    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(vertexOffset + index.getX(i));
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(vertexOffset + i);
    }
    vertexOffset += posAttr.count;
  });

  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;
  const now = new Date().toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <created>${now}</created>
    <modified>${now}</modified>
    <unit name="millimeter" meter="0.001"/>
    <up_axis>Y_UP</up_axis>
  </asset>
  <library_geometries>
    <geometry id="load-geometry" name="load">
      <mesh>
        <source id="load-positions">
          <float_array id="load-positions-array" count="${positions.length}">${positions.join(" ")}</float_array>
          <technique_common>
            <accessor source="#load-positions-array" count="${vertexCount}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="load-normals">
          <float_array id="load-normals-array" count="${normals.length}">${normals.join(" ")}</float_array>
          <technique_common>
            <accessor source="#load-normals-array" count="${vertexCount}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="load-vertices">
          <input semantic="POSITION" source="#load-positions"/>
        </vertices>
        <triangles count="${triCount}">
          <input semantic="VERTEX" source="#load-vertices" offset="0"/>
          <input semantic="NORMAL" source="#load-normals" offset="0"/>
          <p>${indices.join(" ")}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="load-node" name="load">
        <instance_geometry url="#load-geometry"/>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>
`;
}

// Hand-rolled minimal STEP (AP214, "Faceted Brep" style) writer — three.js
// ships no STEP exporter either (see the Download 3D Model comment above,
// index.html), and unlike Collada, no simple "existing plain-XML mesh
// format" shortcut exists: STEP's normal geometry (B-rep with real NURBS
// surfaces) is far too complex to hand-write for arbitrary meshes. What IS
// tractable: STEP also allows a face's surface to be a plain PLANE bounded
// by straight EDGE_CURVEs — writing ONE such planar ADVANCED_FACE per
// source triangle (each face's own PLANE uses the triangle's own real
// geometric normal, computed fresh via cross product so the plane
// genuinely contains all 3 of its own points, not a smoothed/averaged
// vertex normal that could leave the "planar" surface not actually
// containing them) reduces the whole file to entities this project CAN
// verify are correct, the same discipline as everywhere else in this app
// that won't ship a formula it can't confirm.
//
// Verified correct before being wired to the real export button: a hand-
// written single-triangle STEP file using this exact entity structure
// (CARTESIAN_POINT/VERTEX_POINT/LINE/EDGE_CURVE/EDGE_LOOP/FACE_OUTER_BOUND/
// PLANE/ADVANCED_FACE/OPEN_SHELL/SHELL_BASED_SURFACE_MODEL, plus the
// standard AP214 PRODUCT/SHAPE_REPRESENTATION boilerplate every minimal
// STEP file needs) was round-tripped through this app's own occt-import-js
// reader (the same one parseStepFile already uses for STEP import) and
// came back with the exact 3 input vertices, unchanged — see
// docs/ARCHITECTURE.md's own dated entry for this feature.
//
// One shell per source Mesh (not one shell for the whole scene) — a
// SHELL_BASED_SURFACE_MODEL is a plain surface collection, not a solid, so
// it never claims a watertight/manifold guarantee this project can't
// verify for a scene made of many disjoint boxes; edges aren't shared
// between triangles either (a fresh EDGE_CURVE per triangle side) for the
// same reason — correctness over minimal file size.
function exportSceneToStep(scene) {
  const lines = [];
  let nextId = 1;
  const id = () => nextId++;
  // toFixed (never toPrecision) deliberately — toPrecision can fall back to
  // exponential notation (lowercase "e") for very small magnitudes (e.g. a
  // direction component that's really 0 but landed on 1e-16 from floating-
  // point noise), which isn't valid STEP real-literal syntax at all (the
  // EXPRESS grammar's real_literal only allows an uppercase "E" exponent,
  // and only if present) — toFixed always stays plain-decimal for every
  // magnitude this app's mm-scale coordinates actually produce.
  const num = (n) => {
    if (Number.isInteger(n)) return `${n}.`;
    const s = n.toFixed(6).replace(/0+$/, "");
    return s;
  };
  const point = (v) => {
    const pid = id();
    lines.push(`#${pid}=CARTESIAN_POINT('',(${num(v.x)},${num(v.y)},${num(v.z)}));`);
    return pid;
  };
  const direction = (v) => {
    const did = id();
    lines.push(`#${did}=DIRECTION('',(${num(v.x)},${num(v.y)},${num(v.z)}));`);
    return did;
  };
  const vertexPoint = (pid) => {
    const vid = id();
    lines.push(`#${vid}=VERTEX_POINT('',#${pid});`);
    return vid;
  };

  scene.updateMatrixWorld(true);
  const shellIds = [];
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const normalVec = new THREE.Vector3();

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) return;
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : posAttr.count / 3;
    const faceIds = [];

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      v0.fromBufferAttribute(posAttr, i0).applyMatrix4(child.matrixWorld);
      v1.fromBufferAttribute(posAttr, i1).applyMatrix4(child.matrixWorld);
      v2.fromBufferAttribute(posAttr, i2).applyMatrix4(child.matrixWorld);
      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      normalVec.crossVectors(e1, e2);
      if (normalVec.lengthSq() < 1e-12) continue; // degenerate triangle — no real plane, skip rather than emit an invalid face
      normalVec.normalize();
      const refDir = e1.clone().normalize();

      const p0 = point(v0);
      const p1 = point(v1);
      const p2 = point(v2);
      const vp0 = vertexPoint(p0);
      const vp1 = vertexPoint(p1);
      const vp2 = vertexPoint(p2);

      const edge = (startVp, startPt, endVec) => {
        const dirId = direction(endVec.clone().normalize());
        const vecId = id();
        lines.push(`#${vecId}=VECTOR('',#${dirId},${num(endVec.length())});`);
        const lineId = id();
        lines.push(`#${lineId}=LINE('',#${startPt},#${vecId});`);
        return lineId;
      };
      const d01 = new THREE.Vector3().subVectors(v1, v0);
      const d12 = new THREE.Vector3().subVectors(v2, v1);
      const d20 = new THREE.Vector3().subVectors(v0, v2);
      const l01 = edge(vp0, p0, d01);
      const l12 = edge(vp1, p1, d12);
      const l20 = edge(vp2, p2, d20);

      const ec01 = id();
      lines.push(`#${ec01}=EDGE_CURVE('',#${vp0},#${vp1},#${l01},.T.);`);
      const ec12 = id();
      lines.push(`#${ec12}=EDGE_CURVE('',#${vp1},#${vp2},#${l12},.T.);`);
      const ec20 = id();
      lines.push(`#${ec20}=EDGE_CURVE('',#${vp2},#${vp0},#${l20},.T.);`);

      const oe01 = id();
      lines.push(`#${oe01}=ORIENTED_EDGE('',*,*,#${ec01},.T.);`);
      const oe12 = id();
      lines.push(`#${oe12}=ORIENTED_EDGE('',*,*,#${ec12},.T.);`);
      const oe20 = id();
      lines.push(`#${oe20}=ORIENTED_EDGE('',*,*,#${ec20},.T.);`);

      const loopId = id();
      lines.push(`#${loopId}=EDGE_LOOP('',(#${oe01},#${oe12},#${oe20}));`);
      const boundId = id();
      lines.push(`#${boundId}=FACE_OUTER_BOUND('',#${loopId},.T.);`);

      const normalDirId = direction(normalVec);
      const refDirId = direction(refDir);
      const placementId = id();
      lines.push(`#${placementId}=AXIS2_PLACEMENT_3D('',#${p0},#${normalDirId},#${refDirId});`);
      const planeId = id();
      lines.push(`#${planeId}=PLANE('',#${placementId});`);
      const faceId = id();
      lines.push(`#${faceId}=ADVANCED_FACE('',(#${boundId}),#${planeId},.T.);`);
      faceIds.push(faceId);
    }

    if (faceIds.length) {
      const shellId = id();
      lines.push(`#${shellId}=OPEN_SHELL('',(${faceIds.map((f) => `#${f}`).join(",")}));`);
      shellIds.push(shellId);
    }
  });

  const sbsmId = id();
  lines.push(`#${sbsmId}=SHELL_BASED_SURFACE_MODEL('',(${shellIds.map((s) => `#${s}`).join(",")}));`);

  const appCtx = id();
  lines.push(`#${appCtx}=APPLICATION_CONTEXT('automotive design');`);
  const prodCtx = id();
  lines.push(`#${prodCtx}=PRODUCT_CONTEXT('',#${appCtx},'mechanical');`);
  const prod = id();
  lines.push(`#${prod}=PRODUCT('SimPalletLoad','SimPallet Load','',(#${prodCtx}));`);
  const pdCtx = id();
  lines.push(`#${pdCtx}=PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design');`);
  const pdf = id();
  lines.push(`#${pdf}=PRODUCT_DEFINITION_FORMATION('','',#${prod});`);
  const pd = id();
  lines.push(`#${pd}=PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx});`);
  const pds = id();
  lines.push(`#${pds}=PRODUCT_DEFINITION_SHAPE('','',#${pd});`);
  const lengthUnit = id();
  lines.push(`#${lengthUnit}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`);
  const angleUnit = id();
  lines.push(`#${angleUnit}=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`);
  const solidAngleUnit = id();
  lines.push(`#${solidAngleUnit}=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`);
  const uncertainty = id();
  lines.push(`#${uncertainty}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${lengthUnit},'distance_accuracy_value','confusion accuracy');`);
  const geomCtx = id();
  lines.push(
    `#${geomCtx}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit}))REPRESENTATION_CONTEXT('Context #1','3D'));`
  );
  const shapeRep = id();
  lines.push(`#${shapeRep}=SHAPE_REPRESENTATION('',(#${sbsmId}),#${geomCtx});`);
  const sdr = id();
  lines.push(`#${sdr}=SHAPE_DEFINITION_REPRESENTATION(#${pds},#${shapeRep});`);

  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('model.step','${new Date().toISOString()}',(''),(''),'','SimPallet','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
${lines.join("\n")}
ENDSEC;
END-ISO-10303-21;
`;
}

$("export-3d-model").addEventListener("click", async () => {
  if (!currentContext) return;
  const format = $("export-3d-format").value;
  const productName = ($("meta-product").value || "model").replace(/[^a-z0-9-_]+/gi, "_");
  $("export-3d-status").textContent = "Exporting…";
  try {
    if (format === "glb") {
      const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
      const exporter = new GLTFExporter();
      const result = await new Promise((resolve, reject) =>
        exporter.parse(scene, resolve, reject, { binary: true })
      );
      triggerDownload(new Blob([result], { type: "model/gltf-binary" }), `${productName}.glb`);
    } else if (format === "obj") {
      const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js");
      const text = new OBJExporter().parse(scene);
      triggerDownload(new Blob([text], { type: "text/plain" }), `${productName}.obj`);
    } else if (format === "dae") {
      const text = exportSceneToCollada(scene);
      triggerDownload(new Blob([text], { type: "model/vnd.collada+xml" }), `${productName}.dae`);
    } else if (format === "step") {
      const text = exportSceneToStep(scene);
      triggerDownload(new Blob([text], { type: "model/step" }), `${productName}.step`);
    } else {
      const { STLExporter } = await import("three/addons/exporters/STLExporter.js");
      const text = new STLExporter().parse(scene, { binary: false });
      triggerDownload(new Blob([text], { type: "model/stl" }), `${productName}.stl`);
    }
    $("export-3d-status").textContent = "Downloaded.";
  } catch (err) {
    $("export-3d-status").textContent = `Couldn't export: ${err.message}`;
  }
});

// --- Save Analysis (docs section 5: "Save Analysis/Solution") ---------------
// The API server is optional — the app works entirely offline without it.
// Only Save/My Analyses need it, and both fail gracefully (a status message,
// not a crash) when it isn't running.
const API_BASE = "http://localhost:5174";

// Mirrors the Calculate handler's own input-gathering exactly, in the shape
// the API's /api/compute/:workflow expects — so a saved analysis's `input`
// is replayable server-side later, not just a solution snapshot.
// --- Rerun / Open Input Data (docs section 9: "Open Input Data: Opens the
// solution on a new analysis page, allowing you to edit the data and rerun
// the analysis.") The exact inverse of buildComputeInput — reloads a saved
// analysis's input back into the form so it can be reviewed, edited, and
// recalculated, rather than the save feature being effectively write-only.
function setPrimaryFields(primary) {
  $("p-length").value = primary.length;
  $("p-width").value = primary.width;
  $("p-height").value = primary.height;
  $("p-weight").value = primary.weight;
  $("p-netweight").value = primary.netWeight ?? "";
  // The saved length/width/height already ARE the outside dims (readPrimary
  // bakes in Board Thickness before returning) — always reopens in Outside
  // mode with no thickness, which reproduces the exact same numbers; only
  // the "how I derived it" toggle state itself isn't restored.
  $("p-dims-mode").value = "outside";
  $("p-dims-thickness").value = 0;
  updatePrimaryDimsMode();
  const av = primary.allowedVertical ?? ["height"];
  $("p-vert-length").checked = av.includes("length");
  $("p-vert-width").checked = av.includes("width");
  $("p-vert-height").checked = av.includes("height");
}

function setStockCaseFields(sc) {
  $("sc-length").value = sc.length;
  $("sc-width").value = sc.width;
  $("sc-height").value = sc.height;
  $("sc-weight").value = sc.weight;
  $("sc-thickness").value = sc.wallThickness ?? 0;
  $("sc-maxweight").value = sc.maxWeight ?? "";
  // Unlike c-vert-*/p-vert-* (default height-only, correct for a newly
  // designed case), a stock case's real prior behavior was fully
  // unrestricted — default to all 3 so an old saved analysis with no
  // allowedVertical field reruns identically instead of narrowing.
  const vert = sc.allowedVertical ?? ["length", "width", "height"];
  $("sc-vert-length").checked = vert.includes("length");
  $("sc-vert-width").checked = vert.includes("width");
  $("sc-vert-height").checked = vert.includes("height");
}

function setCaseOptions(options = {}) {
  $("c-minper").value = options.minPerCase ?? 1;
  $("c-maxper").value = options.maxPerCase ?? 24;
  $("c-maxfactor").value = options.maxFactor ?? 6;
  $("c-thickness").value = options.caseThickness ?? 1.5;
  const nt = options.numThicknesses ?? {};
  $("c-numthick-length").value = nt.length ?? 2;
  $("c-numthick-width").value = nt.width ?? 2;
  $("c-numthick-height").value = nt.height ?? 4;
  const slack = options.slackIn ?? {};
  $("c-slackin-length").value = slack.length ?? 0;
  $("c-slackin-width").value = slack.width ?? 0;
  $("c-slackin-height").value = slack.height ?? 0;
  const od = options.odRange ?? {};
  $("c-od-min-length").value = od.length?.min ?? "";
  $("c-od-max-length").value = od.length?.max ?? "";
  $("c-od-min-width").value = od.width?.min ?? "";
  $("c-od-max-width").value = od.width?.max ?? "";
  $("c-od-min-height").value = od.height?.min ?? "";
  $("c-od-max-height").value = od.height?.max ?? "";
  $("c-maxweight").value = options.maxCaseWeight ?? "";
  const vert = options.caseAllowedVertical ?? ["height"];
  $("c-vert-length").checked = vert.includes("length");
  $("c-vert-width").checked = vert.includes("width");
  $("c-vert-height").checked = vert.includes("height");
  $("sel-c-packtype").style.display = "none"; // picked Pack Type is a one-shot auto-fill, not itself a saved field — see applyPackTypeToCaseSearch
}

function setPalletFields(pallet) {
  $("pl-length").value = pallet.length;
  $("pl-width").value = pallet.width;
  $("pl-deck").value = pallet.deckHeight ?? 0;
  $("pl-maxheight").value = pallet.maxHeight;
  $("pl-maxweight").value = pallet.maxWeight;
  $("pl-weight").value = pallet.weight ?? 25; // fallback for analyses saved before this field existed
  $("pl-material").value = pallet.material ?? "Wood";
  $("pl-overhang-length").value = pallet.overhangLength ?? 0;
  $("pl-overhang-width").value = pallet.overhangWidth ?? 0;
}

function setLoadOptionFields(lo) {
  const o = lo ?? {};
  $("ld-minlength").value = o.minLoadLength || "";
  $("ld-minwidth").value = o.minLoadWidth || "";
  $("ld-minareaeff").value = o.minAreaEfficiency ? o.minAreaEfficiency * 100 : "";
  $("ld-target").value = o.loadTarget ?? "";
  $("ld-partial").checked = !!o.allowPartialTopLayer;
}

function populateFormFromInput(workflow, input) {
  setPalletFields(input.pallet);
  setLoadOptionFields(undefined); // reset first; each branch below fills in its own, if any

  if (workflow === "pallet") {
    setPrimaryFields(input.box);
    setLoadOptionFields(input.options);
    setCaseContentFields(input.caseContent);
  } else if (workflow === "case") {
    setPrimaryFields(input.primary);
    setCaseOptions(input.options);
    setInnerPackOptions(input.options?.innerPack);
    setLoadOptionFields(input.options?.loadOptions);
  } else if (workflow === "fillcase") {
    setPrimaryFields(input.primary);
    setStockCaseFields(input.stockCase);
    setFillCaseOptionFields(input.options);
    setLoadOptionFields(input.options?.loadOptions);
  } else if (workflow === "resize") {
    setPrimaryFields(input.primary);
    setResizeVarianceFields(input.variance);
    $("rz-varyweight").checked = !!input.options?.varyWeight;
    setCaseOptions(input.options?.caseOptions);
    setLoadOptionFields(input.options?.caseOptions?.loadOptions);
  } else if (workflow === "foldedcarton") {
    $("fc-casetype").value = input.caseType;
    $("fc-length").value = input.carton.length;
    $("fc-width").value = input.carton.width;
    $("fc-weight").value = input.carton.weight;
    $("fc-thickness").value = input.carton.boardThickness;
    $("fc-thickness2").value = input.carton.boardThickness2 ?? 0;
    $("fc-fluff").value = input.carton.fluffFactor;
    setFoldedCartonAllowedVertical(input.carton.allowedVertical);
    // Old saved analyses (pre-range) had a single cartonsPerBundle number —
    // fall back to a degenerate one-value range so an old rerun doesn't
    // leave the new Min/Max fields blank.
    const cartonsRange = input.cartonsPerBundleRange ?? { min: input.cartonsPerBundle, max: input.cartonsPerBundle };
    $("fc-cartons-min").value = cartonsRange.min;
    $("fc-cartons-max").value = cartonsRange.max;
    $("fc-percase-min").value = input.cartonsPerCaseRange?.min ?? "";
    $("fc-percase-max").value = input.cartonsPerCaseRange?.max ?? "";
    if (input.caseType === "stock") {
      setStockCaseFields(input.stockCase);
      setFillCaseOptionFields(input.options);
    } else {
      setCaseOptions(input.options?.caseOptions ?? input.options);
    }
    setLoadOptionFields(input.options?.loadOptions);
  } else if (workflow === "kdf") {
    $("kdf-length").value = input.flatblank.length;
    $("kdf-width").value = input.flatblank.width;
    $("kdf-weight").value = input.flatblank.weight;
    $("kdf-thickness").value = input.flatblank.thickness;
    $("kdf-min").value = input.bundleCountRange.min;
    $("kdf-max").value = input.bundleCountRange.max;
    $("kdf-heightfactor").value = input.options?.heightFactor ?? 1;
    $("kdf-strapweight").value = input.options?.additionalStrapWeight ?? 0;
    $("kdf-glueflap").value = input.options?.glueFlapMm ?? 0;
    $("kdf-formula").value = input.options?.formulaId ?? "";
    setLoadOptionFields(input.options?.loadOptions);
    recomputeKdfDimensions();
  } else if (workflow === "multisize") {
    $("multisize-products").innerHTML = "";
    multisizeRowCount = 0;
    for (const p of input.products ?? []) addMultisizeProductRow(p);
  }

  $("workflow").value = workflow;
  $("workflow").dispatchEvent(new Event("change")); // re-runs updateHeadingForWorkflow's panel show/hide
}

function buildComputeInput(workflow) {
  const primary = readPrimary();
  const pallet = readPallet();
  const loadOptions = readLoadOptions();

  if (workflow === "pallet")
    return { box: primary, pallet, options: { objective: settings.objective, topN: 40, ...loadOptions }, caseContent: readCaseContent() };
  if (workflow === "fillcase") {
    return {
      primary,
      stockCase: readStockCase(),
      pallet,
      options: { ...readFillCaseOptions(), topN: 40, loadOptions },
    };
  }
  if (workflow === "resize") {
    return {
      primary,
      variance: readResizeVariance(),
      pallet,
      options: {
        varyWeight: $("rz-varyweight").checked,
        caseOptions: { ...readCaseOptions(), loadOptions },
        topN: 40,
      },
    };
  }
  if (workflow === "foldedcarton") {
    const { carton, cartonsPerBundleRange, bundleCountType, cartonsPerCaseRange, caseType } = readFoldedCarton();
    return {
      carton,
      cartonsPerBundleRange,
      bundleCountType,
      cartonsPerCaseRange,
      caseType,
      stockCase: caseType === "stock" ? readStockCase() : undefined,
      pallet,
      // Must mirror the Calculate handler's own branch exactly (different
      // options shape per sub-workflow) — otherwise a saved analysis loses
      // whichever setting doesn't match, and a rerun silently uses defaults.
      options:
        caseType === "stock"
          ? { ...readFillCaseOptions(), topN: 40, loadOptions }
          : { caseOptions: readCaseOptions(), loadOptions, topN: 40 },
    };
  }
  if (workflow === "kdf") {
    const { flatblank, bundleCountRange, heightFactor, additionalStrapWeight, glueFlapMm, formulaId } = readKdf();
    return {
      flatblank,
      bundleCountRange,
      pallet,
      options: { heightFactor, additionalStrapWeight, glueFlapMm, formulaId, topN: 40, loadOptions },
    };
  }
  if (workflow === "multisize") {
    return { products: readMultiSizeProducts(), pallet, options: {} };
  }
  return {
    primary,
    pallet,
    options: {
      ...readCaseOptions(),
      innerPack: $("ip-enabled").checked ? readInnerPackOptions() : null,
      topN: 40,
      loadOptions,
    },
  };
}

$("save-analysis").addEventListener("click", async () => {
  if (!currentContext) return;
  if (!requireProductName()) {
    $("save-status").textContent = "";
    return;
  }
  const workflow = currentContext.workflow;
  $("save-status").textContent = "Saving…";

  try {
    const res = await fetch(`${API_BASE}/api/analyses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow,
        meta: {
          productName: $("meta-product").value,
          productCode: $("meta-code").value,
          customer: $("meta-customer").value,
          project: $("meta-project").value,
        },
        input: buildComputeInput(workflow),
        solution: currentContext,
      }),
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const saved = await res.json();
    $("save-status").textContent = `Saved (id ${saved.id.slice(0, 8)}…) at ${new Date(saved.createdAt).toLocaleTimeString()}.`;
  } catch (err) {
    $("save-status").textContent = `Couldn't save - is the API server running? (node packages/api/src/server.js). ${err.message}`;
  }
});

// --- Recent (New Analysis's own sub-tab) & My Analyses (top-level tab) --
// User ask: "Recent Analyses should also be like a new tab under New
// Analysis as a table where we can rerun." Recent is a sub-tab nested
// inside New Analysis (New | Recent, see .subtabs) showing the same wide
// table widget the Analyses tab uses, capped to the most recent few. Both
// tables share one Rerun action (see renderAnalysesTable) — load the
// analysis back into the form AND immediately recalculate.
const RECENT_ANALYSES_LIMIT = 5;

// Loads one saved analysis's inputs into the form. Note there's no
// update-in-place: Save always POSTs a new row (see the save-analysis
// handler above), so opening an existing analysis and saving again already
// behaves as a copy — the original stays untouched in the list.
async function loadAnalysisIntoForm(id) {
  const res = await fetch(`${API_BASE}/api/analyses/${id}`);
  if (!res.ok) return false;
  const full = await res.json();
  $("meta-product").value = full.meta.productName ?? "";
  $("meta-code").value = full.meta.productCode ?? "";
  $("meta-customer").value = full.meta.customer ?? "";
  $("meta-project").value = full.meta.project ?? "";
  populateFormFromInput(full.workflow, full.input);
  return true;
}

// "Rerun" (Analyses tab and Recent sub-tab alike) — load AND immediately
// recalculate, by programmatically clicking Calculate itself rather than
// duplicating its solve logic. Calculate's own handler already ends with
// goToStep("solutions"), which restores the New sub-tab and scrolls to
// Solution.
async function rerunAnalysis(id) {
  if (await loadAnalysisIntoForm(id)) $("calculate").click();
}

function showRecentSubtab() {
  $("subtab-new-form").classList.remove("active");
  $("subtab-recent").classList.add("active");
  $("new-form-section").hidden = true;
  $("recent-section").hidden = false;
  $("panel-input").hidden = true;
  $("panel-solutions").hidden = true;
  $("panel-report").hidden = true;
  $("calculate-preview").hidden = true;
  $("preview-3d-row").hidden = true;
  $("recent-section").appendChild($("analyses-table-wrap")); // shared with the Analyses tab — see its comment in index.html
  $("analyses-table-wrap").hidden = false;
  renderAnalysesTable({ limit: RECENT_ANALYSES_LIMIT });
}
$("subtab-recent").addEventListener("click", showRecentSubtab);
$("subtab-new-form").addEventListener("click", () => goToStep("new"));

// --- Manage Settings and Databases (Databases tab, top-level entry) -------
// User ask: "add manage database tab under package databases to import
// export databases. also, when we create a new item in the databases, it
// should be added to the existing one." Import always POSTs each item as a
// new row (see addLibraryItem, packages/api/src/db.js — every POST gets a
// fresh id/createdAt regardless of what the body carries), so it merges
// into whatever's already in that database instead of replacing it — the
// same "added to the existing one" every other Add New already does. No
// de-duplication: importing the same file twice creates duplicates, same
// as clicking Add New twice with the same values would.
//
// No unit conversion in either direction, by design: every value this
// reads (GET) or writes (POST) is already this app's own canonical storage
// representation — every library save handler already converts a form's
// display-unit input to canonical before it's ever sent to the API (see
// unitKindToCanonical), and unitKindToDisplay converts back only at render
// time, driven by whatever settings.units is *right now*. Round-tripping
// the raw canonical fields straight through means an import lands
// correctly under the CURRENT Report Units regardless of what units were
// active when the file was exported — "make sure unit of measure will work
// fine based on the settings" is satisfied by not touching units at all.
//
// Mirrors db.js's own LIBRARY_TYPES array — no server endpoint lists them,
// so this is a second hardcoded copy, same as this app's own
// TABLE_STYLE_LIBRARY_TYPES/LIBRARY_FIELD_SCHEMAS keys already are.
const ALL_LIBRARY_TYPES = [
  "pallets", "trucks", "packs", "board-grades", "stock-cases",
  "folded-carton-types", "folded-carton-boards", "pack-names", "shapes",
  "case-configurations", "liner-materials", "medium-materials",
  "flute-takeup-factors", "format-load-profiles",
  "storage-environment-factors", "graphics", "kdf-formulae", "packages",
  "printing-factors", "partition-factors", "case-proportion-factors",
  "fluting-orientation-factors", "efficiency-factors",
];

// User ask: "show the imported settings folder, so we know that we are
// connected to that." A plain <input type="file"> (what "Import Settings
// and Databases" already uses, see importDatabaseFileInput below) never
// gets a real, live connection to a folder — the browser copies the one
// selected file's bytes into memory and forgets it, and no web page can
// read back an OS folder path at all, for security. What CAN be shown,
// and IS what the user actually needs to answer "are we connected to the
// right thing": which file was last imported, and when — remembered here
// so it survives a reload, unlike the transient "Importing…"/"Imported X
// items" message in #manage-database-status right below it in the modal.
function getLastImportInfo() {
  try {
    const raw = localStorage.getItem(LAST_IMPORT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setLastImportInfo(fileName) {
  const info = { fileName, importedAt: new Date().toISOString() };
  try {
    localStorage.setItem(LAST_IMPORT_KEY, JSON.stringify(info));
  } catch {
    // localStorage can throw (private browsing, storage disabled) — the
    // banner just won't persist past this session, same fallback already
    // accepted for SETTINGS_KEY elsewhere in this file.
  }
  renderLastImportInfo();
}
function renderLastImportInfo() {
  const el = $("last-import-info");
  if (!el) return;
  const info = getLastImportInfo();
  if (!info) {
    el.textContent = "No file imported yet - databases hold built-in items only.";
    return;
  }
  const when = new Date(info.importedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  el.innerHTML = `Last import: <strong>${info.fileName}</strong> (${when})`;
}

const manageDatabaseModal = $("manage-database-modal");
function openManageDatabaseView() {
  $("manage-database-status").textContent = "";
  renderLastImportInfo();
  manageDatabaseModal.style.display = "flex";
}
$("manage-database-close").addEventListener("click", () => {
  manageDatabaseModal.style.display = "none";
});
manageDatabaseModal.addEventListener("click", (e) => {
  if (e.target === manageDatabaseModal) manageDatabaseModal.style.display = "none";
});

$("export-database").addEventListener("click", async () => {
  $("manage-database-status").textContent = "Exporting…";
  try {
    const libraries = {};
    await Promise.all(
      ALL_LIBRARY_TYPES.map(async (type) => {
        const res = await fetch(`${API_BASE}/api/library/${type}`);
        libraries[type] = res.ok ? (await res.json()).items : [];
      })
    );
    const payload = { exportedAt: new Date().toISOString(), settings, libraries };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "simpallet-databases.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const total = Object.values(libraries).reduce((n, items) => n + items.length, 0);
    $("manage-database-status").textContent = `Exported ${total} items across ${ALL_LIBRARY_TYPES.length} databases, plus settings.`;
  } catch (err) {
    $("manage-database-status").textContent = `Export failed: ${err.message}. Is the API server running?`;
  }
});

const importDatabaseFileInput = document.createElement("input");
importDatabaseFileInput.type = "file";
importDatabaseFileInput.accept = ".json";
importDatabaseFileInput.style.display = "none";
document.body.appendChild(importDatabaseFileInput);

importDatabaseFileInput.addEventListener("change", async () => {
  const file = importDatabaseFileInput.files[0];
  importDatabaseFileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    alert(`Couldn't parse ${file.name} as JSON. (${err.message})`);
    return;
  }
  if (!payload || typeof payload !== "object" || (!payload.libraries && !payload.settings)) {
    alert(`${file.name} doesn't look like an exported database file (missing libraries/settings).`);
    return;
  }

  $("manage-database-status").textContent = "Importing…";
  try {
    let itemCount = 0;
    let typeCount = 0;
    for (const type of Object.keys(payload.libraries ?? {})) {
      const items = payload.libraries[type];
      if (!Array.isArray(items) || items.length === 0) continue;
      typeCount++;
      for (const item of items) {
        // Strip the exported row's own id/createdAt/isBuiltin — the server
        // always assigns fresh ones on POST, and every item becomes a new
        // row alongside whatever's already there, never replacing it.
        const { id, createdAt, isBuiltin, ...data } = item;
        await fetch(`${API_BASE}/api/library/${type}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        itemCount++;
      }
    }
    if (payload.settings && typeof payload.settings === "object") {
      const prevUnits = settings.units;
      settings = { ...settings, ...payload.settings };
      persistSettings();
      if (currentContext) renderSummary();
      if (settings.units !== prevUnits) {
        applyStrengthDefaults();
        updateCustomFormulaToggle();
      }
    }
    setLastImportInfo(file.name);
    $("manage-database-status").textContent =
      `Imported ${itemCount} items across ${typeCount} databases` +
      (payload.settings ? ", plus settings." : ".") +
      " Reopen any database to see the new items.";
  } catch (err) {
    $("manage-database-status").textContent = `Import failed: ${err.message}. Is the API server running?`;
  }
});

$("import-database").addEventListener("click", () => importDatabaseFileInput.click());

// User ask: "we should also be able to delete settings and databases... so
// we empty what we have now in there." Deletes every item in every
// ALL_LIBRARY_TYPES database (the same set Export/Import above covers) and
// resets `settings` to DEFAULT_SETTINGS — the same defaults loadSettings
// itself falls back to. Saved Analyses untouched, same "stays per-user,
// not part of this shared bundle" reasoning as Export/Import above. A real
// confirm() gate first: this is the one genuinely irreversible action in
// this modal, unlike Export (read-only) or Import (additive, never
// deletes) — no undo, no trash/recycle bin.
$("reset-database").addEventListener("click", async () => {
  const ok = confirm(
    "This will permanently delete every item in every database and reset Settings/Default Environmental Factors to their defaults. Saved Analyses are not affected. This cannot be undone. Continue?"
  );
  if (!ok) return;
  $("reset-database-status").textContent = "Deleting…";
  try {
    let itemCount = 0;
    await Promise.all(
      ALL_LIBRARY_TYPES.map(async (type) => {
        const res = await fetch(`${API_BASE}/api/library/${type}`);
        const items = res.ok ? (await res.json()).items : [];
        for (const item of items) {
          await fetch(`${API_BASE}/api/library/${type}/${item.id}`, { method: "DELETE" });
          itemCount++;
        }
      })
    );
    settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    if (currentContext) renderSummary();
    applyStrengthDefaults();
    updateCustomFormulaToggle();
    // A "Connected to: X" claim would be stale/misleading once everything
    // that import brought in has just been deleted.
    try {
      localStorage.removeItem(LAST_IMPORT_KEY);
    } catch {
      // same private-browsing/storage-disabled fallback as everywhere else
      // localStorage is touched in this file — harmless to skip.
    }
    renderLastImportInfo();
    $("reset-database-status").textContent =
      `Deleted ${itemCount} items across ${ALL_LIBRARY_TYPES.length} databases and reset Settings to defaults.`;
  } catch (err) {
    $("reset-database-status").textContent = `Reset failed: ${err.message}. Is the API server running?`;
  }
});

// Just Report Units and Default Search Objective — general app preferences
// with no CapePack Database equivalent. Default Strength & Environmental
// Factors used to live here too, but CapePack itself only ever exposes that
// under Databases (its own "Default Environmental Factors" screen isn't a
// general Settings page), so it moved to Databases > Strength > Default
// Env. Factors (see openStrengthDefaultsForm below) — settings still stores it
// all as one object, just written back by two different save buttons now,
// each preserving the other's fields via spread.
function populateSettingsForm() {
  $("set-units").value = settings.units;
  $("set-objective").value = settings.objective;
  $("set-cost-per-kg").value = settings.costPerKg ?? "";
  $("set-co2-per-kg").value = settings.co2PerKg ?? "";
}

$("settings-save").addEventListener("click", () => {
  const prevUnits = settings.units;
  const costPerKg = $("set-cost-per-kg").value.trim();
  const co2PerKg = $("set-co2-per-kg").value.trim();
  settings = {
    ...settings,
    units: $("set-units").value,
    objective: $("set-objective").value,
    costPerKg: costPerKg === "" ? null : Number(costPerKg),
    co2PerKg: co2PerKg === "" ? null : Number(co2PerKg),
  };
  persistSettings();
  if (currentContext) renderSummary(); // re-render with the new units immediately
  if (settings.units !== prevUnits) {
    applyStrengthDefaults(); // re-display the Report step's stored ECT/Caliper etc. in the new units
    updateCustomFormulaToggle(); // a saved Custom Formula only applies under the units it was saved for
  }
  $("settings-status").textContent = "Saved.";
});

// --- Default Environmental Factors (Databases > Strength > Default Env. Factors) ---
function populateStrengthDefaultsForm() {
  // strengthEct/strengthCaliper are stored canonically in lb/in and mils —
  // convert to whatever Report Units (Settings) currently shows.
  updateStrengthUnitLabels(); // sets set-ect-label/set-cal-label same as it does for the Report step's r-ect-label/r-cal-label
  $("set-ect").value = roundTo(ectLbInToDisplay(settings.strengthEct), 4);
  $("set-cal").value = roundTo(caliperMilsToDisplay(settings.strengthCaliper), 4);
  $("set-casetype").value = settings.strengthCaseType;
  $("set-printing").value = settings.strengthPrinting;
  $("set-fluting").value = settings.strengthFluting;
  $("set-partition").value = settings.strengthPartition;
  setPartitionModeUi(settings.strengthPartition);
  $("set-internalsupport").value = roundTo(weightLbToDisplay(settings.strengthInternalSupportLb), 2);
  $("set-palletsstacked").value = settings.strengthPalletsStacked;
  $("set-safetymargin-enabled").checked = settings.strengthSafetyMarginEnabled;
  $("set-safetymargin-pct").value = settings.strengthSafetyMarginRequiredPct;
  $("set-production").value = settings.strengthProductionPct;
  $("set-seasonal").value = settings.strengthSeasonalPct;
  $("set-humidity").value = settings.strengthHumidity;
  $("set-days").value = settings.strengthDays;
  $("set-orientation").value = settings.strengthOrientation;
  $("set-stacking").value = settings.strengthStacking;
  $("set-overhang").value = settings.strengthOverhang;
  $("set-surface").value = settings.strengthSurface;
}

const strengthDefaultsModal = $("strength-defaults-modal");
function openStrengthDefaultsForm() {
  populateStrengthDefaultsForm();
  $("strength-defaults-status").textContent = "";
  strengthDefaultsModal.style.display = "flex";
}
$("strength-defaults-close").addEventListener("click", () => {
  strengthDefaultsModal.style.display = "none";
});
strengthDefaultsModal.addEventListener("click", (e) => {
  if (e.target === strengthDefaultsModal) strengthDefaultsModal.style.display = "none";
});

// --- Formulae (Databases > Strength > Formulae) -----------------------------
// Real CapePack's own screen (user-supplied Imperial and Metric
// screenshots): read-only Edge Crush (Ring Crush/STFI) and McKee formula
// text, unit-aware from the exact same constants/conversions the rest of
// this app calculates with (see UNIT_KINDS and the compression.js
// MCKEE_*/RING_CRUSH_* exports) — never a second, hand-typed copy of
// these numbers that could drift out of sync. STFI's own constants
// (0.642/0.948/0.473/24.853/1.28) are the same in both of CapePack's real
// screens, so those five are shown as fixed text, not computed.
const FORMULA_OP_SYMBOL = { times: "x", raisedTo: "^", dividedBy: "/" };
const FORMULA_ADJ_SYMBOL = { plus: "+", minus: "-" };

function mckeeDefaultCustomFormula(units) {
  const coefficient = units === "imperial" ? MCKEE_COEFFICIENT_IMPERIAL : MCKEE_COEFFICIENT_METRIC;
  return {
    units,
    term1: { combineOp: "times", value: roundTo(coefficient, 4), adjOp: "plus", adjValue: 0 },
    connector1: "times",
    term2: { combineOp: "raisedTo", value: MCKEE_EXPONENT_CALIPER, adjOp: "plus", adjValue: 0 },
    connector2: "times",
    term3: { combineOp: "raisedTo", value: MCKEE_EXPONENT_PERIMETER, adjOp: "plus", adjValue: 0 },
  };
}

function formatFormulaTerm(label, unit, term) {
  const opText = term.combineOp === "raisedTo" ? `^${term.value}` : `${FORMULA_OP_SYMBOL[term.combineOp]} ${term.value}`;
  const base = `${label} (${unit}) ${opText}`;
  return term.adjValue ? `(${base} ${FORMULA_ADJ_SYMBOL[term.adjOp]} ${term.adjValue})` : `(${base})`;
}

function formatCustomFormulaText(formula, edgeCrushUnit, caliperUnit, perimeterUnit) {
  const t1 = formatFormulaTerm("Edge Crush Value", edgeCrushUnit, formula.term1);
  const t2 = formatFormulaTerm("Caliper Value", caliperUnit, formula.term2);
  const t3 = formatFormulaTerm("Case Perimeter", perimeterUnit, formula.term3);
  return `BCT = ${t1} ${FORMULA_OP_SYMBOL[formula.connector1]} ${t2} ${FORMULA_OP_SYMBOL[formula.connector2]} ${t3}`;
}

function renderFormulaeView() {
  const units = settings.units === "imperial" ? "imperial" : "metric";
  $("formulae-units-label").textContent = units === "imperial" ? "Imperial" : "Metric";

  const edgeCrushUnit = unitKindSuffix("edgeCrush", units);
  const pressureUnit = unitKindSuffix("pressure", units);
  const weightUnit = unitKindSuffix("weight", units);
  // Imperial McKee uses the same "in" for both Caliper and Perimeter;
  // Metric uses two DIFFERENT units (mm/cm) — confirmed from both real
  // screenshots, not a display bug. Neither matches an existing UNIT_KINDS
  // entry (caliper's own "mm"/"in" pair doesn't cover Metric's "cm"
  // perimeter), so these two are their own small local lookup rather than
  // stretching UNIT_KINDS to fit a shape it wasn't designed for.
  const caliperUnit = units === "imperial" ? "in" : "mm";
  const perimeterUnit = units === "imperial" ? "in" : "cm";

  $("formulae-rc-unit").textContent = edgeCrushUnit;
  $("formulae-stfi-unit").textContent = edgeCrushUnit;

  const threshold = roundTo(unitKindToDisplay("pressure", RING_CRUSH_BURST_THRESHOLD_LB, units), 4);
  const lowAdjustment = roundTo(unitKindToDisplay("edgeCrush", RING_CRUSH_LOW_BURST_ADJUSTMENT, units), 4);
  const highAdjustment = roundTo(Math.abs(unitKindToDisplay("edgeCrush", RING_CRUSH_HIGH_BURST_ADJUSTMENT, units)), 4);
  $("formulae-rc-text").textContent =
    "ECT = ((Σ(Medium Factor(s) x Takeup Factor(s))) + Σ(Liner Factors(s))) x Efficiency Factor. " +
    `For up to ${threshold} ${pressureUnit} Burst Test, add ${lowAdjustment}, else subtract ${highAdjustment}.`;

  const mckeeCoefficient = roundTo(units === "imperial" ? MCKEE_COEFFICIENT_IMPERIAL : MCKEE_COEFFICIENT_METRIC, 4);
  $("formulae-mckee-heading").textContent = `The McKee Formula (${weightUnit})`;
  $("formulae-mckee-text").textContent =
    `BCT = (Edge Crush Value (${edgeCrushUnit}) x ${mckeeCoefficient}) x ` +
    `( Caliper value (${caliperUnit}) ^${MCKEE_EXPONENT_CALIPER} ) x ` +
    `(Case Perimeter (${perimeterUnit}) ^${MCKEE_EXPONENT_PERIMETER})`;

  $("formulae-custom-heading").textContent = `Edit your Custom Formulae (${weightUnit})`;
  const savedMatchesUnits = settings.customFormula && settings.customFormula.units === units;
  const formulaToShow = savedMatchesUnits ? settings.customFormula : mckeeDefaultCustomFormula(units);
  $("formulae-custom-text").textContent = formatCustomFormulaText(formulaToShow, edgeCrushUnit, caliperUnit, perimeterUnit);
  $("formulae-custom-note").textContent = !settings.customFormula
    ? "Not customized yet - shown here is the standard McKee default for your current Report Units."
    : savedMatchesUnits
      ? "✓ Saved - switch on \"Use Custom Formula\" on the Report step to use it."
      : `Saved under ${settings.customFormula.units === "imperial" ? "Imperial" : "Metric"} - switch Report Units to use it, or edit it again under ${units === "imperial" ? "Imperial" : "Metric"}.`;
}

const formulaeModal = $("formulae-modal");
function openFormulaeView() {
  renderFormulaeView();
  formulaeModal.style.display = "flex";
}
$("formulae-close").addEventListener("click", () => {
  formulaeModal.style.display = "none";
});
formulaeModal.addEventListener("click", (e) => {
  if (e.target === formulaeModal) formulaeModal.style.display = "none";
});

// --- Custom Formula Entry modal ----------------------------------------
function populateCustomFormulaForm(formula) {
  $("cf-term1-op").value = formula.term1.combineOp;
  $("cf-term1-value").value = formula.term1.value;
  $("cf-term1-adjop").value = formula.term1.adjOp;
  $("cf-term1-adj").value = formula.term1.adjValue;
  $("cf-connector1").value = formula.connector1;
  $("cf-term2-op").value = formula.term2.combineOp;
  $("cf-term2-value").value = formula.term2.value;
  $("cf-term2-adjop").value = formula.term2.adjOp;
  $("cf-term2-adj").value = formula.term2.adjValue;
  $("cf-connector2").value = formula.connector2;
  $("cf-term3-op").value = formula.term3.combineOp;
  $("cf-term3-value").value = formula.term3.value;
  $("cf-term3-adjop").value = formula.term3.adjOp;
  $("cf-term3-adj").value = formula.term3.adjValue;
}
function readCustomFormulaForm() {
  return {
    units: settings.units === "imperial" ? "imperial" : "metric",
    term1: {
      combineOp: $("cf-term1-op").value,
      value: num("cf-term1-value"),
      adjOp: $("cf-term1-adjop").value,
      adjValue: num("cf-term1-adj"),
    },
    connector1: $("cf-connector1").value,
    term2: {
      combineOp: $("cf-term2-op").value,
      value: num("cf-term2-value"),
      adjOp: $("cf-term2-adjop").value,
      adjValue: num("cf-term2-adj"),
    },
    connector2: $("cf-connector2").value,
    term3: {
      combineOp: $("cf-term3-op").value,
      value: num("cf-term3-value"),
      adjOp: $("cf-term3-adjop").value,
      adjValue: num("cf-term3-adj"),
    },
  };
}
function openCustomFormulaModal() {
  const units = settings.units === "imperial" ? "imperial" : "metric";
  const savedMatchesUnits = settings.customFormula && settings.customFormula.units === units;
  populateCustomFormulaForm(savedMatchesUnits ? settings.customFormula : mckeeDefaultCustomFormula(units));
  $("custom-formula-status").textContent = "";
  $("custom-formula-modal").style.display = "flex";
}
$("formulae-edit-custom").addEventListener("click", openCustomFormulaModal);
$("custom-formula-close").addEventListener("click", () => {
  $("custom-formula-modal").style.display = "none";
});
$("custom-formula-modal").addEventListener("click", (e) => {
  if (e.target === $("custom-formula-modal")) $("custom-formula-modal").style.display = "none";
});
$("custom-formula-reset").addEventListener("click", () => {
  populateCustomFormulaForm(mckeeDefaultCustomFormula(settings.units === "imperial" ? "imperial" : "metric"));
  $("custom-formula-status").textContent = "Reset to McKee's own defaults (not saved yet).";
});
$("custom-formula-save").addEventListener("click", () => {
  settings = { ...settings, customFormula: readCustomFormulaForm() };
  persistSettings();
  $("custom-formula-status").textContent = "✓ Saved.";
  renderFormulaeView();
  updateCustomFormulaToggle();
});

// Report step's "Use Custom Formula" checkbox only makes sense when a
// saved custom formula exists AND was saved under the currently-active
// Report Units (McKee's own Imperial/Metric coefficients aren't
// interchangeable — see compression.js's own honesty note, which applies
// just as much to a user-defined formula built from those same inputs).
function updateCustomFormulaToggle() {
  const units = settings.units === "imperial" ? "imperial" : "metric";
  const available = settings.customFormula && settings.customFormula.units === units;
  $("r-use-custom-formula").disabled = !available;
  if (!available) $("r-use-custom-formula").checked = false;
  $("r-custom-formula-note").style.display = settings.customFormula && !available ? "block" : "none";
  if (settings.customFormula && !available) {
    $("r-custom-formula-note").textContent =
      `Your saved Custom Formula was defined under ${settings.customFormula.units === "imperial" ? "Imperial" : "Metric"} - switch Report Units to use it.`;
  }
}

// --- Cases and Trays (Databases > Cases and Trays) --------------------------
// Real CapePack's own screen (user-supplied screenshot) is genuinely
// richer than every other table-mode type's generic {name,length,width,
// height,weight} shape: real per-axis Inside (ID)/Outside (OD)
// dimensions (not always a uniform wallThickness x2 — see
// fillStockCase's own updated doc comment), a Dimension Mode toggle
// (Inside: OD computed from ID + Thickness x a per-axis Number of
// Thicknesses; Manual: OD typed independently), and a live-computed
// read-only Volume — plus (user ask, this entry) a "Select From Library"
// Pack Type picker and a live 3D preview. Opens through the exact same
// shared #library-modal/openLibrary flow as every other type (user:
// "should look similar to others... on another page" — the Add/Edit
// form is "another page" of that SAME modal, exactly like every other
// type's own grid-view/form-view toggle), with openLibrary special-
// casing type==="stock-cases" to call openCasesTraysForm instead of the
// generic showLibraryForm (same pattern as "shapes"'s own
// openShapeEditor) — so there's exactly one shared modal, not a second
// bespoke one. Canonically stored in mm/kg regardless of the Units of
// Measure picked at entry time (same convention as pallets/trucks);
// every displayed number follows the GLOBAL Report Units setting
// (matching this session's own broader unit-of-measure fix), not a
// per-row remembered entry unit — disclosed simplification, not a claim
// CapePack's own table works this way.
//
// The real table's "Pack Type" column shows two stacked words (e.g.
// "Case" / "RSC", "Case" / "Cutaway Tray") where the real Add form (same
// screenshot) only has ONE "Pack Type *" field (value "RSC"). Read as:
// the stored field is the specific style (RSC/Cutaway Tray/...), and the
// broader "Case"/"Tray" word is a derived label for display, not a
// second stored field — casesTraysPackCategory below infers it from
// whether the style name contains "Tray". Genuinely a judgment call
// (the alternative — a real separate stored category field — can't be
// ruled out from a screenshot alone), disclosed rather than silently
// assumed to be definitely right.
function casesTraysPackCategory(packType) {
  return /tray/i.test(packType ?? "") ? "Tray" : "Case";
}
function casesTraysVolumeDisplay(item, units) {
  if (item.idLength === undefined) return 0;
  if (units === "imperial") {
    return (
      UNIT_KINDS.length.toDisplay(item.idLength, "imperial") *
      UNIT_KINDS.length.toDisplay(item.idWidth, "imperial") *
      UNIT_KINDS.length.toDisplay(item.idHeight, "imperial")
    );
  }
  return (item.idLength * item.idWidth * item.idHeight) / 1000;
}

// Applies a picked (or just-uploaded) Pack Type shape to the open Cases and
// Trays form — the equivalent of applyShapeToPackType above, but for this
// form's own ID/OD/Number-of-Thicknesses fields instead of Primary Pack's.
// A real Collada shape only tells us its outer geometry, not a separate
// wall thickness, so it sets Dimension Mode to Manual and fills the OD
// fields directly (mirroring how applyShapeToPackType has no wall-thickness
// concept either); a plain named template instead auto-fills the per-axis
// Number of Thicknesses from the shape's own stored default, if it has one
// (Custom deliberately has none — see its shapes.json entry — so picking it
// leaves whatever the user already typed alone).
async function applyPackTypeToCaseTray(item) {
  $("ct-packtype").value = item.name;
  if (item.numThicknessesLength !== undefined) {
    $("ct-numthick-length").value = item.numThicknessesLength;
    $("ct-numthick-width").value = item.numThicknessesWidth;
    $("ct-numthick-height").value = item.numThicknessesHeight;
  }
  if (item.zae) {
    try {
      const parsed = await parseCustomShapeFile(item.zae, item.zaeFilename, { zUp: item.zaeZUp });
      const units = $("ct-units").value === "imperial" ? "imperial" : "metric";
      $("ct-dimensionmode").value = "manual";
      $("ct-od-length").value = roundTo(unitKindToDisplay("length", parsed.lengthMm, units), 4);
      $("ct-od-width").value = roundTo(unitKindToDisplay("length", parsed.widthMm, units), 4);
      $("ct-od-height").value = roundTo(unitKindToDisplay("length", parsed.heightMm, units), 4);
    } catch (err) {
      alert(`Couldn't load "${item.name}": ${err.message}`);
    }
  }
  updateCasesTraysConditionalFields();
}

// Create a Case's own Secondary Pack Details — the case being DESIGNED, not
// an existing library entry, so unlike applyPackTypeToCaseTray this only
// ever auto-fills Number of Thicknesses (the one real per-Pack-Type value
// that actually feeds optimizeCase's own search — see readCaseOptions).
// No OD/Dimension-Mode handling: Create a Case COMPUTES the case's outside
// dimensions from the primary pack's own count × thickness, it doesn't
// take them as input the way Cases and Trays' own form does, so a picked
// shape's stored .zae geometry (if any) has nothing to apply itself to
// here — Pack Type is purely a Number-of-Thicknesses convenience.
function applyPackTypeToCaseSearch(item) {
  markSelected("sel-c-packtype", item.name, { icon: item.icon });
  if (item.numThicknessesLength !== undefined) {
    $("c-numthick-length").value = item.numThicknessesLength;
    $("c-numthick-width").value = item.numThicknessesWidth;
    $("c-numthick-height").value = item.numThicknessesHeight;
  }
}
$("c-open-packtype-library").addEventListener("click", () => {
  openPackTypeModal(applyPackTypeToCaseSearch);
});

// --- Pack Type picker (small standalone modal, not the shared
// #library-modal — that modal is already occupied by the Cases and
// Trays form itself while this button is visible, so nesting the same
// openLibrary flow inside it would replace the form instead of layering
// over it).
//
// Backed by the real "shapes" library, filtered to category "Case/Tray
// Pack Type" — NOT a separate pack-types database (see db.js's
// LIBRARY_TYPES comment for why that was retired). User correction: the
// real Cape Pack Cloud "Choose From The List" Pack Type picker (all 15
// real entries, user-supplied) is the same Pack Type Library used for
// Primary/Secondary Pack shape selection throughout the app — confirmed by
// the real user guide, which also confirms Cases and Trays' own Add form
// has an "Upload Collada" step (section on Creating Shapes). So this reuses
// the shapes library's existing openShapeEditor/Collada-upload flow
// (below) rather than a second, upload-incapable picker.
let currentPackTypeOnPick = null; // (savedOrPicked) => void, set per-call below — read by the "Add New Shape" handler further down
let currentPackTypeItems = []; // the CURRENT CATEGORY's items, re-filtered locally by pack-type-search's oninput
let currentPackTypeAllItems = []; // the full unfiltered fetch for this modal open — re-sliced per category on rail click, no refetch needed
// (currentName) => string | undefined — set per-call by openPackTypeModal's
// optional 2nd argument. Reused by more than just Cases and Trays now
// (Create a Case's own Secondary Pack Details, see
// applyPackTypeToCaseSearch), which has no persistent "current Pack Type"
// field to highlight against at all — this used to hardcode a read of
// Cases and Trays' own #ct-packtype directly, which threw (element
// doesn't exist) the first time this picker opened from anywhere else.
let currentPackTypeGetCurrentName = null;
// Real Cape Pack Cloud's own "Explore" sidebar (user-supplied screenshot,
// "Choose From The List" Pack Type Library) — the 5 real browsing
// categories that exist in the "shapes" library for general Primary/
// Secondary Pack shape selection. Deliberately does NOT include "Case/Tray
// Pack Type" — that's a separate, narrower real dataset (its own items
// carry numThicknessesLength/Width/Height, none of these 5 do) built
// specifically for Create a Case's own Number-of-Thicknesses convenience
// (see applyPackTypeToCaseSearch/openPackTypeModal's own call site below),
// not a general-purpose browsing category — folding it in here would mix
// two different real datasets that happen to share a similar name.
const PACK_TYPE_BROWSE_CATEGORIES = [
  "Cases and Trays",
  "Ovals / Rectangular Bottles",
  "Bags and Pouches",
  "Cylinders / Round Bottles",
  "Trapezoids / Totes",
];
let currentPackTypeCategories = []; // the categories list this open was given — [] means "no rail" (Create a Case's own single-category call)
let currentPackTypeCategory = null; // the currently-selected rail category, or null when there's no rail
// Selection has no id to match against (Pack Type is a plain text field on
// the Cases and Trays form, not a stored reference — see
// applyPackTypeToCaseTray) — matched by name instead, same limitation
// #sel-packtype's own display elsewhere already has.
function renderPackTypeGrid(items) {
  const grid = $("pack-type-modal-list");
  const currentName = currentPackTypeGetCurrentName?.() ?? "";
  grid.innerHTML = items.length ? "" : "<p style='padding:8px;color:var(--muted);font-size:12px'>No matches.</p>";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = item.name === currentName ? "library-card selected" : "library-card";
    card.innerHTML = `<img src="../library/${item.icon}" alt="" /><div class="lib-name">${item.name}</div><div class="lib-dims">${libraryDims(item)}</div>`;
    card.title = item.note || "";
    card.addEventListener("click", async () => {
      await currentPackTypeOnPick(item);
      $("pack-type-modal").style.display = "none";
    });
    grid.appendChild(card);
  }
}
// The "Explore" category rail — only rendered when openPackTypeModal was
// given more than one category (Primary/Secondary Pack's own "Select From
// Library" call); Create a Case's own single-category call leaves
// currentPackTypeCategories empty and this section hidden entirely, same
// as before this rail existed.
function renderPackTypeCategoryRail() {
  const wrap = $("pack-type-modal-categories");
  const list = $("pack-type-category-list");
  if (currentPackTypeCategories.length < 2) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  list.innerHTML = "";
  for (const cat of currentPackTypeCategories) {
    const row = document.createElement("div");
    row.className = cat === currentPackTypeCategory ? "pt-category-item selected" : "pt-category-item";
    row.textContent = cat;
    row.addEventListener("click", () => selectPackTypeCategory(cat));
    list.appendChild(row);
  }
}
function selectPackTypeCategory(cat) {
  currentPackTypeCategory = cat;
  $("pack-type-search").value = "";
  currentPackTypeItems = currentPackTypeAllItems.filter((i) => i.category === cat);
  renderPackTypeCategoryRail();
  renderPackTypeGrid(currentPackTypeItems);
}
// Backed by the real "shapes" library — NOT a separate pack-types database
// (see db.js's LIBRARY_TYPES comment for why that was retired). User
// correction: the real Cape Pack Cloud "Choose From The List" Pack Type
// picker (all 15 real "Case/Tray Pack Type" entries, user-supplied) is the
// same Pack Type Library used for Primary/Secondary Pack shape selection
// throughout the app — confirmed by the real user guide, which also
// confirms Cases and Trays' own Add form has an "Upload Collada" step
// (section on Creating Shapes).
//
// options.categories: string[] | undefined — when 2+ categories are given,
// shows the real "Explore" rail (screenshot-confirmed) and defaults to the
// first one; when omitted, keeps this modal's original single-category
// behavior (Create a Case's own call, unchanged since before the rail
// existed) — filtered to "Case/Tray Pack Type", no rail shown.
async function openPackTypeModal(onPick, getCurrentName, options = {}) {
  currentPackTypeOnPick = onPick;
  currentPackTypeGetCurrentName = getCurrentName ?? null;
  currentPackTypeCategories = options.categories ?? [];
  $("pack-type-search").value = "";
  const res = await fetch(`${API_BASE}/api/library/shapes`);
  currentPackTypeAllItems = (await res.json()).items;
  currentPackTypeCategory =
    currentPackTypeCategories.length >= 2 ? currentPackTypeCategories[0] : "Case/Tray Pack Type";
  currentPackTypeItems = currentPackTypeAllItems.filter((i) => i.category === currentPackTypeCategory);
  renderPackTypeCategoryRail();
  renderPackTypeGrid(currentPackTypeItems);
  $("pack-type-modal").style.display = "flex";
}
$("pack-type-search").addEventListener("input", () => {
  const q = $("pack-type-search").value.trim().toLowerCase();
  renderPackTypeGrid(q ? currentPackTypeItems.filter((i) => i.name.toLowerCase().includes(q)) : currentPackTypeItems);
});
$("pack-type-modal-close").addEventListener("click", () => {
  $("pack-type-modal").style.display = "none";
});
$("pack-type-modal").addEventListener("click", (e) => {
  if (e.target === $("pack-type-modal")) $("pack-type-modal").style.display = "none";
});
// Reuses openShapeEditor (the same Collada-upload form Custom Shapes/
// Browse Shape Library's own "+ Add New" opens) instead of a bespoke
// upload UI — pre-filling its Category field so the new shape lands back
// in this same filtered list, then applying it via whichever onPick
// openPackTypeModal was last opened with, exactly like picking an existing
// entry would. Styled as a real screenshot-matching dropzone (see
// .cs-dropzone, index.html) even though the click always routes through
// openShapeEditor's own separate dropzone rather than accepting a dropped
// file directly here — same proven upload/parse pipeline, just reached one
// click later, not a second implementation of Collada parsing.
$("pack-type-modal-add-new").addEventListener("click", () => {
  openShapeEditor(null, (saved) => {
    currentPackTypeOnPick?.(saved);
    $("pack-type-modal").style.display = "none";
  });
  // The currently-selected rail category (or the single fixed category
  // when there's no rail — Create a Case's own call) — a shape created
  // from this modal should land back in whichever category is showing,
  // not always "Case/Tray Pack Type" now that this modal browses more
  // than one.
  $("cs-category").value = currentPackTypeCategory ?? "Case/Tray Pack Type";
});

// --- A tiny, independent Three.js viewport for the live Case/Tray
// preview — the app's main `scene`/`renderer`/`camera` (above) is tied
// to the primary New Analysis 3D panel, a completely different DOM
// location; this is its own scene/camera/renderer bound to a canvas
// built fresh into the Cases and Trays form each time it opens, with
// its own small render loop that stops once the form closes (checked
// via the container still being attached to the document) rather than
// running forever in the background.
let casesTraysScene, casesTraysCamera, casesTraysRenderer, casesTraysControls, casesTraysBoxGroup;
function ensureCasesTraysScene(container) {
  // User report: "cases and trays does not show any 3d in the databases.
  // it is like empty." Reproduced and root-caused by direct inspection
  // rather than guessed at: the scene/camera/box mesh were all confirmed
  // correctly built (a THREE.Group with the expected mesh+edges children,
  // camera positioned and pointed at the box) and the render loop below
  // was confirmed actively calling .render() every animation frame with
  // zero WebGL errors and a live, non-lost context — yet the canvas's own
  // actual pixels (checked via toDataURL, not raw gl.readPixels, which can
  // itself under-report on a non-preserved buffer and nearly led to a
  // wrong conclusion here) came back 100% transparent black regardless.
  // The real cause: this WebGLRenderer never set `preserveDrawingBuffer:
  // true`. Without it, a browser is free to clear/swap the drawing buffer
  // right after each composite, so anything that reads the canvas outside
  // that exact instant (toDataURL from a separate task, a screenshot tool,
  // certain compositor paths) can legitimately see a blank buffer even
  // though every render call succeeded — this app's own MAIN renderer
  // (`const renderer = new THREE.WebGLRenderer(...)` near the top of this
  // file) already sets this flag, for the identical reason, documented
  // in docs/ARCHITECTURE.md's PDF-export entry (`renderer.domElement.
  // toDataURL()` needs it there) — it just never got copied to this
  // renderer (or graphicPreviewRenderer's, fixed alongside it) when they
  // were added later. Also added disposal of the previous renderer/
  // controls before building new ones — real GPU/context hygiene this
  // was missing regardless (every Add/Edit open built a fresh WebGL
  // context with no cleanup of the last one), even though it turned out
  // not to be this particular bug's cause.
  casesTraysRenderer?.dispose();
  casesTraysControls?.dispose();

  casesTraysScene = new THREE.Scene();
  casesTraysScene.background = new THREE.Color(0xdcdcdc);
  casesTraysCamera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  casesTraysRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.innerHTML = "";
  container.appendChild(casesTraysRenderer.domElement);
  casesTraysControls = new OrbitControls(casesTraysCamera, casesTraysRenderer.domElement);
  addZoomControls(container, casesTraysCamera, casesTraysControls);
  casesTraysScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(300, 400, 300);
  casesTraysScene.add(dirLight);
  casesTraysBoxGroup = new THREE.Group();
  casesTraysScene.add(casesTraysBoxGroup);

  const w = container.clientWidth || 300;
  const h = container.clientHeight || 220;
  casesTraysRenderer.setSize(w, h);
  casesTraysCamera.aspect = w / h;
  casesTraysCamera.updateProjectionMatrix();

  const loop = () => {
    if (!container.isConnected) return; // form closed — stop looping
    requestAnimationFrame(loop);
    syncPreviewSize(container, casesTraysRenderer, casesTraysCamera);
    casesTraysControls.update();
    casesTraysRenderer.render(casesTraysScene, casesTraysCamera);
  };
  loop();
}
// odLmm/odWmm/odHmm/idLmm/idWmm/idHmm are always canonical mm regardless
// of the form's current Units of Measure — the preview's own geometry
// doesn't care which unit the user is typing in. OD renders as a solid
// translucent box (the real palletized footprint); ID as a wireframe
// nested inside it (the usable fill space) whenever it's meaningfully
// smaller than OD, i.e. there's a wall to actually show.
function renderCasesTraysPreview(odLmm, odWmm, odHmm, idLmm, idWmm, idHmm) {
  if (!casesTraysBoxGroup) return;
  casesTraysBoxGroup.clear();
  const odL = Math.max(odLmm, 1);
  const odW = Math.max(odWmm, 1);
  const odH = Math.max(odHmm, 1);

  const odGeo = new THREE.BoxGeometry(odL, odH, odW);
  // polygonOffset: same coincident face-vs-edges z-fighting fix as the
  // main pallet view's own POLYGON_OFFSET (renderBoxes) — odEdges below
  // sits at this exact same position.
  const odMat = new THREE.MeshStandardMaterial({ color: 0xc9a876, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const odMesh = new THREE.Mesh(odGeo, odMat);
  casesTraysBoxGroup.add(odMesh);
  const odEdges = new THREE.LineSegments(new THREE.EdgesGeometry(odGeo), new THREE.LineBasicMaterial({ color: 0x6b4a2b }));
  casesTraysBoxGroup.add(odEdges);

  if (idLmm > 0 && idWmm > 0 && idHmm > 0 && (idLmm < odL || idWmm < odW || idHmm < odH)) {
    const idGeo = new THREE.BoxGeometry(idLmm, idHmm, idWmm);
    const idEdges = new THREE.LineSegments(new THREE.EdgesGeometry(idGeo), new THREE.LineBasicMaterial({ color: 0x2563eb }));
    casesTraysBoxGroup.add(idEdges);
  }

  const maxDim = Math.max(odL, odW, odH, 10);
  casesTraysCamera.position.set(maxDim * 1.3, maxDim * 1.1, maxDim * 1.3);
  casesTraysControls.target.set(0, 0, 0);
  casesTraysControls.update();
}

function updateCasesTraysConditionalFields() {
  const mode = $("ct-dimensionmode").value;
  const isInside = mode === "inside";
  $("ct-thickness-row").style.display = isInside ? "grid" : "none";
  $("ct-numthick-block").style.display = isInside ? "block" : "none";
  for (const id of ["ct-od-length", "ct-od-width", "ct-od-height"]) {
    $(id).disabled = isInside;
    $(id).style.background = isInside ? "#f4f4f5" : "";
  }
  const isTray = casesTraysPackCategory($("ct-packtype").value) === "Tray";
  $("ct-traywallheight-row").style.display = isTray ? "block" : "none";
  updateCasesTraysComputedFields();
}
function updateCasesTraysComputedFields() {
  const units = $("ct-units").value === "imperial" ? "imperial" : "metric";
  const idL = num("ct-id-length");
  const idW = num("ct-id-width");
  const idH = num("ct-id-height");
  const idLmm = UNIT_KINDS.length.toCanonical(idL, units);
  const idWmm = UNIT_KINDS.length.toCanonical(idW, units);
  const idHmm = UNIT_KINDS.length.toCanonical(idH, units);
  const volume = units === "imperial" ? idL * idW * idH : (idLmm * idWmm * idHmm) / 1000;
  $("ct-volume").textContent = `${roundTo(volume, 3)} ${units === "imperial" ? "in³" : "cm³"}`;

  if ($("ct-dimensionmode").value === "inside") {
    const thickness = num("ct-thickness");
    $("ct-od-length").value = roundTo(idL + thickness * num("ct-numthick-length"), 4);
    $("ct-od-width").value = roundTo(idW + thickness * num("ct-numthick-width"), 4);
    $("ct-od-height").value = roundTo(idH + thickness * num("ct-numthick-height"), 4);
  }
  const odLmm = UNIT_KINDS.length.toCanonical(num("ct-od-length"), units);
  const odWmm = UNIT_KINDS.length.toCanonical(num("ct-od-width"), units);
  const odHmm = UNIT_KINDS.length.toCanonical(num("ct-od-height"), units);
  renderCasesTraysPreview(odLmm, odWmm, odHmm, idLmm, idWmm, idHmm);
}

// Builds the Add/Edit form's own rich fields into #library-form-fields
// (the SAME container showLibraryForm uses for every other type) —
// openLibrary special-cases type==="stock-cases" to call this instead of
// showLibraryForm (see that comment). Rebuilt as plain HTML each time
// (rather than static markup with fixed ids) since #library-form-fields
// is shared/emptied by every other type's own form too.
function openCasesTraysForm(existingItem, onSaved) {
  const container = $("library-form-fields");
  container.innerHTML = `
    <label>Pack Name *</label>
    <input id="ct-name" type="text" />

    <label style="margin-top:10px">Pack Type *</label>
    <button id="ct-open-packtype-library" type="button" class="secondary">Select From Library</button>
    <div class="row" style="margin-top:6px">
      <div><input id="ct-packtype" type="text" readonly style="background:#f4f4f5" /></div>
      <div></div>
    </div>

    <div class="row" style="margin-top:10px">
      <div>
        <label>Units of Measure *</label>
        <select id="ct-units">
          <option value="metric">Metric (mm/kg)</option>
          <option value="imperial">Imperial (in/lb)</option>
        </select>
      </div>
      <div>
        <label>Dimension Mode *</label>
        <select id="ct-dimensionmode">
          <option value="inside">Inside</option>
          <option value="manual">Manual</option>
        </select>
      </div>
    </div>

    <div id="ct-thickness-row" class="row" style="margin-top:10px">
      <div><label id="ct-thickness-label">Thickness</label><input id="ct-thickness" type="number" step="any" min="0" value="0" /></div>
      <div></div>
    </div>

    <label style="margin-top:12px">Case/Tray (ID) *</label>
    <div class="row">
      <div><label id="ct-id-l-label">Length</label><input id="ct-id-length" type="number" step="any" min="0" value="0" /></div>
      <div><label id="ct-id-w-label">Width</label><input id="ct-id-width" type="number" step="any" min="0" value="0" /></div>
      <div><label id="ct-id-h-label">Height</label><input id="ct-id-height" type="number" step="any" min="0" value="0" /></div>
    </div>

    <div id="ct-numthick-block">
      <label style="margin-top:10px">Number of Thicknesses</label>
      <div class="row">
        <div><input id="ct-numthick-length" type="number" step="any" min="0" value="2" /></div>
        <div><input id="ct-numthick-width" type="number" step="any" min="0" value="2" /></div>
        <div><input id="ct-numthick-height" type="number" step="any" min="0" value="4" /></div>
      </div>
    </div>

    <label style="margin-top:12px">Case/Tray (OD) *</label>
    <div class="row">
      <div><label id="ct-od-l-label">Length</label><input id="ct-od-length" type="number" step="any" min="0" value="0" /></div>
      <div><label id="ct-od-w-label">Width</label><input id="ct-od-width" type="number" step="any" min="0" value="0" /></div>
      <div><label id="ct-od-h-label">Height</label><input id="ct-od-height" type="number" step="any" min="0" value="0" /></div>
    </div>

    <p style="font-size:12px;margin:10px 0 0">Volume (ID): <strong id="ct-volume">0.000 cm³</strong></p>

    <div id="ct-traywallheight-row" style="display:none">
      <label style="margin-top:10px">Tray Wall Height</label>
      <input id="ct-traywallheight" type="number" step="any" min="0" value="0" />
    </div>

    <div class="row" style="margin-top:10px">
      <div><label id="ct-matweight-label">Material Weight</label><input id="ct-matweight" type="number" step="any" min="0" value="0" /></div>
      <div><label id="ct-maxweight-label">Max Weight (optional - this app's own addition, for Fill a Stock Case's weight cap)</label><input id="ct-maxweight" type="number" step="any" min="0" /></div>
    </div>

    <label style="margin-top:10px">3D Preview</label>
    <div id="ct-3d-preview" style="width:100%;height:220px;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:4px"></div>
    <p style="font-size:11px;color:var(--muted);margin:4px 0 0">Tan (solid) = Outside dimensions, the palletized footprint. Blue (wireframe) = Inside dimensions, the usable fill space.</p>

    <label style="margin-top:10px">Note (optional)</label>
    <input id="ct-note" type="text" />
  `;

  const units = settings.units === "imperial" ? "imperial" : "metric";
  $("ct-units").value = units;
  $("ct-name").value = existingItem?.name ?? "";
  $("ct-packtype").value = existingItem?.packType ?? "RSC";
  $("ct-dimensionmode").value = existingItem?.dimensionMode ?? "inside";
  $("ct-thickness").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.thickness ?? 0, units), 4) : 0;
  $("ct-id-length").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.idLength ?? 0, units), 4) : 0;
  $("ct-id-width").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.idWidth ?? 0, units), 4) : 0;
  $("ct-id-height").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.idHeight ?? 0, units), 4) : 0;
  $("ct-numthick-length").value = existingItem?.numThicknessesLength ?? 2;
  $("ct-numthick-width").value = existingItem?.numThicknessesWidth ?? 2;
  $("ct-numthick-height").value = existingItem?.numThicknessesHeight ?? 4;
  $("ct-od-length").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.odLength ?? 0, units), 4) : 0;
  $("ct-od-width").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.odWidth ?? 0, units), 4) : 0;
  $("ct-od-height").value = existingItem ? roundTo(unitKindToDisplay("length", existingItem.odHeight ?? 0, units), 4) : 0;
  $("ct-traywallheight").value =
    existingItem?.trayWallHeight != null ? roundTo(unitKindToDisplay("length", existingItem.trayWallHeight, units), 4) : 0;
  $("ct-matweight").value = existingItem ? roundTo(unitKindToDisplay("weight", existingItem.weight ?? 0, units), 4) : 0;
  $("ct-maxweight").value =
    existingItem?.maxWeight !== undefined ? roundTo(unitKindToDisplay("weight", existingItem.maxWeight, units), 4) : "";
  $("ct-note").value = existingItem?.note ?? "";

  const lengthSuffix = units === "imperial" ? "in" : "mm";
  const weightSuffix = units === "imperial" ? "lb" : "kg";
  $("ct-thickness-label").textContent = `Thickness (${lengthSuffix})`;
  $("ct-id-l-label").textContent = `Length (${lengthSuffix})`;
  $("ct-id-w-label").textContent = `Width (${lengthSuffix})`;
  $("ct-id-h-label").textContent = `Height (${lengthSuffix})`;
  $("ct-od-l-label").textContent = `Length (${lengthSuffix})`;
  $("ct-od-w-label").textContent = `Width (${lengthSuffix})`;
  $("ct-od-h-label").textContent = `Height (${lengthSuffix})`;
  $("ct-matweight-label").textContent = `Material Weight (${weightSuffix})`;

  for (const id of [
    "ct-id-length",
    "ct-id-width",
    "ct-id-height",
    "ct-thickness",
    "ct-numthick-length",
    "ct-numthick-width",
    "ct-numthick-height",
    "ct-od-length",
    "ct-od-width",
    "ct-od-height",
  ]) {
    $(id).addEventListener("input", updateCasesTraysComputedFields);
  }
  $("ct-dimensionmode").addEventListener("change", updateCasesTraysConditionalFields);
  // No "input" listener on ct-packtype itself — it's read-only now (user:
  // "pack type is is not editable in its name"), only ever changed via
  // applyPackTypeToCaseTray below, which already calls
  // updateCasesTraysConditionalFields() directly at its own end.
  $("ct-open-packtype-library").addEventListener("click", () => {
    openPackTypeModal(applyPackTypeToCaseTray, () => $("ct-packtype").value.trim());
  });
  // Units of Measure is an entry-time convenience only (same as pallets/
  // trucks' own Units toggle) — converts whatever's currently shown into
  // the newly-picked unit so the NUMBERS stay physically the same, then
  // relabels. Canonical storage stays mm/kg regardless (see save handler).
  $("ct-units").addEventListener("change", () => {
    const toUnits = $("ct-units").value === "imperial" ? "imperial" : "metric";
    const fromUnits = toUnits === "imperial" ? "metric" : "imperial";
    for (const id of [
      "ct-thickness",
      "ct-id-length",
      "ct-id-width",
      "ct-id-height",
      "ct-od-length",
      "ct-od-width",
      "ct-od-height",
      "ct-traywallheight",
    ]) {
      const canonical = UNIT_KINDS.length.toCanonical(num(id), fromUnits);
      $(id).value = roundTo(UNIT_KINDS.length.toDisplay(canonical, toUnits), 4);
    }
    for (const id of ["ct-matweight", "ct-maxweight"]) {
      if ($(id).value === "") continue;
      const canonical = UNIT_KINDS.weight.toCanonical(num(id), fromUnits);
      $(id).value = roundTo(UNIT_KINDS.weight.toDisplay(canonical, toUnits), 4);
    }
    const suffix = toUnits === "imperial" ? "in" : "mm";
    const wSuffix = toUnits === "imperial" ? "lb" : "kg";
    $("ct-thickness-label").textContent = `Thickness (${suffix})`;
    $("ct-id-l-label").textContent = `Length (${suffix})`;
    $("ct-id-w-label").textContent = `Width (${suffix})`;
    $("ct-id-h-label").textContent = `Height (${suffix})`;
    $("ct-od-l-label").textContent = `Length (${suffix})`;
    $("ct-od-w-label").textContent = `Width (${suffix})`;
    $("ct-od-h-label").textContent = `Height (${suffix})`;
    $("ct-matweight-label").textContent = `Material Weight (${wSuffix})`;
    updateCasesTraysComputedFields();
  });

  updateCasesTraysConditionalFields();
  ensureCasesTraysScene($("ct-3d-preview"));
  updateCasesTraysComputedFields();

  $("library-form-view").style.display = "block";
  $("library-grid-view").style.display = "none";

  $("library-form-save").onclick = async () => {
    if (!$("ct-name").value.trim()) {
      alert("Pack Name is required.");
      return;
    }
    const saveUnits = $("ct-units").value === "imperial" ? "imperial" : "metric";
    const len = (id) => UNIT_KINDS.length.toCanonical(num(id), saveUnits);
    const wt = (id) => UNIT_KINDS.weight.toCanonical(num(id), saveUnits);
    const data = {
      name: $("ct-name").value.trim(),
      category: "Stock Case Example",
      packType: $("ct-packtype").value.trim() || "RSC",
      dimensionMode: $("ct-dimensionmode").value,
      thickness: len("ct-thickness"),
      idLength: len("ct-id-length"),
      idWidth: len("ct-id-width"),
      idHeight: len("ct-id-height"),
      numThicknessesLength: num("ct-numthick-length"),
      numThicknessesWidth: num("ct-numthick-width"),
      numThicknessesHeight: num("ct-numthick-height"),
      odLength: len("ct-od-length"),
      odWidth: len("ct-od-width"),
      odHeight: len("ct-od-height"),
      trayWallHeight: casesTraysPackCategory($("ct-packtype").value) === "Tray" ? len("ct-traywallheight") : null,
      weight: wt("ct-matweight"),
      maxWeight: $("ct-maxweight").value.trim() === "" ? undefined : wt("ct-maxweight"),
      note: $("ct-note").value.trim(),
      icon: "icons/box.svg",
    };
    if (existingItem) {
      await fetch(`${API_BASE}/api/library/stock-cases/${existingItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } else {
      await fetch(`${API_BASE}/api/library/stock-cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    $("library-form-view").style.display = "none";
    $("library-grid-view").style.display = "flex";
    onSaved();
  };
  $("library-form-cancel").onclick = () => {
    $("library-form-view").style.display = "none";
    $("library-grid-view").style.display = "flex";
  };
}

$("set-open-board-library").addEventListener("click", () => {
  openLibrary(
    "board-grades",
    "Select Default Board Grade",
    (item) => {
      $("set-ect").value = roundTo(ectLbInToDisplay(item.ectRc, settings.units), 4);
      $("set-cal").value = roundTo(caliperMilsToDisplay(item.caliperIn * 1000, settings.units), 4);
      markSelected("set-sel-board", item.name, {
        itemId: item.id,
        onClear: () => {
          $("set-ect").value = roundTo(ectLbInToDisplay(40, settings.units), 4);
          $("set-cal").value = roundTo(caliperMilsToDisplay(40, settings.units), 4);
        },
      });
    },
    "set-sel-board"
  );
});

$("set-open-casetype-library").addEventListener("click", () => {
  openLibrary(
    "case-configurations",
    "Select Default Case Type",
    (item) => {
      $("set-casetype").value = item.caseTypeFactor;
      markSelected("set-sel-casetype", `${item.name} (${item.caseTypeFactor}×)`, {
        itemId: item.id,
        onClear: () => {
          $("set-casetype").value = 1;
        },
      });
    },
    "set-sel-casetype"
  );
});

wireFactorLibraryPicker("set-open-printing-library", "printing-factors", "Select Default Printing", "set-printing", "set-sel-printing");
wireFactorLibraryPicker("set-open-fluting-library", "fluting-orientation-factors", "Select Default Fluting Orientation", "set-fluting", "set-sel-fluting");

// Partition default: real screen's own three-way choice (No Partition /
// Partition Type / Custom Partition), confirmed against partition-
// factors.json's own "Name is the number of dividers/partitions" note —
// the real screen's "Partition Type 6 / 50%" and "Custom Partition 3 L x 2
// W" shown together in the same export is 3×2=6, i.e. Custom Partition is
// just an alternate way to land on the same Type/factor, not a separate
// database. All three modes ultimately just write a plain factor into
// set-partition, same field Case Type/Printing/Fluting already use.
function setPartitionModeUi(factorValue) {
  const mode = Number(factorValue) === 1 ? "none" : "type";
  for (const el of document.getElementsByName("set-partition-mode")) el.checked = el.value === mode;
  $("set-partition-type-controls").style.display = mode === "type" ? "block" : "none";
  $("set-partition-custom-controls").style.display = "none";
}
for (const el of document.getElementsByName("set-partition-mode")) {
  el.addEventListener("change", () => {
    const mode = el.value;
    $("set-partition-type-controls").style.display = mode === "type" ? "block" : "none";
    $("set-partition-custom-controls").style.display = mode === "custom" ? "block" : "none";
    if (mode === "none") {
      $("set-partition").value = 1;
      delete selectedLibraryItemIds["set-sel-partition"];
      $("set-sel-partition").innerHTML = "";
      $("set-sel-partition").style.display = "none";
    }
  });
}
$("set-open-partition-library").addEventListener("click", () => {
  openLibrary(
    "partition-factors",
    "Select Default Partition Type",
    (item) => {
      $("set-partition").value = item.factor;
      markSelected("set-sel-partition", `Type ${item.name} (${Math.round(item.factor * 100)}%)`, {
        itemId: item.id,
        onClear: () => {
          $("set-partition").value = 1;
        },
      });
    },
    "set-sel-partition"
  );
});
$("set-partition-custom-apply").addEventListener("click", async () => {
  const type = Math.round(num("set-partition-l") * num("set-partition-w"));
  const res = await fetch(`${API_BASE}/api/library/partition-factors`);
  const items = (await res.json()).items;
  const match = items.find((i) => Number(i.name) === type);
  if (match) {
    $("set-partition").value = match.factor;
    $("set-partition-custom-status").textContent = `✓ ${type} dividers → Partition Type ${match.name} (${Math.round(match.factor * 100)}%)`;
  } else {
    $("set-partition-custom-status").textContent = `No Partition Factor entry for ${type} dividers (have Types 1–${items.length}) - enter Partition × manually below.`;
  }
});

// Pushes the saved defaults into the Report step's own Compression Strength
// fields — called once at load and again right after Save Defaults, so a
// fresh analysis always starts from your defaults instead of the app's
// hardcoded fallbacks (40/40/1/0/0 and "no adjustment" environment), while
// still being freely editable per-analysis exactly like CapePack's own
// "you can modify any of the environmental factors you wish" model.
function applyStrengthDefaults() {
  updateStrengthUnitLabels();
  $("r-ect").value = roundTo(ectLbInToDisplay(settings.strengthEct), 4);
  $("r-cal").value = roundTo(caliperMilsToDisplay(settings.strengthCaliper), 4);
  $("r-casetype").value = settings.strengthCaseType;
  $("r-printing").value = settings.strengthPrinting;
  $("r-fluting").value = settings.strengthFluting;
  $("r-partition").value = settings.strengthPartition;
  $("r-production").value = settings.strengthProductionPct;
  $("r-seasonal").value = settings.strengthSeasonalPct;
  $("se-humidity").value = settings.strengthHumidity;
  $("se-days").value = settings.strengthDays;
  $("se-orientation").value = settings.strengthOrientation;
  $("se-stacking").value = settings.strengthStacking;
  $("se-overhang").value = settings.strengthOverhang;
  $("se-surface").value = settings.strengthSurface;
  $("r-internalsupport").value = roundTo(weightLbToDisplay(settings.strengthInternalSupportLb), 2);
  $("r-palletsstacked").value = settings.strengthPalletsStacked;
  $("r-safetymargin-enabled").checked = settings.strengthSafetyMarginEnabled;
  $("r-safetymargin-pct").value = settings.strengthSafetyMarginRequiredPct;
  computeAndApplyStorageEnvironment(); // matches CapePack: "Strength...automatically calculated based on the default Environmental Factors"
}

$("strength-defaults-save").addEventListener("click", () => {
  settings = {
    ...settings,
    strengthEct: ectDisplayToLbIn(num("set-ect"), settings.units),
    strengthCaliper: caliperDisplayToMils(num("set-cal"), settings.units),
    strengthCaseType: num("set-casetype"),
    strengthPrinting: num("set-printing"),
    strengthFluting: num("set-fluting"),
    strengthPartition: num("set-partition"),
    strengthInternalSupportLb: weightDisplayToLb(num("set-internalsupport"), settings.units),
    strengthPalletsStacked: num("set-palletsstacked"),
    strengthSafetyMarginEnabled: $("set-safetymargin-enabled").checked,
    strengthSafetyMarginRequiredPct: num("set-safetymargin-pct"),
    strengthProductionPct: num("set-production"),
    strengthSeasonalPct: num("set-seasonal"),
    strengthHumidity: num("set-humidity"),
    strengthDays: num("set-days"),
    strengthOrientation: $("set-orientation").value,
    strengthStacking: $("set-stacking").value,
    strengthOverhang: num("set-overhang"),
    strengthSurface: $("set-surface").value,
  };
  persistSettings();
  applyStrengthDefaults();
  $("strength-defaults-status").textContent = "Saved.";
});

applyStrengthDefaults();
updateCustomFormulaToggle();
loadStorageEnvironmentFactors();
loadEfficiencyFactors();
loadKdfFormulae();
goToStep("new");
animate();
