import { Ban, Copy, FolderInput, Upload, X } from "lucide-react";
import { KagoMenuButton, KagoMenuNote, KagoMenuSeparator } from "@/components/kago/menu";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { folderTitle } from "@/stores/workspace";
import type { FolderWindow } from "@/types/kago";
import type { DropChoice } from "./useFileDrop";
import type { FileActions } from "./useFileActions";

/** What the window says about what is held over it, and the menu that asks what to do with what was dropped. */
export function DropLayer({ win, active, readonly, choice, actions, onClose }: { win: FolderWindow; active: false | "files" | "items"; readonly: boolean; choice: DropChoice | null; actions: FileActions; onClose: () => void }) {
  return (
    <>
      {active ? (
        <div className={cn("pointer-events-none absolute inset-0 z-20 rounded-[inherit]", !readonly && "ring-2 ring-accent ring-inset")}>
          {/* Files brought from outside are told what letting go will do, or why it will do nothing. */}
          {active === "files" ? (
            <span className="absolute bottom-11 left-1/2 flex h-8 max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 kago-glass rounded-full pr-3.5 pl-3 font-medium whitespace-nowrap">
              {readonly ? <Ban className="text-muted" /> : <Upload className="text-accent" />}
              <span className="truncate">{readonly ? t("This location is read-only.") : t("Drop to upload")}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {choice ? (
        <>
          <div className="absolute inset-0 z-20" onClick={onClose} />
          {/* What to do with what was dropped is picked from a menu where it was dropped, as any other choice of one action is. Copying is the one already chosen, since it loses nothing. */}
          <div
            role="menu"
            aria-label={t("{count} item | {count} items", { count: choice.sources.length })}
            className="absolute z-30 kago-glass flex min-w-44 flex-col rounded-lg p-1 select-none"
            style={{ left: Math.max(8, choice.x), top: Math.max(44, choice.y) }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll("button")];
              const at = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
            }}
          >
            <KagoMenuNote className="max-w-60 truncate">
              {t("{count} item | {count} items", { count: choice.sources.length })}{choice.destination.path === win.logicalPath && choice.destination.rootSlug === win.rootSlug ? "" : ` → ${folderTitle(choice.destination.rootSlug, choice.destination.path)}`}
            </KagoMenuNote>
            {(["copy", "move"] as const).map((type) => (
              <KagoMenuButton
                key={type}
                autoFocus={type === "copy"}
                icon={type === "copy" ? <Copy /> : <FolderInput />}
                onClick={() => {
                  void actions.transfer(type, choice.sources, choice.destination);
                  onClose();
                }}
              >
                {type === "copy" ? t("Copy here") : t("Move here")}
              </KagoMenuButton>
            ))}
            <KagoMenuSeparator />
            <KagoMenuButton icon={<X />} onClick={onClose}>{t("Cancel")}</KagoMenuButton>
          </div>
        </>
      ) : null}
    </>
  );
}
