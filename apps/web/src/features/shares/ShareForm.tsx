import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { KagoCopyButton } from "@/components/kago/copy-field";
import { FolderField, type FolderRef } from "@/components/kago/folder-picker";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { Root } from "@/types/kago";
import { copyShareLink, shareModes, type ShareMode } from "./shareUtils";
import { t } from "@/lib/i18n";

/**
 * Creates a public share link. With `target` the location is fixed (inspector);
 * without it the form asks for a root and path (shares page).
 */
export function ShareForm({ target, roots = [], compact }: { target?: { rootSlug: string; path: string }; roots?: Root[]; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [rootSlug, setRootSlug] = useState(roots[0]?.slug ?? "");
  const [path, setPath] = useState("");
  const [folder, setFolder] = useState<FolderRef>({ rootSlug: (roots.find((root) => !root.readonly) ?? roots[0])?.slug ?? "", path: "/" });
  const [mode, setMode] = useState<ShareMode>("download");
  const [password, setPassword] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const dropBox = mode === "upload_only";
  // Only a file can be downloaded or viewed and only a folder can be uploaded into, so "/" never stands for a file.
  const filePath = normalizeLogicalPath(path) ?? "";
  const location = target ?? (dropBox ? folder : { rootSlug: rootSlug || roots[0]?.slug || "", path: filePath === "/" ? "" : filePath });
  const passwordInvalid = password.length > 0 && password.length < 8;
  const canSubmit = Boolean(location.rootSlug && location.path) && !passwordInvalid;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const days = Number(expiresDays);
    const downloads = Number(maxDownloads);
    await run(async () => {
      const share = await api<{ token: string }>("/api/shares", {
        method: "POST",
        body: JSON.stringify({
          ...location,
          mode,
          ...(password ? { password } : {}),
          ...(days > 0 ? { expiresAt: Math.floor(Date.now() / 1000) + days * 86400 } : {}),
          ...(downloads > 0 ? { maxDownloads: downloads } : {})
        })
      });
      // The token is only returned once; the server stores just its hash.
      const url = `${globalThis.location.origin}/s/${share.token}`;
      setShareUrl(url);
      setCopied(await copyShareLink(url));
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["shares"] });
    }, t("Couldn’t create the share"));
  }

  return (
    <form className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3")} onSubmit={submit}>
      <Field label={t("Permission")} className={compact || !target ? "col-span-full" : ""}>
        <Select value={mode} onChange={(event) => setMode(event.target.value as ShareMode)}>
          {shareModes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
      </Field>
      {target ? null : dropBox ? (
        <FolderField className="col-span-full" label={t("Folder to upload into")} roots={roots} value={folder} writable onChange={setFolder} />
      ) : (
        <>
          <Field label={t("Location")}>
            <Select value={location.rootSlug} onChange={(event) => setRootSlug(event.target.value)}>
              {roots.map((root) => <option key={root.id} value={root.slug}>{root.name}</option>)}
            </Select>
          </Field>
          <Field label={t("File path (a file, not a folder)")} className={compact ? "" : "md:col-span-2"}>
            <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/public/file.jpg" />
          </Field>
        </>
      )}
      <Field label={t("Days valid")}>
        <Input type="number" min="1" value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} placeholder={t("Unlimited")} />
      </Field>
      <Field label={t("Download limit")}>
        <Input type="number" min="1" value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} placeholder={t("Unlimited")} />
      </Field>
      <Field label={t("Password (optional)")} error={passwordInvalid ? t("At least 8 characters") : undefined} className="col-span-2">
        <KagoPasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <div className={cn("flex items-end", compact ? "col-span-2" : "")}>
        <Button type="submit" variant="default" className="w-full" disabled={!canSubmit}>{t("Create share link")}</Button>
      </div>
      {shareUrl ? (
        <div className="col-span-full flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input readOnly value={shareUrl} aria-label={t("Share link")} onFocus={(event) => event.target.select()} />
            <KagoCopyButton text={shareUrl} />
          </div>
          <p className="m-0 text-xs text-muted" role="status">{copied ? `${t("Link copied to the clipboard.")} ` : ""}{t("Copy the link now. It can’t be shown again.")}</p>
        </div>
      ) : null}
    </form>
  );
}
