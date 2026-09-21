/**
 * Guillotine-split (block) pattern: fill the pallet with a primary column
 * grid in orientation (l, w), then fill the leftover strip along the split
 * axis with boxes rotated 90°. Recovers the space a pure column pattern
 * wastes when the pallet dimension isn't a clean multiple of the box.
 *
 * Tries both split axes and returns the better of the two, with explicit
 * per-box positions for rendering.
 */
export function guillotineSplitPattern(l, w, palletLength, palletWidth) {
  const splitAlongLength = (() => {
    const mainCountL = Math.floor(palletLength / l);
    const usedLength = mainCountL * l;
    const mainCountW = Math.floor(palletWidth / w);

    const leftoverLength = palletLength - usedLength;
    const leftoverCountL = Math.floor(leftoverLength / w);
    const leftoverCountW = Math.floor(palletWidth / l);

    const positions = [];
    for (let i = 0; i < mainCountL; i++) {
      for (let j = 0; j < mainCountW; j++) {
        positions.push({ x: i * l, y: j * w, l, w, rotated: false, checker: (i + j) % 2 });
      }
    }
    for (let i = 0; i < leftoverCountL; i++) {
      for (let j = 0; j < leftoverCountW; j++) {
        // rotated footprint: w along the split axis, l across it
        positions.push({ x: usedLength + i * w, y: j * l, l: w, w: l, rotated: true, checker: (i + j) % 2 });
      }
    }

    const count = positions.length;
    return {
      strategy: "guillotine-split-length",
      l,
      w,
      count,
      areaEfficiency: (count * l * w) / (palletLength * palletWidth),
      positions,
    };
  })();

  const splitAlongWidth = (() => {
    const mainCountW = Math.floor(palletWidth / w);
    const usedWidth = mainCountW * w;
    const mainCountL = Math.floor(palletLength / l);

    const leftoverWidth = palletWidth - usedWidth;
    const leftoverCountW = Math.floor(leftoverWidth / l);
    const leftoverCountL = Math.floor(palletLength / w);

    const positions = [];
    for (let i = 0; i < mainCountL; i++) {
      for (let j = 0; j < mainCountW; j++) {
        positions.push({ x: i * l, y: j * w, l, w, rotated: false, checker: (i + j) % 2 });
      }
    }
    for (let i = 0; i < leftoverCountL; i++) {
      for (let j = 0; j < leftoverCountW; j++) {
        // rotated footprint: l along the split axis, w across it
        positions.push({ x: i * w, y: usedWidth + j * l, l: w, w: l, rotated: true, checker: (i + j) % 2 });
      }
    }

    const count = positions.length;
    return {
      strategy: "guillotine-split-width",
      l,
      w,
      count,
      areaEfficiency: (count * l * w) / (palletLength * palletWidth),
      positions,
    };
  })();

  return splitAlongLength.count >= splitAlongWidth.count
    ? splitAlongLength
    : splitAlongWidth;
}
