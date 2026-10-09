import { useEffect, useState } from "react";
import { Check, Download, FileText, Unlink, Upload } from "lucide-react";
import { api } from "@/api/client";
import { KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { AuthCard, FormError } from "@/components/kago/auth-card";
import { FileTile } from "@/features/files/FileIcon";
import { errorMessage, formatSize } from "@/lib/format";
import { baseName, nfc } from "@/lib/paths";
import { isUploadCancelled, uploadForm, uploadLabel } from "@/stores/uploads";
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

const primaryLink = buttonVariants({ variant: "default", size: "lg" });

export function PublicSharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShareInfo | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [refused, setRefused] = useState(0);

  useEffect(() => {
    void loadShare();
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

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    setBusy(true);
    setError("");
    setUploaded(false);
    try {
      const form = new FormData();
      for (const file of files) form.append("file", file, nfc(file.name));
      await uploadForm(`/s/${token}/upload`, form, uploadLabel(files));
      setUploaded(true);
    } catch (err) {
      if (!isUploadCancelled(err)) setError(errorMessage(err, t("Upload failed")));
    } finally {
      event.target.value = "";
      setBusy(false);
    }
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
              <Button type="submit" variant="default" size="lg" disabled={busy || !password}>{busy ? <KagoSpinner className="text-inherit" /> : null}{t("Unlock")}</Button>
            </form>
          ) : null}
          {share && !needsPassword ? (
            <>
              {share.mode === "download" ? <a className={primaryLink} href={`/s/${token}/download`}><Download />{" "}{t("Download")}</a> : null}
              {share.mode === "view_only" && share.previewable ? <a className={primaryLink} href={`/s/${token}/preview`} target="_blank" rel="noreferrer"><FileText />{" "}{t("View")}</a> : null}
              {share.mode === "view_only" && !share.previewable ? <p className="m-0 text-center text-muted">{t("This kind of file can’t be viewed in the browser.")}</p> : null}
              {share.mode === "upload_only" ? (
                <label className={primaryLink} aria-disabled={busy}>
                  <Upload /> {busy ? t("Uploading…") : t("Choose files to upload")}
                  <input type="file" multiple hidden onChange={upload} disabled={busy} />
                </label>
              ) : null}
              {uploaded ? <p className="m-0 flex items-center justify-center gap-1.5 text-success"><Check />{" "}{t("Uploaded")}</p> : null}
            </>
          ) : null}
        </div>
      )}
    </AuthCard>
  );
}
