# @simpallet/library

Reference data for the "Select From Library" pattern CapePack uses throughout
(Pallet/Truck Type Library, Pack Type Library) — plain JSON + original SVG
icons, no build step.

## Sources

- **`pallets.json`** — EUR/EPAL and EUR2 dimensions from EN 13698-1; US GMA
  from the standard 48"×40" footprint. These are public industry standards,
  not CapePack-specific data. `maxWeight` figures are commonly cited typical
  values (see each entry's `note`) — real capacity depends on the specific
  pallet's construction and should be confirmed against actual equipment
  before being trusted for a real load plan.
- **`trucks.json`** — 20ft / 40ft / 40ft High Cube container interior
  dimensions from ISO 668. Same caveat: treat as typical/representative, not
  a substitute for the actual container spec sheet.
- **`shapes.json`** — the pack-shape categories CapePack exposes (box,
  cylinder, trapezoid). `engineSupport` is honest about what
  `packing-engine` actually implements today — only `box` has real layer-
  pattern math behind it; cylinder/trapezoid are listed for the UI/roadmap
  but not yet computed.
- **`icons/*.svg`** — original, hand-authored icons for this project (simple
  isometric line art), not sourced from CapePack or any other product.

## Shape

Each entry in `pallets.json` / `trucks.json` matches the `pallet` object
shape `packing-engine`'s `optimizePallet`/`optimizeCase` expect, so a
library entry can be spread directly into the engine call. `icon` paths are
relative to this package's root.
