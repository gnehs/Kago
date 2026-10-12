import { storyboardSheetUrl } from "@/api/client";
import type { ReadyStoryboard, Storyboard } from "@/types/kago";

/** One picture of a storyboard as it is cut out of its sheet, in the pixels it is shown at. */
export type TimelinePicture = { url: string; width: number; height: number; x: number; y: number; sheetWidth: number; sheetHeight: number };

/** How tall a picture is shown; the sheets hold it half again as large for a dense screen. */
const SHOWN_HEIGHT = 90;

/** A storyboard once there is one to show. */
export const readyStoryboard = (board: Storyboard | undefined): ReadyStoryboard | null => (board?.status === "ready" ? board : null);

export const storyboardSheets = (board: ReadyStoryboard, rootSlug: string, path: string) =>
  Array.from({ length: board.sheets }, (_, index) => storyboardSheetUrl(rootSlug, path, index, board.version));

/** The picture standing for `seconds` into the video. */
export function timelinePicture(board: ReadyStoryboard, sheets: string[], seconds: number): TimelinePicture | null {
  const index = Math.min(board.count - 1, Math.max(0, Math.floor(seconds / board.interval)));
  const perSheet = board.columns * board.rows;
  const url = sheets[Math.floor(index / perSheet)];
  if (!url) return null;
  const scale = SHOWN_HEIGHT / board.height;
  const width = Math.round(board.width * scale);
  const cell = index % perSheet;
  return {
    url,
    width,
    height: SHOWN_HEIGHT,
    x: (cell % board.columns) * width,
    y: Math.floor(cell / board.columns) * SHOWN_HEIGHT,
    sheetWidth: width * board.columns,
    sheetHeight: SHOWN_HEIGHT * board.rows
  };
}
