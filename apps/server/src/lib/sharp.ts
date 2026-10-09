import { logger } from "./logger.js";

export type Sharp = (typeof import("sharp"))["default"];

let loading: Promise<Sharp | null> | undefined;

/**
 * sharp, which writes the AVIFs Kago makes. It carries a library built for one kind of machine, so it is only loaded
 * once a picture needs writing; null where there is none for this one.
 */
export function loadSharp(): Promise<Sharp | null> {
  return (loading ??= import("sharp").then(
    ({ default: sharp }) => {
      // It would remember a file by its name, and answer for one changed since with what it was before.
      sharp.cache(false);
      return sharp;
    },
    (error: Error) => {
      logger.warn("sharp could not be loaded; no pictures are drawn with it", error.message);
      return null;
    }
  ));
}
