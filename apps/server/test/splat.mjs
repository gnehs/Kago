import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { readSplats } from "../src/lib/splat-decode.ts";
import { renderSplats } from "../src/lib/splat-render.ts";

const SH_C0 = 0.28209479177387814;

/** Two splats as the files below hold them: one plain, one turned about Z, half see-through and stretched. */
const SPLATS = [
  { position: [0.5, -0.25, -2], scale: [0.1, 0.2, 0.05], rotation: [1, 0, 0, 0], color: [0.8, 0.2, 0.4], alpha: 0.9 },
  { position: [-1, 2, 3], scale: [0.3, 0.01, 0.02], rotation: [0.6, 0, 0, 0.8], color: [0.1, 0.6, 0.9], alpha: 0.5 }
];

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-splat-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ply(splats, { properties, header = "" } = {}) {
  const fields = properties ?? ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "extra"];
  const head = `ply\nformat binary_little_endian 1.0\n${header}element vertex ${splats.length}\n${fields.map((field) => `property ${field === "extra" ? "double" : "float"} ${field}\n`).join("")}end_header\n`;
  const stride = fields.reduce((sum, field) => sum + (field === "extra" ? 8 : 4), 0);
  const body = Buffer.alloc(splats.length * stride);
  splats.forEach((splat, index) => {
    const values = {
      x: splat.position[0], y: splat.position[1], z: splat.position[2],
      f_dc_0: (splat.color[0] - 0.5) / SH_C0, f_dc_1: (splat.color[1] - 0.5) / SH_C0, f_dc_2: (splat.color[2] - 0.5) / SH_C0,
      opacity: Math.log(splat.alpha / (1 - splat.alpha)),
      scale_0: Math.log(splat.scale[0]), scale_1: Math.log(splat.scale[1]), scale_2: Math.log(splat.scale[2]),
      rot_0: splat.rotation[0] * 2, rot_1: splat.rotation[1] * 2, rot_2: splat.rotation[2] * 2, rot_3: splat.rotation[3] * 2
    };
    let at = index * stride;
    for (const field of fields) {
      if (field === "extra") {
        body.writeDoubleLE(42, at);
        at += 8;
      } else {
        body.writeFloatLE(values[field] ?? 0, at);
        at += 4;
      }
    }
  });
  return Buffer.concat([Buffer.from(head, "latin1"), body]);
}

function legacySplat(splats) {
  const body = Buffer.alloc(splats.length * 32);
  splats.forEach((splat, index) => {
    const at = index * 32;
    splat.position.forEach((value, axis) => body.writeFloatLE(value, at + axis * 4));
    splat.scale.forEach((value, axis) => body.writeFloatLE(value, at + 12 + axis * 4));
    [...splat.color, splat.alpha].forEach((value, part) => (body[at + 24 + part] = Math.round(value * 255)));
    splat.rotation.forEach((value, part) => (body[at + 28 + part] = Math.min(255, Math.round(value * 128 + 128))));
  });
  return body;
}

/** A bundled SOG of the splats above, written the way splat-transform writes version 2. */
async function sog(splats) {
  const codebook = Array.from({ length: 256 }, (_, index) => (index - 128) / 24);
  const nearest = (value) => codebook.reduce((best, entry, index) => (Math.abs(entry - value) < Math.abs(codebook[best] - value) ? index : best), 0);
  const mins = [-2, -2, -2];
  const maxs = [2, 2, 2];
  const pixels = (fill) => {
    const data = Buffer.alloc(splats.length * 4, 255);
    splats.forEach((splat, index) => fill(splat, data.subarray(index * 4, index * 4 + 4)));
    return data;
  };
  const means = splats.map((splat) => splat.position.map((value, axis) => Math.round(((Math.sign(value) * Math.log(Math.abs(value) + 1) - mins[axis]) / (maxs[axis] - mins[axis])) * 65535)));
  const images = {
    "means_l.webp": pixels((splat, out) => means[splats.indexOf(splat)].forEach((value, axis) => (out[axis] = value & 0xff))),
    "means_u.webp": pixels((splat, out) => means[splats.indexOf(splat)].forEach((value, axis) => (out[axis] = value >> 8))),
    "quats.webp": pixels((splat, out) => {
      const [w, x, y, z] = splat.rotation;
      // The largest part is left out and made up again: w for the first splat, z for the second.
      const largest = splat.rotation.indexOf(Math.max(...splat.rotation.map(Math.abs)));
      const kept = largest === 0 ? [x, y, z] : [w, x, y];
      kept.forEach((value, part) => (out[part] = Math.round((value / Math.SQRT2 + 0.5) * 255)));
      out[3] = 252 + (largest === 0 ? 0 : 3);
    }),
    "scales.webp": pixels((splat, out) => splat.scale.forEach((value, axis) => (out[axis] = nearest(Math.log(value))))),
    "sh0.webp": pixels((splat, out) => {
      splat.color.forEach((value, part) => (out[part] = nearest((value - 0.5) / SH_C0)));
      out[3] = Math.round(splat.alpha * 255);
    })
  };
  const zip = new AdmZip();
  const meta = {
    version: 2,
    count: splats.length,
    means: { mins, maxs, files: ["means_l.webp", "means_u.webp"] },
    scales: { codebook, files: ["scales.webp"] },
    quats: { files: ["quats.webp"] },
    sh0: { codebook, files: ["sh0.webp"] }
  };
  zip.addFile("meta.json", Buffer.from(JSON.stringify(meta)));
  for (const [name, data] of Object.entries(images)) {
    zip.addFile(name, await sharp(data, { raw: { width: splats.length, height: 1, channels: 4 } }).webp({ lossless: true, exact: true }).toBuffer());
  }
  return zip.toBuffer();
}

/** `tolerance` is one for every part, or one each. */
function assertNear(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= (Array.isArray(tolerance) ? tolerance[index] : tolerance), `${label}[${index}]: ${value} is not near ${expected[index]}`));
}

function assertSplats(cloud, { tolerance }) {
  assert.equal(cloud.count, SPLATS.length);
  SPLATS.forEach((splat, index) => {
    assertNear(cloud.positions.subarray(index * 3, index * 3 + 3), splat.position, tolerance.position, `position ${index}`);
    assertNear(cloud.scales.subarray(index * 3, index * 3 + 3), splat.scale, splat.scale.map((value) => value * tolerance.scale), `scale ${index}`);
    assertNear(cloud.rotations.subarray(index * 4, index * 4 + 4), splat.rotation, tolerance.rotation, `rotation ${index}`);
    assertNear(cloud.colors.subarray(index * 4, index * 4 + 4), [...splat.color, splat.alpha], tolerance.color, `color ${index}`);
  });
}

test("a splat PLY is read as it was trained: colour from its first coefficient, opacity through a sigmoid, scale through exp", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "scene.ply");
    await writeFile(file, ply(SPLATS));
    assertSplats(await readSplats(file, 1000), { tolerance: { position: 1e-6, scale: 1e-5, rotation: 1e-6, color: 1e-5 } });
  });
});

test("a .splat file is read as drawn: linear scales, colour and rotation a byte each", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "scene.splat");
    await writeFile(file, legacySplat(SPLATS));
    assertSplats(await readSplats(file, 1000), { tolerance: { position: 1e-6, scale: 1e-5, rotation: 0.01, color: 0.003 } });
  });
});

test("a SOG is read the way PlayCanvas reads it, whichever part of a rotation was left out", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "scene.sog");
    await writeFile(file, await sog(SPLATS));
    assertSplats(await readSplats(file, 1000), { tolerance: { position: 0.001, scale: 0.03, rotation: 0.01, color: 0.03 } });
  });
});

test("a PLY that is a mesh, an ASCII PLY or a compressed splat PLY has no splats to read", async () => {
  await withDir(async (dir) => {
    const mesh = path.join(dir, "mesh.ply");
    await writeFile(mesh, Buffer.concat([Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n"), Buffer.alloc(12 + 13)]));
    assert.equal(await readSplats(mesh, 1000), null);

    const ascii = path.join(dir, "ascii.ply");
    await writeFile(ascii, ply(SPLATS).toString("latin1").replace("binary_little_endian", "ascii"), "latin1");
    assert.equal(await readSplats(ascii, 1000), null);

    const compressed = path.join(dir, "compressed.ply");
    const chunk = "element chunk 1\nproperty float min_x\nproperty float max_x\n";
    await writeFile(compressed, ply(SPLATS, { header: chunk, properties: ["packed_position", "packed_rotation", "packed_scale", "packed_color"] }));
    assert.equal(await readSplats(compressed, 1000), null);
  });
});

test("a file of more splats than asked for is read in part, its splats drawn larger to close the gaps", async () => {
  await withDir(async (dir) => {
    const many = Array.from({ length: 64 * 50 }, () => SPLATS[0]);
    const file = path.join(dir, "many.splat");
    await writeFile(file, legacySplat(many));
    const cloud = await readSplats(file, 640);
    assert.ok(cloud.count <= 640 && cloud.count >= 320, `${cloud.count} splats kept`);
    assert.ok(cloud.scales[0] > SPLATS[0].scale[0] * 1.2, `scale ${cloud.scales[0]} grew`);
  });
});

test("splats are drawn from the middle of the scene looking along -Z, the file turned half a turn about Z", () => {
  // A red splat ahead and to the file's +x, a blue one ahead and to its -x, and three where the camera will stand, which it does not see.
  const cloud = {
    count: 5,
    positions: new Float32Array([0.5, 0, -2, -0.5, 0, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    scales: new Float32Array(15).fill(0.2),
    rotations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
  };
  const edge = 64;
  const pixels = renderSplats(cloud, edge);
  const at = (x, y) => Array.from(pixels.subarray((y * edge + x) * 4, (y * edge + x) * 4 + 4));
  const centre = edge / 2;
  const offset = Math.round((0.5 / 2) * (centre / Math.tan((85 * Math.PI) / 360)));
  assert.deepEqual(at(centre + offset, centre).slice(0, 3), [0, 0, 255], "the file's -x is drawn on the right");
  assert.deepEqual(at(centre - offset, centre).slice(0, 3), [255, 0, 0], "the file's +x is drawn on the left");
  assert.ok(at(centre + offset, centre)[3] > 200, "a splat seen through its middle is nearly opaque");
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], "where nothing is, the picture is transparent");
});
