import { createViewer, type ViewerHandle } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import "@playcanvas/supersplat-viewer/viewer.css";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type SplatError = "not-splat" | "unreadable";

export type SplatMode = "orbit" | "fly";
export type SplatViewHandle = { setMode: (mode: SplatMode) => void; frame: () => void; reset: () => void };
/** `mode` is null while the camera is on neither: before the scene is drawn, or while the viewer's own turntable plays. */
export type SplatViewState = { loaded: boolean; progress: number; mode: SplatMode | null; touch: boolean };

type Props = { ref: Ref<SplatViewHandle>; url: string; name: string; focused: boolean; onState: (patch: Partial<SplatViewState>) => void; onError: (error: SplatError) => void };

/** A PLY file may just as well be a mesh or a point cloud; a splat's header names what only a splat has. */
async function isSplatPly(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-8191" }, signal });
  if (!response.ok) throw new Error();
  return /\b(f_dc_0|packed_position)\b/.test(new TextDecoder().decode(await response.arrayBuffer()));
}

const SH_C0 = 0.28209479177387814;
const PLY_FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

/**
 * The viewer reads PLY and SOG only, so the older `.splat` layout is rewritten as PLY on the way in:
 * 32 bytes a splat, holding position, scale, colour and rotation as they are drawn, where PLY holds them as they were trained.
 */
async function splatAsPly(url: string, signal: AbortSignal) {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error();
  const source = new DataView(await response.arrayBuffer());
  const count = Math.floor(source.byteLength / 32);
  if (count === 0) throw new Error();
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

/** A Gaussian splat scene drawn by SuperSplat's viewer, without its interface: the window around it has the controls. */
export default function SplatView({ ref, url, name, focused, onState, onError }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const latest = useRef({ focused, onState, onError });
  latest.current = { focused, onState, onError };

  // The camera can only be told where to go once there is a scene to look at.
  const ready = () => (viewer.current?.state.loaded ? viewer.current : null);
  useImperativeHandle(ref, () => ({
    setMode: (mode) => {
      const handle = ready();
      if (handle) handle.state.cameraMode = mode;
    },
    frame: () => ready()?.frameScene(),
    reset: () => ready()?.resetCamera()
  }));

  useEffect(() => {
    const abort = new AbortController();
    const fail = (error: SplatError) => !abort.signal.aborted && latest.current.onError(error);
    void (async () => {
      const lower = name.toLowerCase();
      const legacy = lower.endsWith(".splat");
      if (lower.endsWith(".ply") && !(await isSplatPly(url, abort.signal))) return fail("not-splat");
      const contents = legacy ? await splatAsPly(url, abort.signal) : undefined;
      if (abort.signal.aborted) return;
      const handle = await createViewer({
        container: container.current!,
        // A bare file says nothing of where to stand: with no camera given, the viewer frames the whole scene.
        settings: { ...defaultSettings(), cameras: [] },
        contentUrl: url,
        contentFilename: legacy ? `${name}.ply` : name,
        contents: contents && Promise.resolve(contents),
        ui: false,
        noanim: true
      });
      if (abort.signal.aborted) return handle.destroy();
      viewer.current = handle;
      handle.state.inputEnabled = latest.current.focused;
      handle.app.assets.on("error", () => fail("unreadable"));
      const report = () => {
        const { loaded, progress, cameraMode, inputMode } = handle.state;
        latest.current.onState({ loaded, progress, mode: loaded && (cameraMode === "orbit" || cameraMode === "fly") ? cameraMode : null, touch: inputMode === "touch" });
      };
      for (const key of ["progress", "cameraMode", "inputMode"]) handle.events.on(`${key}:changed`, report);
      handle.events.once("loaded:changed", () => {
        // The viewer would open on a turntable of its own making; a preview waits to be turned by hand.
        handle.state.cameraMode = "orbit";
        report();
      });
      report();
    })().catch(() => fail("unreadable"));
    return () => {
      abort.abort();
      // Browsers allow only so many graphics contexts at once, so this one is given back.
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [url, name]);

  // The viewer listens for keys on the whole page; only the window in front should answer them.
  useEffect(() => {
    if (viewer.current) viewer.current.state.inputEnabled = focused;
  }, [focused]);

  return <div ref={container} className="min-h-0 flex-1 bg-black" />;
}
