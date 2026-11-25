import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Inbox } from "lucide-react";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { KagoChoice } from "@/components/kago/choice";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { KagoSpinner } from "@/components/kago/empty-state";
import { FileTile } from "@/components/kago/file-icon";
import { ItemPickerDialog, type PickedItem } from "@/components/kago/folder-picker";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { KagoSwitch } from "@/components/kago/switch";
import { Button } from "@/components/ui/button";
import { FieldGroup, Input } from "@/components/ui/input";
import { displayPath, parentPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { MIN_SHARE_PASSWORD, parseDownloadLimit, shareProblem, type ShareMode, type ShareProblem } from "@/lib/shareModel";
import { toast } from "@/stores/toast";
import type { Root, ShareLink } from "@/types/kago";
import { ExpiryField, resolveValidity, type Validity } from "./ExpiryField";
import { copyShare } from "./useShareActions";
import { shareModes } from "./shareUtils";
import { t } from "@/lib/i18n";

const modeIcons = { download: <Download />, view_only: <Eye />, upload_only: <Inbox /> };

/** Said beside the button when it cannot be pressed, so that it is never dead without a reason. */
const reasons: Record<ShareProblem, () => string> = {
  "no-item": () => t("Choose what to share first"),
  "file-needs-folder": () => t("Choose a folder to receive uploads"),
  "folder-needs-file": () => t("Choose a file, or let them upload instead"),
  "readonly-drop-box": () => t("A read-only location can’t receive uploads"),
  "password-short": () => t("The password needs at least {count} characters", { count: MIN_SHARE_PASSWORD }),
  "limit-invalid": () => t("Enter a download limit of 1 or more"),
  "expiry-missing": () => t("Pick the last day it works"),
  "expiry-past": () => t("The last day has to be in the future")
};

/** Said under the choices when the item and what they can do do not go together: the server only takes a file to download or view, and a folder to upload into. */
const mismatch: Partial<Record<ShareProblem, () => string>> = {
  "file-needs-folder": () => t("Uploading needs a folder. Change what to share to a folder."),
  "folder-needs-file": () => t("Only a file can be downloaded or viewed. Change what to share to a file.")
};

/**
 * Creates a share link: what to share, what they can do with it, how long it works, and the two things that need a value.
 * With `item` it opens on that item (from the info panel); without it the first thing asked is what to share.
 * The link is put on the clipboard once it is made, and stays in the list to be copied again.
 */
export function ShareDialog({ open, onClose, roots, item }: { open: boolean; onClose: () => void; roots: Root[]; item?: PickedItem | null }) {
  return (
    <KagoDialog open={open} onClose={onClose} title={t("Create share link")} className="w-[min(480px,calc(100%-32px))]">
      {open ? <ShareDialogBody roots={roots} initial={item ?? null} onClose={onClose} /> : null}
    </KagoDialog>
  );
}

function ShareDialogBody({ roots, initial, onClose }: { roots: Root[]; initial: PickedItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState<PickedItem | null>(initial);
  const [mode, setMode] = useState<ShareMode>(initial?.kind === "folder" ? "upload_only" : "download");
  const [validity, setValidity] = useState<Validity>({ choice: "7", custom: "" });
  const [passwordOn, setPasswordOn] = useState(false);
  const [password, setPassword] = useState("");
  const [limitOn, setLimitOn] = useState(false);
  const [limit, setLimit] = useState("10");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = item ? roots.find((entry) => entry.slug === item.rootSlug) : undefined;
  const dropBox = mode === "upload_only";
  const problem = shareProblem({ item: item && { kind: item.kind, readonly: Boolean(root?.readonly) }, mode, password: passwordOn ? password : null, limit: limitOn && !dropBox ? limit : null, expiry: resolveValidity(validity) });

  function choose(next: PickedItem) {
    setItem(next);
    // What is chosen decides what they can be let do: a folder can only be uploaded into, a file only fetched.
    if (next.kind === "folder") setMode("upload_only");
    else if (mode === "upload_only") setMode("download");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const expiry = resolveValidity(validity);
    if (problem || busy || !item || !("at" in expiry)) return;
    setBusy(true);
    const made = await run(async () => {
      const share = await api<ShareLink>("/api/shares", {
        method: "POST",
        body: JSON.stringify({
          rootSlug: item.rootSlug,
          path: item.path,
          mode,
          ...(passwordOn ? { password } : {}),
          ...(expiry.at ? { expiresAt: expiry.at } : {}),
          ...(limitOn && !dropBox ? { maxDownloads: parseDownloadLimit(limit) } : {})
        })
      });
      await queryClient.invalidateQueries({ queryKey: keys.shares() });
      return share;
    }, t("Couldn’t create the share"));
    setBusy(false);
    if (!made) return;
    onClose();
    if (made.token) await copyShare(made, t("Share link created and copied"));
    else toast(t("Share link created"));
  }

  return (
    <form className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3" onSubmit={submit}>
      <FieldGroup label={t("What to share")}>
        <div className="kago-card flex items-center gap-2.5 rounded-md border border-line py-2 pr-2 pl-2.5">
          {item ? (
            <>
              <FileTile item={item} className="size-8" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{item.name || root?.name}</span>
                <span className="truncate text-xs text-muted">{item.path === "/" ? t("Whole location") : displayPath(root?.name ?? item.rootSlug, parentPath(item.path))}</span>
              </div>
            </>
          ) : (
            <span className="min-w-0 flex-1 text-muted">{t("A file or a folder")}</span>
          )}
          <Button onClick={() => setPicking(true)}>{item ? t("Change…") : t("Choose…")}</Button>
        </div>
        <ItemPickerDialog open={picking} onClose={() => setPicking(false)} title={t("What to share")} roots={roots} value={item ?? { rootSlug: (roots.find((entry) => !entry.readonly) ?? roots[0])?.slug ?? "", path: "/" }} onChoose={choose} />
      </FieldGroup>

      <FieldGroup label={t("They can")}>
        <KagoChoice
          label={t("They can")}
          value={mode}
          onChange={setMode}
          options={shareModes.map((entry) => ({ value: entry.value, label: entry.label, description: entry.description, icon: modeIcons[entry.value] }))}
        />
        {problem && mismatch[problem] ? <p role="alert" className="m-0 mt-1 text-xs text-warning">{mismatch[problem]!()}</p> : null}
      </FieldGroup>

      <FieldGroup label={t("Valid for")}>
        <ExpiryField value={validity} onChange={setValidity} />
      </FieldGroup>

      <div className="flex flex-col">
        <KagoSwitch label={t("Require a password")} checked={passwordOn} onChange={setPasswordOn}>
          <KagoPasswordInput aria-label={t("Password")} autoFocus autoComplete="new-password" className="w-44" value={password} onChange={(event) => setPassword(event.target.value)} />
        </KagoSwitch>
        {dropBox ? null : (
          <KagoSwitch label={t("Limit downloads")} checked={limitOn} onChange={setLimitOn}>
            <Input type="number" min="1" step="1" aria-label={t("Download limit")} className="w-24" value={limit} onChange={(event) => setLimit(event.target.value)} />
          </KagoSwitch>
        )}
      </div>

      <KagoDialogActions>
        {problem ? <span role="status" className="mr-auto flex min-w-0 items-center text-xs text-muted">{reasons[problem]()}</span> : null}
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={Boolean(problem) || busy}>{busy ? <KagoSpinner className="text-inherit" /> : null}{t("Create and copy link")}</Button>
      </KagoDialogActions>
    </form>
  );
}
