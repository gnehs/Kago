import { useEffect, useState } from "react";
import { Check, Download, FileText, Upload } from "lucide-react";
import { api } from "@/api/client";
import { KagoLoading } from "@/components/kago/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { AuthCard, FormError } from "@/features/auth/AuthCard";
import { errorMessage } from "@/lib/format";
import { baseName, nfc } from "@/lib/paths";
import { isUploadCancelled, uploadForm, uploadLabel } from "@/stores/uploads";
import { t } from "@/lib/i18n";

type PublicShareInfo = {
  id: string;
  mode: "view_only" | "download" | "upload_only";
  path?: string;
  rootSlug?: string;
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
  const title = share?.path ? baseName(share.path) || share.rootSlug || t("Share link") : needsPassword ? t("Protected share") : t("Share link");
  const subtitle = share?.mode === "upload_only" ? t("Upload files to this location") : t("Shared with Kago");

  return (
    <AuthCard title={title} subtitle={subtitle}>
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        {!share && !error ? <KagoLoading /> : null}
        {needsPassword ? (
          <form className="flex flex-col gap-3" onSubmit={authenticate}>
            <Field label={t("Share password")}>
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
            </Field>
            <Button type="submit" variant="default" size="lg" disabled={busy || !password}>{t("Unlock")}</Button>
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
    </AuthCard>
  );
}
