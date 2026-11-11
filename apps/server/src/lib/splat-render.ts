import type { SplatCloud } from "./splat-decode.js";

/** The viewer's own field of view, up and down. */
const FOV = (85 * Math.PI) / 180;
/** Splats closer than this to the camera would cover the picture with a blur of whatever it stands in. */
const NEAR = 0.2;
/** Added to every splat's spread on screen, in square pixels, so that one smaller than a pixel still shows as one. */
const LOW_PASS = 0.3;
const MIN_ALPHA = 1 / 255;
const MAX_ALPHA = 0.99;
/** Where a pixel lets less than this through, nothing further back is seen in it. */
const OPAQUE = 1e-4;
const DEPTH_BUCKETS = 65536;

/** Where the preview stands at the start: amid the splats the scene is mostly made of, at the middle of each axis. */
function median(values: Float32Array, axis: number, count: number): number {
  const step = Math.max(1, Math.floor(count / 65536));
  const sample = new Float32Array(Math.ceil(count / step));
  for (let index = 0, at = 0; index < count; index += step) sample[at++] = values[index * 3 + axis]!;
  return sample.sort()[sample.length >> 1]!;
}

/**
 * Draws splats the way the preview opens on them, as a square `edge` pixels a side: from the middle of the scene,
 * looking along -Z with +Y up. The viewer turns the file half a turn about Z, so x and y are drawn reversed.
 * Each splat is a Gaussian laid onto the picture nearest first; what is left transparent is where nothing was.
 * The pixels come out as RGBA, not premultiplied.
 */
export function renderSplats(cloud: SplatCloud, edge: number): Uint8ClampedArray {
  const { count, positions, scales, rotations, colors } = cloud;
  const camera = [-median(positions, 0, count), -median(positions, 1, count), median(positions, 2, count)];
  const focal = edge / 2 / Math.tan(FOV / 2);
  const half = edge / 2;

  // Where each splat lands on screen, how far it is, and the inverse of its spread there.
  const screen = new Float32Array(count * 2);
  const conics = new Float32Array(count * 3);
  const radii = new Uint16Array(count);
  const depths = new Float32Array(count);
  const visible = new Uint32Array(count);
  let shown = 0;
  let nearest = Number.POSITIVE_INFINITY;
  let farthest = 0;
  for (let index = 0; index < count; index++) {
    const alpha = colors[index * 4 + 3]!;
    if (alpha < MIN_ALPHA) continue;
    const x = -positions[index * 3]! - camera[0]!;
    const y = -positions[index * 3 + 1]! - camera[1]!;
    const depth = camera[2]! - positions[index * 3 + 2]!;
    if (depth < NEAR) continue;
    const u = half + (focal * x) / depth;
    const v = half - (focal * y) / depth;

    // The world spread is M Mᵀ with M = F R S, F turning the file half a turn about Z.
    const w = rotations[index * 4]!;
    const qx = rotations[index * 4 + 1]!;
    const qy = rotations[index * 4 + 2]!;
    const qz = rotations[index * 4 + 3]!;
    const sx = scales[index * 3]!;
    const sy = scales[index * 3 + 1]!;
    const sz = scales[index * 3 + 2]!;
    const m00 = -(1 - 2 * (qy * qy + qz * qz)) * sx;
    const m01 = -(2 * (qx * qy - w * qz)) * sy;
    const m02 = -(2 * (qx * qz + w * qy)) * sz;
    const m10 = -(2 * (qx * qy + w * qz)) * sx;
    const m11 = -(1 - 2 * (qx * qx + qz * qz)) * sy;
    const m12 = -(2 * (qy * qz - w * qx)) * sz;
    const m20 = 2 * (qx * qz - w * qy) * sx;
    const m21 = 2 * (qy * qz + w * qx) * sy;
    const m22 = (1 - 2 * (qx * qx + qy * qy)) * sz;

    // The perspective's Jacobian at the splat, for screen coordinates with v running down: J = [[f/d, 0, f x/d²], [0, -f/d, -f y/d²]].
    const j00 = focal / depth;
    const j02 = (focal * x) / (depth * depth);
    const j11 = -focal / depth;
    const j12 = (-focal * y) / (depth * depth);
    // T = J M, whose T Tᵀ is the spread on screen.
    const t00 = j00 * m00 + j02 * m20;
    const t01 = j00 * m01 + j02 * m21;
    const t02 = j00 * m02 + j02 * m22;
    const t10 = j11 * m10 + j12 * m20;
    const t11 = j11 * m11 + j12 * m21;
    const t12 = j11 * m12 + j12 * m22;
    const a = t00 * t00 + t01 * t01 + t02 * t02 + LOW_PASS;
    const b = t00 * t10 + t01 * t11 + t02 * t12;
    const c = t10 * t10 + t11 * t11 + t12 * t12 + LOW_PASS;
    const determinant = a * c - b * b;
    if (!(determinant > 0)) continue;
    const mid = (a + c) / 2;
    const largest = mid + Math.sqrt(Math.max(0.1, mid * mid - determinant));
    // A splat is drawn out to three of its deviations; one spread over more than the whole picture is a blur in front of it.
    const radius = Math.ceil(3 * Math.sqrt(largest));
    if (radius > edge || u + radius < 0 || u - radius >= edge || v + radius < 0 || v - radius >= edge) continue;

    screen[index * 2] = u;
    screen[index * 2 + 1] = v;
    conics[index * 3] = c / determinant;
    conics[index * 3 + 1] = -b / determinant;
    conics[index * 3 + 2] = a / determinant;
    radii[index] = radius;
    depths[index] = depth;
    visible[shown++] = index;
    if (depth < nearest) nearest = depth;
    if (depth > farthest) farthest = depth;
  }

  // Nearest first, by buckets of the logarithm of the distance: splats close to each other in depth may come in either order.
  const order = new Uint32Array(shown);
  if (shown > 0) {
    const low = Math.log(nearest);
    const span = Math.log(farthest) - low || 1;
    const bucketOf = new Uint16Array(shown);
    const starts = new Uint32Array(DEPTH_BUCKETS + 1);
    for (let at = 0; at < shown; at++) {
      const bucket = Math.min(DEPTH_BUCKETS - 1, Math.floor(((Math.log(depths[visible[at]!]!) - low) / span) * DEPTH_BUCKETS));
      bucketOf[at] = bucket;
      starts[bucket + 1]!++;
    }
    for (let bucket = 0; bucket < DEPTH_BUCKETS; bucket++) starts[bucket + 1]! += starts[bucket]!;
    for (let at = 0; at < shown; at++) order[starts[bucketOf[at]!]!++] = visible[at]!;
  }

  const light = new Float32Array(edge * edge * 3);
  const through = new Float32Array(edge * edge).fill(1);
  for (const index of order) {
    const u = screen[index * 2]!;
    const v = screen[index * 2 + 1]!;
    const radius = radii[index]!;
    const ca = conics[index * 3]!;
    const cb = conics[index * 3 + 1]!;
    const cc = conics[index * 3 + 2]!;
    const opacity = colors[index * 4 + 3]!;
    const red = colors[index * 4]!;
    const green = colors[index * 4 + 1]!;
    const blue = colors[index * 4 + 2]!;
    const left = Math.max(0, Math.floor(u - radius));
    const right = Math.min(edge - 1, Math.ceil(u + radius));
    const top = Math.max(0, Math.floor(v - radius));
    const bottom = Math.min(edge - 1, Math.ceil(v + radius));
    for (let py = top; py <= bottom; py++) {
      const dy = py + 0.5 - v;
      const row = py * edge;
      for (let px = left; px <= right; px++) {
        const pixel = row + px;
        const remaining = through[pixel]!;
        if (remaining < OPAQUE) continue;
        const dx = px + 0.5 - u;
        const power = -0.5 * (ca * dx * dx + cc * dy * dy) - cb * dx * dy;
        if (power > 0) continue;
        const alpha = Math.min(MAX_ALPHA, opacity * Math.exp(power));
        if (alpha < MIN_ALPHA) continue;
        const weight = remaining * alpha;
        light[pixel * 3]! += weight * red;
        light[pixel * 3 + 1]! += weight * green;
        light[pixel * 3 + 2]! += weight * blue;
        through[pixel] = remaining * (1 - alpha);
      }
    }
  }

  const pixels = new Uint8ClampedArray(edge * edge * 4);
  for (let pixel = 0; pixel < edge * edge; pixel++) {
    const covered = 1 - through[pixel]!;
    if (covered <= 0) continue;
    pixels[pixel * 4] = (light[pixel * 3]! / covered) * 255;
    pixels[pixel * 4 + 1] = (light[pixel * 3 + 1]! / covered) * 255;
    pixels[pixel * 4 + 2] = (light[pixel * 3 + 2]! / covered) * 255;
    pixels[pixel * 4 + 3] = covered * 255;
  }
  return pixels;
}
