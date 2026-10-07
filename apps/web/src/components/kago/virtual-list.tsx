import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A scrolling list of rows that are all `rowHeight` tall, of which only the ones in sight (and a few either side)
 * are in the page: twenty thousand rows scroll as easily as twenty.
 */
export function KagoVirtualList<T>({ items, rowHeight, overscan = 8, className, children }: { items: T[]; rowHeight: number; overscan?: number; className?: string; children: (item: T, index: number) => ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setView((current) => (current.top === element.scrollTop && current.height === element.clientHeight ? current : { top: element.scrollTop, height: element.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);

  const first = Math.max(Math.floor(view.top / rowHeight) - overscan, 0);
  const last = Math.min(Math.ceil((view.top + view.height) / rowHeight) + overscan, items.length);

  return (
    <div ref={viewport} role="list" tabIndex={0} className={cn("overflow-y-auto outline-none", className)}>
      <div className="relative" style={{ height: items.length * rowHeight }}>
        <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${first * rowHeight}px)` }}>
          {items.slice(first, last).map((item, offset) => (
            <div key={first + offset} role="listitem" aria-posinset={first + offset + 1} aria-setsize={items.length} style={{ height: rowHeight }}>
              {children(item, first + offset)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
