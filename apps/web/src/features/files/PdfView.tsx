import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Served as they are by the Vite plugin: character maps for CJK text, the fonts every PDF may assume, image decoders.
const RESOURCES = { cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/" };
const FIT = "page-width";

export type PdfViewHandle = { zoomIn: () => void; zoomOut: () => void; fit: () => void };
export type PdfViewState = { page: number; pages: number; scale: number; fitted: boolean };

type Props = { ref: Ref<PdfViewHandle>; url: string; onState: (patch: Partial<PdfViewState>) => void; onError: () => void };

/** pdf.js's own page viewer: pages are drawn as they scroll into view, with text that can be selected. */
export default function PdfView({ ref, url, ...callbacks }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;

  useImperativeHandle(ref, () => ({
    zoomIn: () => viewer.current?.increaseScale(),
    zoomOut: () => viewer.current?.decreaseScale(),
    fit: () => {
      if (viewer.current) viewer.current.currentScaleValue = FIT;
    }
  }));

  useEffect(() => {
    let cancelled = false;
    let fitted = true;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
    // No script runs and nothing is edited: this is a reader.
    const view = new PDFViewer({ container: container.current!, viewer: pages.current!, eventBus, linkService, annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE });
    linkService.setViewer(view);
    viewer.current = view;

    eventBus.on("pagesinit", () => {
      view.currentScaleValue = FIT;
      latest.current.onState({ page: 1, pages: view.pagesCount });
    });
    eventBus.on("pagechanging", (event: { pageNumber: number }) => latest.current.onState({ page: event.pageNumber }));
    eventBus.on("scalechanging", (event: { scale: number; presetValue?: string }) => {
      fitted = event.presetValue === FIT;
      latest.current.onState({ scale: event.scale, fitted });
    });

    // The file is fetched in ranges, so the first pages of a large document show before the rest has arrived.
    const task = pdfjs.getDocument({ url, withCredentials: true, ...RESOURCES });
    task.promise.then(
      (document) => {
        if (cancelled) return;
        view.setDocument(document);
        linkService.setDocument(document, null);
      },
      () => !cancelled && latest.current.onError()
    );

    // A window fitted to its width stays fitted as it is resized; a chosen zoom is left alone.
    const observer = new ResizeObserver(() => {
      if (!view.pagesCount || container.current!.clientWidth === 0) return;
      if (fitted) view.currentScaleValue = FIT;
      else view.update();
    });
    observer.observe(container.current!);

    return () => {
      cancelled = true;
      observer.disconnect();
      viewer.current = null;
      void task.destroy();
    };
  }, [url]);

  return (
    <div className="kago-pdf relative min-h-0 flex-1 bg-elevated">
      {/* The viewer measures and scrolls its container itself, and insists on it being positioned. */}
      <div ref={container} className="absolute inset-0 overflow-auto select-text">
        <div ref={pages} className="pdfViewer" />
      </div>
    </div>
  );
}
