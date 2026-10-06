import { useLayoutEffect, useMemo, useState } from "react";
import type { FileItem, FileWindow } from "@/types/kago";

/**
 * Where every item of a file list sits inside its scroll container.
 * Only the rows near the viewport are in the DOM, so anything that needs the position
 * of an item (rendering, rubber-band selection, keyboard navigation) works from this instead.
 */
export type FileLayout = {
  columns: number;
  /** Offset of the first cell from the top left of the scrolled content. */
  top: number;
  left: number;
  cellWidth: number;
  cellHeight: number;
  /** Space between cells, on both axes. */
  gap: number;
  /** Padding below the last row. */
  bottom: number;
  /** Height of the header that stays stuck over the top of the viewport. */
  stickyTop: number;
  viewportHeight: number;
};

export const LIST_HEADER_HEIGHT = 28;
export const GRID_CELL_HEIGHT = 128;
const GRID_CELL_MIN_WIDTH = 104;
const GRID_GAP = 4;
const GRID_PADDING = 8;
const ROW_INSET = 4;
const COLUMNS_MAX_WIDTH = 288;
/** Rows kept rendered above and below the viewport so fast scrolling does not show gaps. */
const OVERSCAN_ROWS = 6;

/** Measures the scroll container and lays the items of the current view mode out in it. */
export function useFileLayout(scroller: HTMLElement | null, viewMode: FileWindow["viewMode"]): FileLayout {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rowHeight = useMemo(() => (scroller ? parseFloat(getComputedStyle(scroller).getPropertyValue("--kago-row-h")) : 0) || 32, [scroller]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => setSize((previous) => (previous.width === scroller.clientWidth && previous.height === scroller.clientHeight ? previous : { width: scroller.clientWidth, height: scroller.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  return useMemo(() => {
    const { width, height: viewportHeight } = size;
    if (viewMode === "grid") {
      const inner = Math.max(0, width - GRID_PADDING * 2);
      const columns = Math.max(1, Math.floor((inner + GRID_GAP) / (GRID_CELL_MIN_WIDTH + GRID_GAP)));
      return { columns, top: GRID_PADDING, left: GRID_PADDING, cellWidth: (inner - (columns - 1) * GRID_GAP) / columns, cellHeight: GRID_CELL_HEIGHT, gap: GRID_GAP, bottom: GRID_PADDING, stickyTop: 0, viewportHeight };
    }
    if (viewMode === "columns") {
      // The name column takes half the width up to a limit, minus its right border.
      const column = Math.min(width / 2, COLUMNS_MAX_WIDTH) - 1;
      return { columns: 1, top: ROW_INSET, left: ROW_INSET, cellWidth: Math.max(0, column - ROW_INSET * 2), cellHeight: rowHeight, gap: 0, bottom: ROW_INSET, stickyTop: 0, viewportHeight };
    }
    return { columns: 1, top: LIST_HEADER_HEIGHT, left: ROW_INSET, cellWidth: Math.max(0, width - ROW_INSET * 2), cellHeight: rowHeight, gap: 0, bottom: 8, stickyTop: LIST_HEADER_HEIGHT, viewportHeight };
  }, [size, viewMode, rowHeight]);
}

/**
 * The slice of items to render for the current scroll position.
 * `offset` is the height of the rows skipped above the slice and `height` that of all the rows.
 */
export function useVisibleRange(scroller: HTMLElement | null, layout: FileLayout, count: number) {
  const pitch = layout.cellHeight + layout.gap;
  const [firstRow, setFirstRow] = useState(0);

  useLayoutEffect(() => {
    if (!scroller) return;
    // Re-rendering only happens when the first visible row changes, not on every scroll event.
    const update = () => setFirstRow(Math.max(0, Math.floor((scroller.scrollTop - layout.top) / pitch)));
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [scroller, layout.top, pitch, count]);

  const rows = Math.ceil(count / layout.columns);
  const visibleRows = Math.ceil(layout.viewportHeight / pitch) + 1;
  const startRow = Math.max(0, Math.min(firstRow, rows - visibleRows) - OVERSCAN_ROWS);
  const endRow = Math.min(rows, firstRow + visibleRows + OVERSCAN_ROWS);
  return { start: startRow * layout.columns, end: Math.min(count, endRow * layout.columns), offset: startRow * pitch, height: Math.max(0, rows * pitch - layout.gap) };
}

/** Indexes of the items whose cell touches an area given in scrolled-content coordinates. */
export function indexesInArea(layout: FileLayout, count: number, area: { left: number; top: number; right: number; bottom: number }) {
  const span = (from: number, to: number, origin: number, size: number, limit: number) => {
    const pitch = size + layout.gap;
    return [Math.max(0, Math.ceil((from - origin - size) / pitch)), Math.min(limit - 1, Math.floor((to - origin) / pitch))] as const;
  };
  const [firstRow, lastRow] = span(area.top, area.bottom, layout.top, layout.cellHeight, Math.ceil(count / layout.columns));
  const [firstColumn, lastColumn] = span(area.left, area.right, layout.left, layout.cellWidth, layout.columns);
  const indexes: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const index = row * layout.columns + column;
      if (index < count) indexes.push(index);
    }
  }
  return indexes;
}

/** Scrolls just enough to bring an item into view, like `scrollIntoView({ block: "nearest" })` for a row that may not be rendered. */
export function revealIndex(scroller: HTMLElement, layout: FileLayout, index: number) {
  const row = Math.floor(index / layout.columns);
  const top = layout.top + row * (layout.cellHeight + layout.gap);
  const bottom = top + layout.cellHeight;
  if (top < scroller.scrollTop + layout.stickyTop) scroller.scrollTop = row === 0 ? 0 : top - layout.stickyTop;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom + layout.bottom - scroller.clientHeight;
}

/** What a file window currently lists, for code outside it that used to read the rows from the DOM. */
export type FileView = {
  items: FileItem[];
  reveal: (index: number) => void;
  /** Set while the list shows folders that open in place. */
  tree?: FileTree;
};

/** Folders opened in place in the list view: their contents follow them, one level further in. */
export type FileTree = {
  /** How deep each listed item sits below the window's folder, by index. */
  depths: number[];
  expanded: ReadonlySet<string>;
  setExpanded: (path: string, open: boolean) => void;
};

export const fileViews = new Map<string, FileView>();
