import { useCallback, useEffect, useRef, useState } from "react";
import { serverMessage } from "@/api/client";
import { failureOf, shareEndpoint } from "@/lib/shareFolderModel";
import { failureText } from "./shareFailures";

export type Zip = { state: "idle" } | { state: "started"; name: string } | { state: "failed"; message: string };

/**
 * Downloads a folder of a link as one zip. It is a download of the browser's own, so the page cannot see how far it
 * has got, and can only say that it was asked for. It is asked for in a frame nobody sees: where the server turns it
 * down (too large, too busy) the frame is left holding the reason, which is read out of it and said here, instead
 * of taking the visitor to a page of JSON.
 */
export function useZipDownload(token: string) {
  const [zip, setZip] = useState<Zip>({ state: "idle" });
  const frame = useRef<HTMLIFrameElement | null>(null);

  const forget = useCallback(() => {
    frame.current?.remove();
    frame.current = null;
  }, []);
  useEffect(() => forget, [forget]);

  const start = useCallback(
    (path: string, name: string) => {
      forget();
      const next = document.createElement("iframe");
      next.hidden = true;
      next.setAttribute("aria-hidden", "true");
      next.addEventListener("load", () => {
        // A download never loads into the frame; an answer that did is the server's refusal, as JSON.
        let body = "";
        try {
          if (next.contentWindow?.location.href === "about:blank") return;
          body = next.contentDocument?.body?.textContent ?? "";
        } catch {
          return;
        }
        let refusal: { error?: unknown; code?: unknown } = {};
        try {
          refusal = JSON.parse(body);
        } catch {
          // Not ours to explain.
        }
        setZip({ state: "failed", message: failureText(failureOf(typeof refusal.code === "string" ? refusal.code : undefined), serverMessage(refusal.error)) });
      });
      next.src = shareEndpoint(token, "zip", { path });
      document.body.append(next);
      frame.current = next;
      setZip({ state: "started", name });
    },
    [token, forget]
  );

  const dismiss = useCallback(() => setZip({ state: "idle" }), []);
  return { zip, start, dismiss };
}
