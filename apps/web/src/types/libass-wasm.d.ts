declare module "@jellyfin/libass-wasm" {
  /** The options Kago uses; the library takes more. */
  export type SubtitlesOctopusOptions = {
    video: HTMLVideoElement;
    subContent: string;
    workerUrl: string;
    /** The font libass falls back to for glyphs the script's own fonts lack. */
    fallbackFont?: string;
    fonts?: string[];
    onError?: (error: unknown) => void;
  };

  export default class SubtitlesOctopus {
    constructor(options: SubtitlesOctopusOptions);
    dispose(): void;
  }
}
