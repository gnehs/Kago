import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { KagoDialog } from "@/components/kago/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { t } from "@/lib/i18n";

export type CompressLevel = "store" | "fast" | "normal" | "best";
export type CompressEncryption = "aes256" | "zipcrypto";
export type CompressChoice = { name: string; options: { level: CompressLevel; password?: string; encryption?: CompressEncryption } };

type CompressRequest = { title: string; defaultName: string; resolve: (choice: CompressChoice | null) => void };

const useCompressStore = create<{ request: CompressRequest | null }>(() => ({ request: null }));

/** Asks what to call the archive, how hard to squeeze it and whether to lock it. */
export function promptCompress(options: { title: string; defaultName: string }) {
  return new Promise<CompressChoice | null>((resolve) => {
    useCompressStore.getState().request?.resolve(null);
    useCompressStore.setState({ request: { ...options, resolve } });
  });
}

function settle(choice: CompressChoice | null) {
  useCompressStore.getState().request?.resolve(choice);
  useCompressStore.setState({ request: null });
}

export function CompressDialogHost() {
  const pending = useCompressStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<CompressLevel>("normal");
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [encryption, setEncryption] = useState<CompressEncryption>("aes256");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending) return;
    setRequest(pending);
    setName(pending.defaultName);
    setPassword("");
    setRepeated("");
    const frame = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [pending]);

  if (!request) return null;
  const mismatch = password !== repeated;
  const canSubmit = name.trim().length > 0 && !mismatch;

  return (
    <KagoDialog open={Boolean(pending)} onClose={() => settle(null)} title={request.title}>
      <form
        className="flex flex-col gap-3 p-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settle({ name: name.trim(), options: { level, ...(password ? { password, encryption } : {}) } });
        }}
      >
        <Field label={t("Name")}>
          <Input ref={input} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("Compression")}>
          <Select value={level} onChange={(event) => setLevel(event.target.value as CompressLevel)}>
            <option value="store">{t("None (store only)")}</option>
            <option value="fast">{t("Fast")}</option>
            <option value="normal">{t("Normal")}</option>
            <option value="best">{t("Smallest (slower)")}</option>
          </Select>
        </Field>
        <Field label={t("Password")} hint={password ? undefined : t("Leave empty for an archive anyone can open")}>
          <KagoPasswordInput autoComplete="new-password" value={password} placeholder={t("No password")} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {password ? (
          <>
            <Field label={t("Repeat password")} hint={repeated && mismatch ? t("The passwords don’t match") : undefined}>
              <KagoPasswordInput autoComplete="new-password" value={repeated} onChange={(event) => setRepeated(event.target.value)} />
            </Field>
            <Field
              label={t("Encryption")}
              hint={encryption === "aes256"
                ? t("Secure, but opening it may take an app such as 7-Zip or Keka. File names stay visible.")
                : t("Opens almost anywhere, but is easy to break. File names stay visible.")}
            >
              <Select value={encryption} onChange={(event) => setEncryption(event.target.value as CompressEncryption)}>
                <option value="aes256">AES-256</option>
                <option value="zipcrypto">ZipCrypto</option>
              </Select>
            </Field>
          </>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => settle(null)}>{t("Cancel")}</Button>
          <Button type="submit" variant="default" disabled={!canSubmit}>{t("Compress")}</Button>
        </div>
      </form>
    </KagoDialog>
  );
}
