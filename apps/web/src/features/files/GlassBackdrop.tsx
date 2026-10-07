import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

/** The copy is small: it is only ever seen blurred. */
const WIDTH = 320;
const FRAME_MS = 1000 / 30;
const NOTHING = 'path("M0 0")';

/**
 * A blurred copy of the picture to lie behind the player's glass. A browser shows an HDR video on a layer of its
 * own beneath the page, where `backdrop-filter` does not reach, so glass over it stays clear. This draws the frames
 * small on a canvas over the video, blurs that, and cuts it to the shape of whatever glass lies over the picture.
 */
export function GlassBackdrop({ videoRef, shown, menuOpen }: { videoRef: RefObject<HTMLVideoElement | null>; shown: boolean; menuOpen: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const video = videoRef.current;
    if (!canvas || !video || !shown) return;
    // The player may be in a floating window, which keeps its own time.
    const view = canvas.ownerDocument.defaultView ?? window;
    const context = canvas.getContext("2d");
    let request = 0;
    let last = 0;
    let clip = "";
    const tick = (now: number) => {
      request = view.requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      if (context && video.videoWidth > 0) {
        const height = Math.round((WIDTH * video.videoHeight) / video.videoWidth);
        if (canvas.width !== WIDTH || canvas.height !== height) {
          canvas.width = WIDTH;
          canvas.height = height;
        }
        context.drawImage(video, 0, 0, WIDTH, height);
      }
      const next = glassPath(canvas, menuOpen);
      if (next !== clip) {
        clip = next;
        canvas.style.clipPath = next;
      }
    };
    request = view.requestAnimationFrame(tick);
    return () => view.cancelAnimationFrame(request);
  }, [videoRef, shown, menuOpen]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 size-full object-contain blur-xl saturate-[1.7] transition-opacity duration-150", shown ? "opacity-100" : "opacity-0")}
      style={{ clipPath: NOTHING }}
    />
  );
}

/** The outlines of the glass over the picture, as a clip path in the canvas's own coordinates. */
function glassPath(canvas: HTMLCanvasElement, menuOpen: boolean): string {
  const frame = canvas.getBoundingClientRect();
  const glass = [
    ...(canvas.parentElement?.querySelectorAll<HTMLElement>(".kago-player-glass") ?? []),
    // A menu opened from the controls is drawn elsewhere in the document, over the picture.
    ...(menuOpen ? canvas.ownerDocument.querySelectorAll<HTMLElement>(".kago-glass[role=menu]") : [])
  ];
  const shapes: string[] = [];
  for (const element of glass) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width === 0 || rect.height === 0 || style.opacity === "0") continue;
    const [x, y, width, height] = [rect.left - frame.left, rect.top - frame.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10) as [number, number, number, number];
    const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2);
    const corner = `A${radius} ${radius} 0 0 1`;
    shapes.push(
      `M${x + radius} ${y}H${x + width - radius}${corner} ${x + width} ${y + radius}V${y + height - radius}${corner} ${x + width - radius} ${y + height}H${x + radius}${corner} ${x} ${y + height - radius}V${y + radius}${corner} ${x + radius} ${y}Z`
    );
  }
  return shapes.length > 0 ? `path("${shapes.join("")}")` : NOTHING;
}
