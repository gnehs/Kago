import { createViewer, type ViewerHandle } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import "@playcanvas/supersplat-viewer/viewer.css";
import { Vec3, type Entity } from "playcanvas";
import type { Kago } from "@kago/plugin-sdk";

export type SplatMode = "orbit" | "fly";
/** `mode` is null while the camera is on neither: before the scene is drawn, or while the viewer's own turntable plays. */
export type SceneState = { loaded: boolean; progress: number; mode: SplatMode | null; touch: boolean };
export type Scene = { setMode: (mode: SplatMode) => void; frame: () => void; reset: () => void; setSpeed: (speed: number) => void; destroy: () => void };

/** Why a scene could not be shown: a PLY that holds something else, or a file the viewer could not read. */
export type SceneError = "not-splat" | "unreadable";

/** A PLY file may just as well be a mesh or a point cloud; a splat's header names what only a splat has. */
async function isSplatPly(kago: Kago) {
  return /\b(f_dc_0|packed_position)\b/.test(new TextDecoder().decode(await kago.read(0, 8192)));
}

const SH_C0 = 0.28209479177387814;
const PLY_FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

/**
 * The viewer reads PLY and SOG only, so the older `.splat` layout is rewritten as PLY on the way in:
 * 32 bytes a splat, holding position, scale, colour and rotation as they are drawn, where PLY holds them as they were trained.
 */
async function splatAsPly(kago: Kago) {
  const source = new DataView(await new Response(kago.stream()).arrayBuffer());
  const count = Math.floor(source.byteLength / 32);
  if (count === 0) throw new Error("No splats");
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${PLY_FIELDS.map((field) => `property float ${field}\n`).join("")}end_header\n`);
  const stride = PLY_FIELDS.length * 4;
  const bytes = new Uint8Array(header.length + count * stride);
  bytes.set(header);
  const target = new DataView(bytes.buffer, header.length);
  for (let index = 0; index < count; index++) {
    const from = index * 32;
    const to = index * stride;
    for (let axis = 0; axis < 3; axis++) {
      target.setFloat32(to + axis * 4, source.getFloat32(from + axis * 4, true), true);
      target.setFloat32(to + 12 + axis * 4, (source.getUint8(from + 24 + axis) / 255 - 0.5) / SH_C0, true);
      target.setFloat32(to + 28 + axis * 4, Math.log(Math.max(source.getFloat32(from + 12 + axis * 4, true), 1e-12)), true);
    }
    const alpha = Math.min(Math.max(source.getUint8(from + 27) / 255, 1e-4), 1 - 1e-4);
    target.setFloat32(to + 24, Math.log(alpha / (1 - alpha)), true);
    for (let part = 0; part < 4; part++) target.setFloat32(to + 40 + part * 4, (source.getUint8(from + 28 + part) - 128) / 128, true);
  }
  return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
}

const BASE_SPEED = 4;
const MEDIAN_SAMPLES = 65536;

/**
 * Where to stand at the start: amid the splats the scene is mostly made of. A few stray splats far off stretch the
 * bounding box the viewer frames by, which leaves the camera a long way out; they barely move the median.
 */
function medianCamera(splat: Entity) {
  const resource = splat.gsplat?.resource;
  // The engine keeps no centres of its own under WebGPU, which sorts on the GPU; the loaded data still has them.
  const centers = resource?.centers ?? resource?.gsplatData.getCenters();
  const count = centers ? Math.floor(centers.length / 3) : 0;
  if (!centers || count === 0) return null;
  const step = Math.max(1, Math.floor(count / MEDIAN_SAMPLES));
  const median = [0, 1, 2].map((axis) => {
    const values = new Float32Array(Math.ceil(count / step));
    for (let index = 0, sample = 0; index < count; index += step) values[sample++] = centers[index * 3 + axis]!;
    return values.sort()[values.length >> 1]!;
  });
  const position = splat.getWorldTransform().transformPoint(new Vec3(median[0], median[1], median[2]));
  // Looking level along the scene; the viewer's own field of view.
  return { position: [position.x, position.y, position.z] as [number, number, number], target: [position.x, position.y, position.z - 1] as [number, number, number], fov: 85 };
}

/**
 * A Gaussian splat scene drawn by SuperSplat's viewer, without its interface: the status bar around it has the controls.
 * The file comes from Kago in ranges, never from the network, which the frame cannot reach.
 * `speed` is a multiple of the viewer's own pace of 4 m/s.
 */
export async function openScene(container: HTMLElement, kago: Kago, speed: number, onState: (state: SceneState) => void, onError: (error: SceneError) => void): Promise<Scene | null> {
  const lower = kago.file.name.toLowerCase();
  const legacy = lower.endsWith(".splat");
  let handle: ViewerHandle;
  let inside = false;
  try {
    if (lower.endsWith(".ply") && !(await isSplatPly(kago))) {
      onError("not-splat");
      return null;
    }
    const contents = legacy ? splatAsPly(kago) : Promise.resolve(new Response(kago.stream(), { headers: { "Content-Length": String(kago.file.size) } }));
    handle = await createViewer({
      container,
      // A bare file says nothing of where to stand: with no camera given, the viewer frames the whole scene.
      settings: { ...defaultSettings(), cameras: [] },
      // Only names the file: what is in it is handed over as `contents`.
      contentUrl: legacy ? `${kago.file.name}.ply` : kago.file.name,
      contentFilename: legacy ? `${kago.file.name}.ply` : kago.file.name,
      contents,
      initialCamera: (splat) => {
        const pose = medianCamera(splat);
        inside = pose !== null;
        return pose;
      },
      ui: false,
      noanim: true
    });
  } catch {
    onError("unreadable");
    return null;
  }

  // The viewer listens for keys on the whole page; only the window in front should answer them.
  handle.state.inputEnabled = kago.focused;
  const stopFocus = kago.onFocus((focused) => {
    handle.state.inputEnabled = focused;
  });
  handle.setMoveSpeed(BASE_SPEED * speed);
  handle.app.assets.on("error", () => onError("unreadable"));
  const report = () => {
    const { loaded, progress, cameraMode, inputMode } = handle.state;
    onState({ loaded, progress, mode: loaded && (cameraMode === "orbit" || cameraMode === "fly") ? cameraMode : null, touch: inputMode === "touch" });
  };
  for (const key of ["progress", "cameraMode", "inputMode"]) handle.events.on(`${key}:changed`, report);
  handle.events.once("loaded:changed", () => {
    // Standing amid the scene, it is flown through; a touch screen has no keys to fly with, so it looks around from there.
    // Framed from outside instead, the viewer would open on a turntable of its own making; a preview waits to be turned by hand.
    handle.state.cameraMode = inside && handle.state.inputMode !== "touch" ? "fly" : "orbit";
    report();
  });
  report();

  // The camera can only be told where to go once there is a scene to look at.
  const loaded = () => handle.state.loaded;
  return {
    setMode: (mode) => {
      if (loaded()) handle.state.cameraMode = mode;
    },
    frame: () => loaded() && handle.frameScene(),
    reset: () => loaded() && handle.resetCamera(),
    setSpeed: (next) => handle.setMoveSpeed(BASE_SPEED * next),
    destroy: () => {
      stopFocus();
      handle.destroy();
    }
  };
}
