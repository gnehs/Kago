import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewUrl } from "@/api/client";
import { parentPath } from "@/lib/paths";

const isRelative = (url: string) => url !== "" && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);

/** A path written in the document, taken from the document's folder and kept inside the location. */
function resolvePath(folder: string, relative: string) {
  const parts = relative.startsWith("/") ? [] : folder.split("/").filter(Boolean);
  for (const part of relative.split(/[?#]/)[0]!.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function decode(value: string) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Markdown as a page. Raw HTML in the source is shown as text, never run. */
export default function MarkdownView({ text, rootSlug, path }: { text: string; rootSlug: string; path: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <article className="kago-markdown mx-auto max-w-3xl px-8 py-6 select-text">
        <Markdown
          remarkPlugins={[remarkGfm]}
          // Pictures stored next to the document are served through the same permission check as the document.
          urlTransform={(url, key) => (key === "src" && isRelative(url) ? previewUrl(rootSlug, resolvePath(parentPath(path), decode(url))) : defaultUrlTransform(url))}
          components={{
            // Only links that leave Kago go anywhere; a link to a neighbouring file has no page to open.
            a: ({ href, children }) =>
              href && /^(https?:|mailto:)/i.test(href) ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ src, alt }) => <img src={src} alt={alt ?? ""} loading="lazy" draggable={false} />
          }}
        >
          {text}
        </Markdown>
      </article>
    </div>
  );
}
