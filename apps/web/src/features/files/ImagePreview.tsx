import { ChevronLeft, ChevronRight, Download, ImageOff, Info, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadUrl, imageUrl, previewUrl } from "@/api/client";
import { useFileList, useImageMetadata } from "@/api/hooks";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { formatDate, formatSize, isConvertedImage, isImageType, kindLabel } from "@/lib/format";
import { parentPath, triggerDownload } from "@/lib/paths";
import { getImageInfoOpen, setImageInfoOpen } from "@/lib/prefs";
import { isEditableTarget, isInteractiveTarget } from "@/lib/usePointerDrag";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileItem } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { Detail, PhotoDetails, Section } from "./Inspector";
import { t } from "@/lib/i18n";

/** Pictures with a viewer: what the browser decodes, and what the server converts for it. */
export const isViewableImage = (item: FileItem) => item.kind === "file" && (isImageType(item.type) || isConvertedImage(item));

// Numbered pictures sort as numbers, the way the file list shows them.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type View = { z: number; x: number; y: number };
type Size = { w: number; h: number };
type Point = { x: number; y: number };
type Timer = ReturnType<typeof setTimeout>;

/** The picture as it fits the window: `z` is relative to that, `x` and `y` move its centre off the window's. */
const FIT: View = { z: 1, x: 0, y: 0 };
/** Space between one picture and the next while they slide past. */
const GAP = 24;
/** A wheel that has been quiet this long has stopped: what comes next is another swipe, not the rest of this one. */
const STREAM_GAP = 180;
const SAMPLE_MS = 40;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ZOOM_TRANSITION = `transform 220ms ${EASE}`;
/** How far past its limits a pinch may push the picture before it springs back. */
const OVERSHOOT = { min: 0.5, max: 1.5 };
const STEP = 1.5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Where a picture is read from: the file itself, or the JPEG the server makes of one the browser cannot decode. */
export const sourceOf = (rootSlug: string, item: FileItem) => (isImageType(item.type) ? previewUrl(rootSlug, item.path) : `${imageUrl(rootSlug, item.path)}&v=${Math.round(item.mtime)}`);
// Keyed by the file as it is now: one replaced on disk is read, or converted, again.
const keyOf = (item: FileItem) => `${item.path}:${item.mtime}`;

/** Safari reports a trackpad pinch as gesture events of its own instead of as a wheel. */
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

/**
 * A picture, with the rest of its folder a swipe away. The gestures are the ones Photos on a Mac has:
 * pinch to zoom around the pointer, two fingers to move around a zoomed picture, and a sideways swipe
 * that drags the next picture in. The arrow keys step through the folder too.
 */
export function ImagePreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const store = useWorkspaceStore.getState;
  const folder = useFileList(rootSlug, parentPath(item.path)).data;
  const pictures = useMemo(() => (folder?.items ?? []).filter(isViewableImage).sort((a, b) => collator.compare(a.name, b.name)), [folder]);
  const position = pictures.findIndex((entry) => entry.path === item.path);
  const previous = position > 0 ? pictures[position - 1] : undefined;
  const next = position >= 0 ? pictures[position + 1] : undefined;

  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [view, setView] = useState(FIT);
  // Gestures arrive faster than renders, so they read and write the view here; the state only draws it.
  const viewRef = useRef(view);
  /** How far a swipe has dragged the pictures sideways, for the picture it started on. */
  const [offset, setOffset] = useState({ path: item.path, x: 0 });
  const [animated, setAnimated] = useState(false);
  const [infoOpen, setInfoOpen] = useState(getImageInfoOpen);
  const [slideMs, setSlideMs] = useState(300);
  const swipe = useRef({
    x: 0,
    /** What a swipe has moved before it is clear which way it is going. */
    pendingX: 0,
    pendingY: 0,
    axis: null as "x" | "y" | null,
    /** A swipe turns one page: once it has, the rest of it, momentum included, is ignored. */
    locked: false,
    lockedUntil: 0,
    /** Whether what is arriving while locked has turned out to be another swipe. */
    renewed: false,
    rises: 0,
    lastAt: 0,
    /** Wheel events are too uneven to time one by one, so speed is taken over a few of them at a time. */
    sampleX: 0,
    sampleMs: 0,
    /** Recent speed in pixels a millisecond, which the momentum of a swipe only ever falls below. */
    pace: 0,
    /** While locked: the fastest the swipe has been, and the slowest it has been since. */
    peak: 0,
    low: 0
  });
  const timers = useRef<{ settle?: Timer; release?: Timer; commit?: Timer }>({});
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ mode: "pan" | "swipe"; start: Point; view: View } | null>(null);
  const pinch = useRef<{ distance: number; middle: Point } | null>(null);

  // Another picture starts as it fits, whatever was done to the last one.
  const [shownPath, setShownPath] = useState(item.path);
  if (shownPath !== item.path) {
    setShownPath(item.path);
    setView(FIT);
    viewRef.current = FIT;
    swipe.current.x = 0;
  }

  const natural = sizes[keyOf(item)];
  const fit = natural && box.w > 0 ? Math.min(1, box.w / natural.w, box.h / natural.h) : 0;
  const base = natural ? { w: natural.w * fit, h: natural.h * fit } : { w: 0, h: 0 };
  // Up to four screen pixels for each of the picture's, and never less than four times what fits.
  const maxZoom = fit > 0 ? Math.max(4, 4 / fit) : 4;
  const shift = offset.path === item.path ? offset.x : 0;
  const span = box.w + GAP;

  function limit(next: View, loose = false): View {
    const z = loose ? clamp(next.z, OVERSHOOT.min, maxZoom * OVERSHOOT.max) : clamp(next.z, 1, maxZoom);
    const reachX = Math.max(0, (base.w * z - box.w) / 2);
    const reachY = Math.max(0, (base.h * z - box.h) / 2);
    return { z, x: clamp(next.x, -reachX, reachX), y: clamp(next.y, -reachY, reachY) };
  }

  function apply(next: View) {
    viewRef.current = next;
    setView(next);
  }

  /** Zooms keeping whatever is under `point` where it is; without one, the middle of the window. */
  function zoomTo(z: number, point: Point | null, loose = false) {
    const current = viewRef.current;
    const rect = stage.current?.getBoundingClientRect();
    const px = point && rect ? point.x - rect.left - rect.width / 2 : 0;
    const py = point && rect ? point.y - rect.top - rect.height / 2 : 0;
    const bounded = limit({ ...current, z }, loose).z;
    const ratio = bounded / current.z;
    apply(limit({ z: bounded, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }, loose));
  }

  /** Brings a picture pinched past its limits back inside them. */
  function settle() {
    globalThis.clearTimeout(timers.current.settle);
    setAnimated(true);
    apply(limit(viewRef.current));
  }

  function zoomStep(factor: number) {
    setAnimated(true);
    zoomTo(viewRef.current.z * factor, null);
  }

  function resetZoom() {
    setAnimated(true);
    apply(FIT);
  }

  /** Beyond its limits a pinch moves the picture less and less, like something being stretched. */
  const resist = (z: number) => (z < 1 ? z ** 0.4 : z > maxZoom ? maxZoom * (z / maxZoom) ** 0.4 : z);

  function show(target: FileItem | undefined) {
    if (!target) return;
    globalThis.clearTimeout(timers.current.commit);
    timers.current.commit = undefined;
    setAnimated(false);
    store().setPreviewItem(window.id, target);
  }

  /** Drags the pictures sideways. Where there is no picture to bring in, the one on show only gives a little. */
  function dragSwipe(x: number) {
    swipe.current.x = x;
    setAnimated(false);
    // Against the end of the folder it stretches less the further it is pulled.
    const stretch = box.w * 0.18;
    setOffset({ path: item.path, x: (x < 0 ? next : previous) ? x : Math.sign(x) * stretch * (1 - Math.exp(-Math.abs(x) / (stretch * 4))) });
  }

  function endSwipe(lockFor = 0) {
    globalThis.clearTimeout(timers.current.release);
    const state = swipe.current;
    swipe.current = { ...state, x: 0, pendingX: 0, pendingY: 0, axis: lockFor ? state.axis : null, locked: lockFor > 0 || state.locked, lockedUntil: lockFor ? performance.now() + lockFor : state.lockedUntil, renewed: lockFor ? false : state.renewed, rises: 0, peak: state.pace, low: state.pace };
  }

  function cancelSwipe(lockFor = 0) {
    endSwipe(lockFor);
    setSlideMs(300);
    setAnimated(true);
    setOffset({ path: item.path, x: 0 });
  }

  /** Lets the swipe carry on by itself to the next picture, then makes that the one on show. */
  function commitSwipe() {
    const forward = swipe.current.x < 0;
    const target = forward ? next : previous;
    if (!target) return cancelSwipe();
    // The further there is left to go, the longer it takes, so a page that is nearly over does not crawl.
    const duration = Math.round(clamp((span - Math.abs(swipe.current.x)) * 0.6, 200, 360));
    endSwipe(duration + 60);
    setSlideMs(duration);
    setAnimated(true);
    setOffset({ path: item.path, x: forward ? -span : span });
    timers.current.commit = globalThis.setTimeout(() => {
      timers.current.commit = undefined;
      store().setPreviewItem(window.id, target);
    }, duration);
  }

  function releaseSwipe(threshold: number) {
    if (Math.abs(swipe.current.x) > threshold) commitSwipe();
    else cancelSwipe();
  }

  function onWheel(event: WheelEvent) {
    // The browser would zoom the page on a pinch and go back in history on a swipe.
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    const current = viewRef.current;

    // A trackpad pinch arrives as a wheel with the control key held, which is also how a mouse wheel zooms.
    if (event.ctrlKey) {
      if (timers.current.commit !== undefined) return;
      if (swipe.current.x !== 0) cancelSwipe();
      const step = clamp(-dy * 0.01, -0.5, 0.5);
      const beyond = (current.z <= 1 && step < 0) || (current.z >= maxZoom && step > 0);
      setAnimated(false);
      zoomTo(current.z * Math.exp(beyond ? step * 0.35 : step), { x: event.clientX, y: event.clientY }, true);
      // Nothing says when the fingers lift, so the pinch is over when the wheel goes quiet.
      globalThis.clearTimeout(timers.current.settle);
      timers.current.settle = globalThis.setTimeout(settle, 140);
      return;
    }

    if (current.z > 1.001) {
      setAnimated(false);
      apply(limit({ ...current, x: current.x - dx, y: current.y - dy }));
      return;
    }

    const state = swipe.current;
    // When the fingers moved, not when the page got round to hearing of it: a busy page hands events over late and in bunches.
    const now = event.timeStamp;
    const elapsed = now - state.lastAt;
    state.lastAt = now;
    let sample: number | null = null;
    if (elapsed > STREAM_GAP) {
      state.axis = null;
      state.pendingX = 0;
      state.pendingY = 0;
      state.renewed = true;
      state.rises = 0;
      state.sampleX = dx;
      state.sampleMs = 0;
      state.pace = 0;
    } else {
      state.sampleX += dx;
      state.sampleMs += elapsed;
      if (state.sampleMs >= SAMPLE_MS) {
        sample = Math.abs(state.sampleX) / state.sampleMs;
        state.sampleX = 0;
        state.sampleMs = 0;
      }
    }
    if (state.locked) {
      if (sample !== null) {
        // The swipe that turned the page may still be speeding up, and then its momentum only slows down.
        // Another swipe is one that picks up again after that, and keeps picking up.
        const rising = state.low < state.peak * 0.6 && sample > state.low * 1.8 && sample > 0.8;
        state.rises = rising ? state.rises + 1 : 0;
        if (state.rises >= 2) state.renewed = true;
        if (!rising && sample > state.peak) state.peak = state.low = sample;
        else if (!rising) state.low = Math.min(state.low, sample);
      }
      if (!state.renewed || performance.now() < state.lockedUntil) return;
      state.locked = false;
      state.axis = null;
      state.pendingX = 0;
      state.pendingY = 0;
      state.pace = 0;
    } else if (sample !== null) state.pace = sample;

    let moved = dx;
    if (!state.axis) {
      // A swipe is sideways or it is not, from its first few pixels on: one that started up or down never turns a page.
      state.pendingX += dx;
      state.pendingY += Math.abs(dy);
      if (Math.abs(state.pendingX) < 6 && state.pendingY < 6) return;
      state.axis = Math.abs(state.pendingX) > state.pendingY ? "x" : "y";
      moved = state.pendingX;
    }
    if (state.axis === "y") return;

    const x = state.x - moved;
    dragSwipe(x);
    globalThis.clearTimeout(timers.current.release);
    const target = x < 0 ? next : previous;
    const onward = Math.sign(dx) === -Math.sign(x);
    if (!target) {
      // Nothing that way: give a little, then spring back without waiting for the momentum to run out.
      if (Math.abs(x) > 320) cancelSwipe(300);
      else timers.current.release = globalThis.setTimeout(() => cancelSwipe(), 100);
    } else if (Math.abs(x) > box.w / 2 || (Math.abs(x) > 40 && onward && state.pace > 1.2)) {
      // Past halfway, or flicked: the page turns without waiting for the rest of the swipe.
      commitSwipe();
    } else {
      timers.current.release = globalThis.setTimeout(() => releaseSwipe(Math.min(box.w / 4, 160)), 100);
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.pointerType === "mouse" && event.button !== 0) || isInteractiveTarget(event.target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [first, second] = [...pointers.current.values()];
    if (first && second) {
      if (swipe.current.x !== 0) cancelSwipe();
      drag.current = null;
      pinch.current = { distance: Math.hypot(second.x - first.x, second.y - first.y), middle: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } };
    } else if (viewRef.current.z > 1.001) {
      drag.current = { mode: "pan", start: first!, view: viewRef.current };
    } else if (event.pointerType !== "mouse" && timers.current.commit === undefined) {
      // A finger on the glass drags the pictures themselves; a mouse has the keys and the buttons for that.
      drag.current = { mode: "swipe", start: first!, view: viewRef.current };
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const [first, second] = [...pointers.current.values()];
    if (first && second && pinch.current) {
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const current = viewRef.current;
      const growing = distance > pinch.current.distance;
      const beyond = (current.z <= 1 && !growing) || (current.z >= maxZoom && growing);
      // Two fingers carry the picture along as well as stretching it.
      viewRef.current = { ...current, x: current.x + middle.x - pinch.current.middle.x, y: current.y + middle.y - pinch.current.middle.y };
      setAnimated(false);
      zoomTo(current.z * (distance / pinch.current.distance) ** (beyond ? 0.35 : 1), middle, true);
      pinch.current = { distance, middle };
    } else if (drag.current?.mode === "pan") {
      setAnimated(false);
      apply(limit({ ...drag.current.view, x: drag.current.view.x + point.x - drag.current.start.x, y: drag.current.view.y + point.y - drag.current.start.y }));
    } else if (drag.current?.mode === "swipe") {
      dragSwipe(point.x - drag.current.start.x);
    }
  }

  function onPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pinch.current) {
      pinch.current = null;
      settle();
    } else if (drag.current?.mode === "swipe") {
      releaseSwipe(Math.min(box.w / 5, 80));
    }
    drag.current = null;
  }

  function onDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (isInteractiveTarget(event.target) || fit === 0) return;
    setAnimated(true);
    // To the picture's own pixels, unless it is already nearly that large.
    if (viewRef.current.z > 1.01) apply(FIT);
    else zoomTo(fit < 0.8 ? 1 / fit : 2, { x: event.clientX, y: event.clientY });
  }

  function toggleInfo() {
    setImageInfoOpen(!infoOpen);
    setInfoOpen(!infoOpen);
  }

  function onKeyDown(event: KeyboardEvent) {
    const workspace = store();
    if (workspace.activeWindowId !== window.id || window.minimized) return;
    // Dialogs and menus own the keyboard while they are open.
    if (document.querySelector("[role=dialog], [role=menu]") || isEditableTarget(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "i") {
      event.preventDefault();
      toggleInfo();
      return;
    }
    if (mod || event.altKey) return;
    const target = event.key === "ArrowLeft" ? previous : event.key === "ArrowRight" ? next : undefined;
    if (target) show(target);
    else if (event.key === "+" || event.key === "=") zoomStep(STEP);
    else if (event.key === "-") zoomStep(1 / STEP);
    else if (event.key === "0") resetZoom();
    else if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
  }

  // Listeners that must be able to cancel what the browser would do are added by hand, once; they call whatever this render defined.
  const latest = useRef({ onWheel, onKeyDown, zoomTo, settle, resist });
  latest.current = { onWheel, onKeyDown, zoomTo, settle, resist };

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => latest.current.onWheel(event);
    const keyDown = (event: KeyboardEvent) => latest.current.onKeyDown(event);
    let startZoom = 1;
    // On a touch screen Safari sends these alongside the pointers, which already do the pinching.
    const gesture = (handle: (event: GestureEvent) => void) => (event: Event) => {
      event.preventDefault();
      if (pointers.current.size === 0) handle(event as GestureEvent);
    };
    const gestureStart = gesture(() => {
      startZoom = viewRef.current.z;
      setAnimated(false);
    });
    const gestureChange = gesture((event) => latest.current.zoomTo(latest.current.resist(startZoom * event.scale), { x: event.clientX, y: event.clientY }, true));
    const gestureEnd = gesture(() => latest.current.settle());
    const observer = new ResizeObserver(() => setBox({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", gestureStart);
    element.addEventListener("gesturechange", gestureChange);
    element.addEventListener("gestureend", gestureEnd);
    globalThis.addEventListener("keydown", keyDown);
    const pending = timers.current;
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gestureStart);
      element.removeEventListener("gesturechange", gestureChange);
      element.removeEventListener("gestureend", gestureEnd);
      globalThis.removeEventListener("keydown", keyDown);
      Object.values(pending).forEach((timer) => globalThis.clearTimeout(timer));
    };
  }, []);

  // A window that shrinks must not leave a zoomed picture dragged further than it can now go.
  useEffect(() => {
    const current = viewRef.current;
    const bounded = limit(current);
    if (bounded.x !== current.x || bounded.y !== current.y) apply(bounded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.w, box.h]);

  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));
  const zoomed = view.z > 1.001;
  const slides = [previous ? { entry: previous, index: -1 } : null, { entry: item, index: 0 }, next ? { entry: next, index: 1 } : null].filter((slide) => slide !== null);

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={
        <>
          <KagoIconButton label={t("Photo info (⌘I)")} className="size-6" active={infoOpen} onClick={toggleInfo}>
            <Info />
          </KagoIconButton>
          <KagoIconButton label={t("Download")} className="size-6" onClick={download}>
            <Download />
          </KagoIconButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <div
          ref={stage}
          className={`relative min-w-0 flex-1 touch-none overflow-hidden overscroll-contain bg-elevated select-none ${zoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={onDoubleClick}
        >
          {slides.map(({ entry, index }) => (
            <Slide
              key={keyOf(entry)}
              name={entry.name}
              source={sourceOf(rootSlug, entry)}
              current={index === 0}
              style={{ transform: `translate3d(${index * span + shift}px, 0, 0)`, transition: animated ? `transform ${slideMs}ms ${EASE}` : undefined }}
              imageStyle={index === 0 ? { transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`, transition: animated ? ZOOM_TRANSITION : undefined } : undefined}
              onSize={(size) => setSizes((known) => ({ ...known, [keyOf(entry)]: size }))}
              onDownload={download}
            />
          ))}
        </div>
        {infoOpen ? <ImageInfo rootSlug={rootSlug} item={item} natural={isImageType(item.type) ? natural : undefined} /> : null}
      </div>
      <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-elevated px-3 text-muted">
        {pictures.length > 1 && position >= 0 ? (
          <>
            <KagoIconButton label={t("Previous (←)")} className="-ml-1.5 size-6" disabled={!previous} onClick={() => show(previous)}>
              <ChevronLeft />
            </KagoIconButton>
            <span className="tabular-nums">
              {position + 1} / {pictures.length}
            </span>
            <KagoIconButton label={t("Next (→)")} className="size-6" disabled={!next} onClick={() => show(next)}>
              <ChevronRight />
            </KagoIconButton>
          </>
        ) : null}
        <span className="mr-auto" />
        {fit > 0 ? <span className="px-1 tabular-nums">{Math.round(fit * view.z * 100)}%</span> : null}
        <KagoIconButton label={t("Zoom out (−)")} className="size-6" disabled={!zoomed} onClick={() => zoomStep(1 / STEP)}>
          <ZoomOut />
        </KagoIconButton>
        <KagoIconButton label={t("Zoom in (+)")} className="size-6" disabled={fit === 0 || view.z >= maxZoom} onClick={() => zoomStep(STEP)}>
          <ZoomIn />
        </KagoIconButton>
        <KagoIconButton label={t("Fit to window (0)")} className="-mr-1.5 size-6" active={!zoomed} onClick={resetZoom}>
          <Scan />
        </KagoIconButton>
      </footer>
    </KagoWindow>
  );
}

/** One picture of the row a swipe drags along. HEIF and camera RAW take a moment the first time: the server converts them. */
function Slide({
  name,
  source,
  current,
  style,
  imageStyle,
  onSize,
  onDownload
}: {
  name: string;
  source: string;
  current: boolean;
  style: React.CSSProperties;
  imageStyle?: React.CSSProperties;
  onSize: (size: Size) => void;
  onDownload: () => void;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={style} aria-hidden={!current}>
      {state === "failed" ? (
        current ? (
          <KagoEmptyState icon={<ImageOff />} title={t("Couldn’t show this image")} description={t("The file may be damaged, or the server couldn’t convert it. Download it and open it in another app.")}>
            <Button onClick={onDownload}>{t("Download")}</Button>
          </KagoEmptyState>
        ) : null
      ) : (
        <>
          {state === "loading" && current ? <KagoSpinner className="absolute size-5" /> : null}
          <img
            alt={name}
            src={source}
            draggable={false}
            decoding="async"
            className="relative max-h-full max-w-full object-contain"
            style={imageStyle}
            onLoad={(event) => {
              const image = event.currentTarget;
              setState("loaded");
              // A vector drawing may not say how large it is; what it was laid out at will do.
              onSize(image.naturalWidth > 0 && image.naturalHeight > 0 ? { w: image.naturalWidth, h: image.naturalHeight } : { w: image.offsetWidth, h: image.offsetHeight });
            }}
            onError={() => setState("failed")}
          />
        </>
      )}
    </div>
  );
}

/** What the file and the camera say about the picture on show. */
function ImageInfo({ rootSlug, item, natural }: { rootSlug: string; item: FileItem; natural?: Size }) {
  const photo = useImageMetadata(rootSlug, item.path);
  const hasPhoto = Boolean(photo.data && Object.keys(photo.data).length > 0);
  return (
    <aside className="w-64 max-w-[60%] shrink-0 overflow-y-auto border-l border-line bg-surface [&>section:first-child]:border-t-0" aria-label={t("Photo info")}>
      <Section title={t("General")}>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <Detail label={t("Name")}>{item.name}</Detail>
          <Detail label={t("Kind")}>{kindLabel(item)}</Detail>
          <Detail label={t("Size")}>{formatSize(item.size)}</Detail>
          <Detail label={t("Modified")}>{formatDate(item.mtime)}</Detail>
          {/* The camera's own figures are listed below when it left any. */}
          {natural && !photo.data?.width ? <Detail label={t("Dimensions")}>{natural.w} × {natural.h}</Detail> : null}
        </dl>
      </Section>
      {photo.isLoading ? (
        <KagoLoading />
      ) : hasPhoto ? (
        <PhotoDetails photo={photo.data!} />
      ) : (
        <Section title={t("Photo info")}>
          <span className="text-faint">{t("This image has no photo info")}</span>
        </Section>
      )}
    </aside>
  );
}
