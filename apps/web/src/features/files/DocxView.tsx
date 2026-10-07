import { renderAsync } from "docx-preview";
import { useEffect, useRef } from "react";

const BULLETS: Record<string, string> = { "\uf0b7": "•", "\uf0a7": "▪", "\uf0d8": "➢", "\uf0fc": "✓", "\uf076": "❖", "\uf06e": "■", "\uf06c": "●", "\uf075": "◆" };

/** A Word document laid out as pages, shrunk to the width of the window when it is narrower than the paper. */
export default function DocxView({ data, onError }: { data: ArrayBuffer; onError: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const fail = useRef(onError);
  fail.current = onError;

  useEffect(() => {
    const container = host.current!;
    let cancelled = false;
    let pageWidth = 0;
    const fit = () => {
      if (pageWidth > 0) container.style.zoom = String(Math.min(1, (scroller.current!.clientWidth - 32) / pageWidth));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(scroller.current!);

    // Embedded HTML chunks are the one part of a document that is markup someone else wrote.
    renderAsync(data, container, undefined, { className: "kago-docx", renderAltChunks: false }).then(
      () => {
        if (cancelled) return;
        for (const link of container.querySelectorAll("a")) {
          // A document's links are whatever its author typed; only the ones that leave for the web are kept.
          if (/^(https?:|mailto:)/i.test(link.getAttribute("href") ?? "")) {
            link.target = "_blank";
            link.rel = "noreferrer";
          } else {
            link.removeAttribute("href");
          }
        }
        // Word draws list bullets with the private characters of its symbol fonts, which no browser has.
        for (const style of container.querySelectorAll("style")) {
          const css = style.textContent ?? "";
          if (/[\uf000-\uf0ff]/.test(css)) style.textContent = css.replace(/[\uf000-\uf0ff]/g, (symbol) => BULLETS[symbol] ?? "•").replace(/font-family:\s*(Symbol|Wingdings)[^;]*;/gi, "");
        }
        pageWidth = container.querySelector<HTMLElement>("section.kago-docx")?.offsetWidth ?? 0;
        fit();
      },
      () => !cancelled && fail.current()
    );

    return () => {
      cancelled = true;
      observer.disconnect();
      container.replaceChildren();
      container.style.zoom = "";
    };
  }, [data]);

  return (
    <div ref={scroller} className="kago-office min-h-0 flex-1 overflow-auto bg-elevated select-text">
      <div ref={host} />
    </div>
  );
}
