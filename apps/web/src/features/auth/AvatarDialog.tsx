import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ZoomIn, ZoomOut } from "lucide-react";
import { create } from "zustand";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoSlider } from "@/components/kago/slider";
import { Button } from "@/components/ui/button";
import { sourceOf } from "@/features/files/ImagePreview";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { FileItem } from "@/types/kago";
import { setAvatar, type AvatarCrop } from "./avatar";

type AvatarRequest = { rootSlug: string; item: FileItem; /** Tells one asking from the next, when both are for the same file. */ asked: number };

const useAvatarDialogStore = create<{ request: AvatarRequest | null }>(() => ({ request: null }));

/** Asks which part of a picture is to be the profile picture, and makes it that. */
export function chooseAvatar(rootSlug: string, item: FileItem) {
  useAvatarDialogStore.setState({ request: { rootSlug, item, asked: Date.now() } });
}

const close = () => useAvatarDialogStore.setState({ request: null });

export function AvatarDialogHost() {
  const pending = useAvatarDialogStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);

  useEffect(() => {
    if (pending) setRequest(pending);
  }, [pending]);

  if (!request) return null;
  return (
    <KagoDialog open={Boolean(pending)} onClose={close} title={t("Set as profile picture")} className="w-[min(352px,calc(100vw-32px))]">
      <AvatarCropper key={request.asked} request={request} />
    </KagoDialog>
  );
}

/** The side of the square the picture is moved about in, where the screen is wide enough for it. */
const STAGE = 320;
/** How much of that the circle in its middle takes, which is what is kept. The rest shows what is around it. */
const FRAME = 0.8;
const MAX_ZOOM = 5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Picture = { width: number; height: number };
/** How far in, and which point of the picture is at the middle of the circle, as parts of its width and height. */
type View = { zoom: number; x: number; y: number };

/** Half the side of the square that is kept, as parts of the picture's width and height. */
function reach(picture: Picture, zoom: number) {
  const half = Math.min(picture.width, picture.height) / zoom / 2;
  return { x: half / picture.width, y: half / picture.height };
}

/** The nearest view that keeps the circle filled: the picture never leaves a gap inside it. */
function settle(picture: Picture, view: View): View {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM);
  const half = reach(picture, zoom);
  return { zoom, x: clamp(view.x, half.x, 1 - half.x), y: clamp(view.y, half.y, 1 - half.y) };
}

function AvatarCropper({ request }: { request: AvatarRequest }) {
  const queryClient = useQueryClient();
  const stage = useRef<HTMLDivElement>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  // One the browser cannot draw can still be the profile picture; there is only no choosing which part of it.
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({ zoom: 1, x: 0.5, y: 0.5 });
  const [saving, setSaving] = useState(false);
  // Where the pointer that is dragging the picture was last seen.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  // As wide as it turned out to be: a narrow screen leaves it less room.
  const [side, setSide] = useState(STAGE);
  const frame = side * FRAME;

  // How many pixels of the screen one of the picture takes.
  const scale = picture ? (frame / Math.min(picture.width, picture.height)) * view.zoom : 0;
  const change = (next: (view: View) => View) => picture && setView((current) => settle(picture, next(current)));
  const zoomBy = (factor: number) => change((current) => ({ ...current, zoom: current.zoom * factor }));
  /** Moves the picture under the circle by this many pixels of the screen. */
  const moveBy = (dx: number, dy: number) => picture && change((current) => ({ ...current, x: current.x - dx / (picture.width * scale), y: current.y - dy / (picture.height * scale) }));

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => node.clientWidth > 0 && setSide(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [failed]);

  // React listens to the wheel passively, and a wheel that is not stopped zooms or scrolls the page behind.
  useEffect(() => {
    const node = stage.current;
    if (!node || !picture) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((current) => settle(picture, { ...current, zoom: current.zoom * Math.exp(-event.deltaY * 0.002) }));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [picture]);

  async function save() {
    let crop: AvatarCrop | undefined;
    if (picture) {
      const half = reach(picture, view.zoom);
      crop = { x: clamp(view.x - half.x, 0, 1), y: clamp(view.y - half.y, 0, 1), size: 1 / view.zoom };
    }
    setSaving(true);
    const done = await run(async () => {
      await setAvatar(queryClient, { rootSlug: request.rootSlug, path: request.item.path, crop });
      toast(t("Profile picture set"));
      return true;
    }, t("Couldn’t set the profile picture"));
    setSaving(false);
    if (done) close();
  }

  return (
    <form
      className="flex flex-col gap-3 p-4 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && (picture || failed)) void save();
      }}
    >
      <p className="m-0 text-muted">{failed ? t("This picture can’t be shown here, so its middle will be used.") : t("Drag the picture to place it in the circle.")}</p>
      {failed ? null : (
        <>
          <div
            ref={stage}
            role="group"
            aria-label={t("Drag the picture to place it in the circle.")}
            tabIndex={0}
            className={cn("relative mx-auto aspect-square w-full touch-none overflow-hidden rounded-md bg-neutral-900 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/50", drag ? "cursor-grabbing" : "cursor-grab")}
            style={{ maxWidth: STAGE }}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ x: event.clientX, y: event.clientY });
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              moveBy(event.clientX - drag.x, event.clientY - drag.y);
              setDrag({ x: event.clientX, y: event.clientY });
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 32 : 8;
              const moves: Record<string, () => void> = {
                ArrowLeft: () => moveBy(step, 0),
                ArrowRight: () => moveBy(-step, 0),
                ArrowUp: () => moveBy(0, step),
                ArrowDown: () => moveBy(0, -step),
                "+": () => zoomBy(1.1),
                "=": () => zoomBy(1.1),
                "-": () => zoomBy(1 / 1.1)
              };
              const move = moves[event.key];
              if (!move) return;
              event.preventDefault();
              move();
            }}
          >
            <img
              alt=""
              draggable={false}
              src={sourceOf(request.rootSlug, request.item)}
              // A picture that is see-through in places is kept on white, so that is what it is shown on.
              className="pointer-events-none absolute max-w-none bg-white"
              style={picture ? { width: picture.width * scale, height: picture.height * scale, left: side / 2 - view.x * picture.width * scale, top: side / 2 - view.y * picture.height * scale } : { opacity: 0 }}
              onLoad={(event) => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                if (width > 0 && height > 0) setPicture({ width, height });
                else setFailed(true);
              }}
              onError={() => setFailed(true)}
            />
            {/* What is kept is inside the circle; the rest of the picture is dimmed by the shadow the circle casts outwards. */}
            <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 rounded-full shadow-[0_0_0_999px_rgb(0_0_0/0.55)] ring-2 ring-white" style={{ width: frame, height: frame }} />
          </div>
          <div className="flex items-center gap-2 text-muted [&>.lucide]:size-4">
            <ZoomOut />
            <KagoSlider
              aria-label={t("Zoom")}
              className="min-w-0 flex-1"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              disabled={!picture}
              value={view.zoom}
              onChange={(event) => change((current) => ({ ...current, zoom: Number(event.target.value) }))}
            />
            <ZoomIn />
          </div>
        </>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={close}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={saving || !(picture || failed)}>{saving ? t("Saving…") : t("Save")}</Button>
      </div>
    </form>
  );
}
