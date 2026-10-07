import { Fragment, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { KagoDropdownMenu, KagoMenuItem } from "@/components/kago/menu";
import { controlClass } from "@/components/ui/input";
import { EDIT_ADDRESS_EVENT } from "@/features/workspace/useShortcuts";
import { nfc, normalizeLogicalPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { FileWindow } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { t } from "@/lib/i18n";

const FOLDER = { kind: "folder", type: "", name: "" } as const;
const MAX_VISIBLE_SEGMENTS = 3;

/** Path bar: clickable crumbs by default, an editable address after clicking the blank area or ⌘L. */
export function Breadcrumb({ window, rootName, onNavigate }: { window: FileWindow; rootName: string; onNavigate: (path: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const onEdit = (event: Event) => {
      if ((event as CustomEvent<string>).detail === window.id) setDraft(window.logicalPath);
    };
    globalThis.addEventListener(EDIT_ADDRESS_EVENT, onEdit);
    return () => globalThis.removeEventListener(EDIT_ADDRESS_EVENT, onEdit);
  }, [window.id, window.logicalPath]);

  function commit(value: string) {
    setDraft(null);
    const next = normalizeLogicalPath(value, window.rootSlug);
    if (!next) toast(t("That path isn’t valid"), "error");
    else if (next !== window.logicalPath) onNavigate(next);
  }

  if (draft !== null) {
    return (
      <input
        autoFocus
        aria-label={t("Current path")}
        className={cn(controlClass, "flex-1")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
    );
  }

  const segments = window.logicalPath.split("/").filter(Boolean);
  const crumbs = [{ label: rootName, path: "/" }, ...segments.map((segment, index) => ({ label: nfc(segment), path: `/${segments.slice(0, index + 1).join("/")}` }))];
  const hidden = Math.max(0, crumbs.length - MAX_VISIBLE_SEGMENTS);
  const visible = hidden > 0 ? [crumbs[0]!, ...crumbs.slice(hidden + 1)] : crumbs;
  /** The folders in between that there is no room to spell out, outermost first. */
  const folded = crumbs.slice(1, hidden + 1);

  return (
    <nav
      aria-label={t("Path")}
      className="flex h-(--kago-control-h) min-w-0 flex-1 items-center rounded-md px-1 hover:bg-hover"
      title={t("Click the empty space to type a path")}
      onClick={(event) => event.target === event.currentTarget && setDraft(window.logicalPath)}
    >
      {visible.map((crumb, index) => {
        const isLast = index === visible.length - 1;
        return (
          <Fragment key={crumb.path}>
            {index > 0 ? <ChevronRight className="size-3.5 text-faint" /> : null}
            {index === 1 && hidden > 0 ? (
              <>
                <KagoDropdownMenu
                  label={t("Show the folders in between")}
                  align="start"
                  className="h-auto w-auto rounded-sm px-1.5 py-0.5"
                  menu={folded.map((crumb) => (
                    <KagoMenuItem key={crumb.path} icon={<FileIcon item={FOLDER} />} onClick={() => onNavigate(crumb.path)}>
                      <span className="max-w-64 truncate">{crumb.label}</span>
                    </KagoMenuItem>
                  ))}
                >
                  …
                </KagoDropdownMenu>
                <ChevronRight className="size-3.5 text-faint" />
              </>
            ) : null}
            <button
              className={cn("max-w-40 shrink truncate rounded-sm px-1.5 py-0.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50", isLast ? "shrink-0 font-medium text-ink" : "text-muted")}
              aria-current={isLast ? "location" : undefined}
              onClick={() => !isLast && onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
