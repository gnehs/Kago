import { init } from "pptx-preview";
import { useEffect, useRef } from "react";
import { completeCharts } from "./pptxCharts";

// Slides are drawn at this size and then scaled as a whole, so text keeps its place whatever the window's width.
const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;

/** A presentation as a column of slides. */
export default function SlidesView({ data, onError }: { data: ArrayBuffer; onError: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const fail = useRef(onError);
  fail.current = onError;

  useEffect(() => {
    const container = host.current!;
    let cancelled = false;
    const fit = () => {
      container.style.zoom = String(Math.min(1.5, (scroller.current!.clientWidth - 32) / SLIDE_WIDTH));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(scroller.current!);
    const previewer = init(container, { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, mode: "list" });
    completeCharts(data)
      // A deck whose charts cannot be touched up is still worth showing as it is.
      .catch(() => data)
      // The library reads the buffer in place; a copy leaves ours whole for a second mount.
      .then((deck) => (cancelled ? undefined : previewer.preview(deck.slice(0))))
      .catch(() => !cancelled && fail.current());

    return () => {
      cancelled = true;
      observer.disconnect();
      previewer.destroy();
      container.replaceChildren();
    };
  }, [data]);

  return (
    <div ref={scroller} className="kago-office kago-slides min-h-0 flex-1 overflow-auto bg-elevated">
      <div ref={host} className="mx-auto" style={{ width: SLIDE_WIDTH }} />
    </div>
  );
}
