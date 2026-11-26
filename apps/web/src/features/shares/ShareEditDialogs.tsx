import { useState } from "react";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { Button } from "@/components/ui/button";
import { FieldGroup, Input } from "@/components/ui/input";
import { parseDownloadLimit } from "@/lib/shareModel";
import type { ShareLink } from "@/types/kago";
import { ExpiryField, resolveValidity, type Validity } from "./ExpiryField";
import { t } from "@/lib/i18n";

/** Which part of a share is being changed, and for which. */
export type ShareEdit = { share: ShareLink; field: "expiry" | "limit"; name: string; /** The share is switched off too, so the same save switches it on. */ enable?: boolean };

type Change = { disabled?: boolean; expiresAt?: number | null; maxDownloads?: number | null };

const ENABLE_NOTE = () => t("This link is switched off too. Saving turns it on again.");

/**
 * Asks for a new expiry or a new download limit of one share. `save` makes the change and answers whether it was made;
 * the dialog closes once it has been.
 */
export function ShareEditDialog({ edit, onClose, save }: { edit: ShareEdit | null; onClose: () => void; save: (share: ShareLink, change: Change) => Promise<boolean> }) {
  return (
    <KagoDialog open={Boolean(edit)} onClose={onClose} title={edit?.field === "limit" ? t("Change download limit") : t("Change expiry")} className="w-[min(420px,calc(100%-32px))]">
      {edit ? edit.field === "limit" ? <LimitBody edit={edit} onClose={onClose} save={save} /> : <ExpiryBody edit={edit} onClose={onClose} save={save} /> : null}
    </KagoDialog>
  );
}

type BodyProps = { edit: ShareEdit; onClose: () => void; save: (share: ShareLink, change: Change) => Promise<boolean> };

function ExpiryBody({ edit, onClose, save }: BodyProps) {
  const [validity, setValidity] = useState<Validity>({ choice: "7", custom: "" });
  const [busy, setBusy] = useState(false);
  const resolved = resolveValidity(validity);
  const ready = "at" in resolved;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    if (await save(edit.share, { expiresAt: resolved.at, ...(edit.enable ? { disabled: false } : {}) })) onClose();
    setBusy(false);
  }

  return (
    <form className="flex flex-col gap-4 p-4 pt-3" onSubmit={submit}>
      <p className="m-0 min-w-0 truncate text-muted">{edit.name}</p>
      <ExpiryField value={validity} onChange={setValidity} />
      {edit.enable ? <p className="m-0 -mt-2 text-xs text-muted">{ENABLE_NOTE()}</p> : null}
      <KagoDialogActions>
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={!ready || busy}>{t("Save")}</Button>
      </KagoDialogActions>
    </form>
  );
}

function LimitBody({ edit, onClose, save }: BodyProps) {
  const used = edit.share.download_count;
  // A link that stopped at its limit is given room for as many again; one that has none starts from what is used.
  const [text, setText] = useState(String(edit.share.max_downloads ? Math.max(edit.share.max_downloads, used) + 10 : used + 10));
  const [busy, setBusy] = useState(false);
  const value = parseDownloadLimit(text);
  const tooLow = value !== null && value <= used;

  async function commit(next: number | null) {
    if (busy) return;
    setBusy(true);
    if (await save(edit.share, { maxDownloads: next, ...(edit.enable ? { disabled: false } : {}) })) onClose();
    setBusy(false);
  }

  return (
    <form className="flex flex-col gap-4 p-4 pt-3" onSubmit={(event) => {
      event.preventDefault();
      if (value !== null) void commit(value);
    }}>
      <p className="m-0 min-w-0 truncate text-muted">{edit.name}</p>
      <FieldGroup label={t("Most downloads")} hint={t("{count} download so far | {count} downloads so far", { count: used })}>
        <Input autoFocus type="number" min="1" step="1" aria-label={t("Most downloads")} value={text} onChange={(event) => setText(event.target.value)} />
      </FieldGroup>
      {edit.enable ? <p className="m-0 -mt-2 text-xs text-muted">{ENABLE_NOTE()}</p> : null}
      {tooLow ? <p role="alert" className="m-0 -mt-2 text-xs text-warning">{t("That is not more than has been downloaded, so the link would stay shut.")}</p> : null}
      <KagoDialogActions>
        {edit.share.max_downloads ? <Button className="mr-auto" onClick={() => void commit(null)} disabled={busy}>{t("No limit")}</Button> : null}
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={value === null || busy}>{t("Save")}</Button>
      </KagoDialogActions>
    </form>
  );
}
