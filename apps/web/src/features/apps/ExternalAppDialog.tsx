import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { create } from "zustand";
import { api, libraryIconUrl } from "@/api/client";
import { useIconSuggestions } from "@/api/hooks";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { ExternalApp, LibraryIcon } from "@/types/kago";
import { ExternalAppIcon } from "./ExternalAppIcon";

/** The shortcut whose form is open: one that is there, or one about to be added. */
const useEditorStore = create<{ editing: ExternalApp | "new" | null }>(() => ({ editing: null }));

/** Opens the form for a shortcut, or for a new one. It is one dialog, wherever it was asked for from. */
export const editExternalApp = (app: ExternalApp | "new") => useEditorStore.setState({ editing: app });
const close = () => useEditorStore.setState({ editing: null });

/** The libraries by their own names, which are not translated. */
const libraries: Record<string, string> = { "dashboard-icons": "Dashboard Icons", selfhst: "selfh.st Icons" };
/** The server takes no icon larger than this; one is turned away here before it is sent. */
const MAX_ICON_BYTES = 1024 * 1024;

/** What the shortcut is to wear once saved: the icon it has, none, one of a library's, or a picture of one's own. */
type IconChoice = { kind: "keep" } | { kind: "none" } | { kind: "library"; icon: LibraryIcon } | { kind: "upload"; file: File; preview: string };

/** An address as it was meant: one typed without saying how to reach it is a web address, and on a home network a plain one. */
const withScheme = (address: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`);

const base64Of = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(t("Couldn’t read the picture")));
    reader.readAsDataURL(file);
  });

export function ExternalAppDialogHost({ isAdmin }: { isAdmin: boolean }) {
  const editing = useEditorStore((state) => state.editing);
  // The last shortcut stays on show while its dialog fades out.
  const [shown, setShown] = useState(editing);
  if (editing && editing !== shown) setShown(editing);
  if (!shown) return null;
  return (
    <KagoDialog open={editing !== null} onClose={close} title={shown === "new" ? t("Add app") : t("Edit {name}", { name: shown.name })} className="w-[min(460px,calc(100vw-32px))]">
      <AppForm key={shown === "new" ? "new" : shown.id} app={shown === "new" ? null : shown} isAdmin={isAdmin} />
    </KagoDialog>
  );
}

function AppForm({ app, isAdmin }: { app: ExternalApp | null; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(app?.name ?? "");
  const [url, setUrl] = useState(app?.url ?? "");
  const [shared, setShared] = useState(app?.shared ?? false);
  const [choice, setChoice] = useState<IconChoice>(app ? { kind: "keep" } : { kind: "none" });
  // A new shortcut takes the icon that goes by its name, until one is chosen by hand. One that is there keeps what it has.
  const [chosen, setChosen] = useState(app !== null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The libraries are asked once the typing pauses, not at every letter.
  const [query, setQuery] = useState(name.trim());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(name.trim()), 250);
    return () => clearTimeout(timer);
  }, [name]);
  const suggestions = useIconSuggestions(query);
  const found = query ? suggestions.data : undefined;

  useEffect(() => {
    if (chosen || !found || suggestions.isPlaceholderData) return;
    const exact = found.items.find((item) => item.exact);
    setChoice(exact ? { kind: "library", icon: exact } : { kind: "none" });
  }, [chosen, found, suggestions.isPlaceholderData]);

  // A picture picked from this device is shown from memory until it is saved.
  useEffect(() => (choice.kind === "upload" ? () => URL.revokeObjectURL(choice.preview) : undefined), [choice]);

  const choose = (next: IconChoice) => {
    setChosen(true);
    setChoice(next);
  };

  function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) return toast(t("The icon is too large"), "error");
    choose({ kind: "upload", file, preview: URL.createObjectURL(file) });
  }

  const preview = choice.kind === "keep" ? app?.icon ?? null : choice.kind === "library" ? libraryIconUrl(choice.icon.source, choice.icon.name) : choice.kind === "upload" ? choice.preview : null;
  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    const saved = await run(async () => {
      const icon =
        choice.kind === "keep" ? undefined : choice.kind === "library" ? { kind: "library", source: choice.icon.source, name: choice.icon.name } : choice.kind === "upload" ? { kind: "upload", data: await base64Of(choice.file) } : { kind: "none" };
      // Only an administrator says whose a shortcut is; anyone else's request leaves that as it was.
      const body = JSON.stringify({ name: name.trim(), url: withScheme(url.trim()), shared: isAdmin ? shared : undefined, icon });
      await api(app ? `/api/external-apps/${app.id}` : "/api/external-apps", { method: app ? "PUT" : "POST", body });
      await queryClient.invalidateQueries({ queryKey: ["external-apps"] });
      return true;
    }, t("Couldn’t save the app"));
    setBusy(false);
    if (saved) close();
  }

  const hint = !query
    ? t("Type a name, and icons that match it are suggested here.")
    : !found
      ? t("Looking for icons…")
      : !found.available
        ? t("The icon libraries can’t be reached from this server. A picture can still be uploaded.")
        : found.items.length === 0
          ? t("No icon goes by that name. Upload a picture, or keep the default icon.")
          : t("Suggested from Dashboard Icons and selfh.st Icons. A PNG, JPEG, WebP or SVG picture up to 1 MB can be uploaded instead.");

  return (
    <form className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4 pt-3" onSubmit={submit}>
      <Field label={t("Name")}>
        <Input autoFocus value={name} maxLength={80} placeholder="Jellyfin" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t("Address##of a web page")} hint={t("It opens in a new tab.")}>
        <Input value={url} maxLength={2048} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="http://nas.local:8096" onChange={(event) => setUrl(event.target.value)} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">{t("Icon")}</span>
        <div className="flex items-start gap-3">
          <ExternalAppIcon name={name} icon={preview} className="size-14" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {found?.items.length ? (
              <div className="-m-1 flex flex-wrap">
                {found.items.map((item) => {
                  const selected = choice.kind === "library" && choice.icon.source === item.source && choice.icon.name === item.name;
                  return (
                    <KagoTooltip key={`${item.source}/${item.name}`} label={`${item.label} · ${libraries[item.source] ?? item.source}`}>
                      <button
                        type="button"
                        aria-label={item.label}
                        aria-pressed={selected}
                        className={cn("rounded-lg p-1.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50", selected && "kago-pressed hover:bg-transparent")}
                        onClick={() => choose({ kind: "library", icon: item })}
                      >
                        <ExternalAppIcon name={item.label} icon={libraryIconUrl(item.source, item.name)} className="size-9" />
                      </button>
                    </KagoTooltip>
                  );
                })}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => fileInput.current?.click()}><Upload />{t("Upload a picture…")}</Button>
              {preview ? <Button onClick={() => choose({ kind: "none" })}>{t("Use the default icon")}</Button> : null}
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                // The same picture can be picked again after another was tried.
                event.target.value = "";
              }}
            />
          </div>
        </div>
        <span className="text-xs text-faint">{hint}</span>
      </div>
      {isAdmin ? <Checkbox label={t("Show on everyone’s desktop")} checked={shared} onChange={(event) => setShared(event.target.checked)} /> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={close}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={!canSubmit}>{app ? t("Save") : t("Add app")}</Button>
      </div>
    </form>
  );
}
