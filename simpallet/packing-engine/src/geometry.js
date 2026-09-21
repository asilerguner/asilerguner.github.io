/**
 * Box: { length, width, height, weight, allowedVertical? }
 * allowedVertical restricts which of the box's original dimensions may be
 * placed vertically (mirrors CapePack's "Dimension Vertical" input) — omit
 * to allow all three.
 */

const AXES = ["length", "width", "height"];

export function boxVolume(box) {
  return box.length * box.width * box.height;
}

export function perimeter(l, w) {
  return 2 * (l + w);
}

/**
 * Enumerate valid orientations of a box: which original dimension is
 * vertical (h), and the two ways the remaining pair can be assigned to the
 * footprint (l, w). Up to 6 orientations, fewer if allowedVertical is set.
 */
export function getOrientations(box, allowedVertical = AXES) {
  const dims = { length: box.length, width: box.width, height: box.height };
  const orientations = [];

  for (const vertical of allowedVertical) {
    const others = AXES.filter((a) => a !== vertical);
    const [a, b] = others;
    orientations.push({ vertical, h: dims[vertical], l: dims[a], w: dims[b] });
    orientations.push({ vertical, h: dims[vertical], l: dims[b], w: dims[a] });
  }

  return orientations;
}
