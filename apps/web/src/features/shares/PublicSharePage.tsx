import { useEffect, useState } from "react";
import { Check, Download, FileText, Unlink, Upload } from "lucide-react";
import { api } from "@/api/client";
import { KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { AuthCard, FormError } from "@/components/kago/auth-card";
import { FileTile } from "@/components/kago/file-icon";
import { errorMessage, formatSize } from "@/lib/format";
import { baseName, nfc } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { isUploadCancelled, uploadForm, uploadLabel, useUploadStore } from "@/stores/uploads";
import { t } from "@/lib/i18n";

type PublicShareInfo = {
  id: string;
  mode: "view_only" | "download" | "upload_only";
  path?: string;
  rootSlug?: string;
  rootName?: string;
  /** The file's media type and size; a folder to upload into has neither. */
  type?: string;
  size?: number;
  /** Whether the browser can show the file itself; one it cannot would be downloaded instead of viewed. */
  previewable?: boolean;
  requiresPassword: boolean;
  authenticated: boolean;
};

// Taller than the desktop buttons: this page is opened on phones by people who were only handed a link.
const primaryLink = cn(buttonVariants({ variant: "default", size: "lg" }), "h-10");

export function PublicSharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShareInfo | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [failed, setFailed] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const progress = useUploadStore((state) => state.uploads[0]);
  const [refused, setRefused] = useState(0);

  useEffect(() => {
    void loadShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loadShare` is made anew every render and sets state; the share is read again only for a new token.
  }, [token]);

  async function loadShare() {
    setError("");
    try {
      setShare(await api<PublicShareInfo>(`/s/${token}`, { headers: { Accept: "application/json" } }));
    } catch (err) {
      setError(errorMessage(err, t("This share link isn’t available")));
    }
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/s/${token}/auth`, { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      await loadShare();
    } catch (err) {
      setError(errorMessage(err, t("Couldn’t verify the password")));
      setRefused((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  async function send(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError("");
    setFailed([]);
    try {
      const form = new FormData();
      for (const file of files) form.append("file", file, nfc(file.name));
      await uploadForm(`/s/${token}/upload`, form, uploadLabel(files));
      setUploaded((names) => [...names, ...files.map((file) => nfc(file.name))]);
    } catch (err) {
      if (!isUploadCancelled(err)) {
        setError(`${t("Couldn’t upload {name}", { name: uploadLabel(files) })}. ${errorMessage(err, t("Upload failed"))}`);
        setFailed(files);
      }
    } finally {
      setBusy(false);
    }
  }

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void send(files);
  }

  function drop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    void send([...event.dataTransfer.files]);
  }

  const needsPassword = Boolean(share?.requiresPassword && !share.authenticated);
  // A link that leads nowhere says so in place of a name, and has nothing to offer underneath.
  const gone = !share && Boolean(error);
  const title = gone ? t("This share link isn’t available") : share?.path ? baseName(share.path) || share.rootName || share.rootSlug || t("Share link") : needsPassword ? t("Protected share") : t("Share link");
  const subtitle = gone ? (error === title ? t("Ask whoever sent it for a new one.") : error) : share?.mode === "upload_only" ? t("Upload files to this location") : [typeof share?.size === "number" ? formatSize(share.size) : null, t("Shared with Kago")].filter(Boolean).join(" · ");
  // What was shared is shown as itself: a share to upload into is a folder, any other is a file.
  const icon = gone ? <span className="kago-badge flex size-14 items-center justify-center rounded-full text-faint"><Unlink className="size-6" /></span> : share?.path ? <FileTile item={{ kind: share.mode === "upload_only" ? "folder" : "file", type: share.type ?? "", name: baseName(share.path) }} className="size-16" /> : undefined;

  return (
    <AuthCard title={title} subtitle={subtitle} icon={icon} refused={refused}>
      {gone ? null : (
        <div className="flex flex-col gap-3">
          <FormError message={error} />
          {!share && !error ? <KagoLoading /> : null}
          {needsPassword ? (
            <form className="flex flex-col gap-3" onSubmit={authenticate}>
              <Field label={t("Share password")}>
                <KagoPasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" autoFocus />
              </Field>
              <Button type="submit" variant="default" size="lg" className="h-10" disabled={busy || !password}>{busy ? <KagoSpinner className="text-inherit" /> : null}{t("Unlock")}</Button>
            </form>
          ) : null}
          {share && !needsPassword ? (
            <>
              {share.mode === "download" ? <a className={primaryLink} href={`/s/${token}/download`}><Download />{" "}{t("Download")}</a> : null}
              {share.mode === "view_only" && share.previewable ? <a className={primaryLink} href={`/s/${token}/preview`} target="_blank" rel="noreferrer"><FileText />{" "}{t("View")}</a> : null}
              {share.mode === "view_only" && !share.previewable ? <p className="m-0 text-center text-muted">{t("This kind of file can’t be viewed in the browser.")}</p> : null}
              {share.mode === "upload_only" ? (
                <div
                  className={cn("flex flex-col gap-3 rounded-lg border border-dashed p-3 transition-colors", dragging ? "border-accent bg-hover" : "border-(--kago-window-edge)")}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                  }}
                  onDrop={drop}
                >
                  {busy ? <UploadProgress loaded={progress?.loaded ?? 0} total={progress?.total ?? 0} label={progress?.label ?? ""} onCancel={() => progress?.cancel()} /> : (
                    <>
                      <label className={primaryLink}>
                        <Upload /> {failed.length ? t("Choose other files") : uploaded.length ? t("Choose more files") : t("Choose files to upload")}
                        <input type="file" multiple hidden onChange={pick} />
                      </label>
                      {failed.length ? <Button size="lg" className="h-10" onClick={() => void send(failed)}>{t("Try again")}</Button> : null}
                      <p className="m-0 text-center text-xs text-muted">{t("Or drop files here")}</p>
                    </>
                  )}
                  {uploaded.length ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="m-0 flex items-center justify-center gap-1.5 text-success"><Check />{" "}{t("{count} file uploaded | {count} files uploaded", { count: uploaded.length })}</p>
                      <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto p-0 text-xs text-muted">
                        {uploaded.map((name, index) => <li key={index} className="truncate">{name}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </AuthCard>
  );
}

function UploadProgress({ loaded, total, label, onCancel }: { loaded: number; total: number; label: string; onCancel: () => void }) {
  const fraction = total > 0 ? Math.min(loaded / total, 1) : 0;
  const percent = Math.floor(fraction * 100);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 truncate text-center">{label}</p>
      <div role="progressbar" aria-label={t("Uploading…")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="kago-well h-2 overflow-hidden rounded-full">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <p className="m-0 flex justify-between text-xs text-muted tabular-nums">
        <span>{fraction >= 1 ? t("Processing…") : `${formatSize(loaded)} / ${formatSize(total)}`}</span>
        <span>{percent}%</span>
      </p>
      <Button size="lg" className="h-10" onClick={onCancel}>{t("Cancel")}</Button>
    </div>
  );
}
