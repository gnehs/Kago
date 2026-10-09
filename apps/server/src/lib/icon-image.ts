import { AppError } from "./errors.js";
import { sanitizeSvg } from "./svg-sanitize.js";

/** An icon is a small picture; nothing larger is taken for one, whether it was uploaded or fetched. */
export const ICON_MAX_BYTES = 1024 * 1024;

export const ICON_TYPES = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
export type IconType = keyof typeof ICON_TYPES;
export type IconImage = { type: IconType; data: Buffer };

const startsWith = (data: Buffer, bytes: number[], offset = 0) => bytes.every((byte, index) => data[offset + index] === byte);

/**
 * What a picture is, told from its own first bytes and never from the name or type it arrived with, and in the
 * form it is kept in: a bitmap as it is, an SVG rewritten down to what draws.
 */
export function readIcon(data: Buffer): IconImage {
  if (data.length > ICON_MAX_BYTES) throw new AppError(413, "The icon is too large", "ICON_TOO_LARGE");
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "png", data };
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { type: "jpg", data };
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return { type: "webp", data };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new AppError(422, "The icon is not a PNG, JPEG, WebP or SVG picture", "ICON_UNSUPPORTED");
  }
  const svg = sanitizeSvg(text);
  if (svg === null) throw new AppError(422, "The icon is not a PNG, JPEG, WebP or SVG picture", "ICON_UNSUPPORTED");
  return { type: "svg", data: Buffer.from(svg, "utf8") };
}
