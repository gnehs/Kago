import { failureOf, type ShareFailure } from "@/lib/shareFolderModel";
import { t } from "@/lib/i18n";

/** The code of what the server turned a request down with, as `ApiError` carries it. */
export const codeOf = (error: unknown) => (error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined);

export const failureOfError = (error: unknown): ShareFailure => failureOf(codeOf(error));

/**
 * What a visitor is told of a failure in words they can act on. The server's own sentence is the fallback for what
 * has no better one, and is already translated.
 */
export function failureText(failure: ShareFailure, fallback: string): string {
  switch (failure) {
    case "revoked":
      return t("Whoever shared this no longer has access to it. Ask them for a new link.");
    case "changed":
      return t("What was shared has changed since this link was made. Ask whoever sent it for a new link.");
    case "missing":
      return t("That isn’t there any more. It may have been moved or renamed.");
    case "too-large":
      return t("This folder is too large to download in one go. Open it and download what’s inside instead.");
    case "busy":
      return t("Other downloads are using this server right now. Try again in a moment.");
    case "unsupported":
      return t("This kind of file can’t be viewed in the browser.");
    default:
      return fallback;
  }
}
