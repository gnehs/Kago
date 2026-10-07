/**
 * Types a browser shows by itself when it is sent the file. Anything else it saves to disk instead,
 * which is not what a link that only lets someone look should do.
 */
const VIEWABLE = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/apng", "image/x-icon", "image/vnd.microsoft.icon",
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/webm",
  "video/mp4", "video/webm",
  "application/pdf",
  "text/plain"
]);

export const isBrowserViewable = (contentType: string) => VIEWABLE.has(contentType);
