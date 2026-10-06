import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { normalizeLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { cn, copyText } from "@/lib/utils";
import type { Root } from "@/types/kago";
import { shareModes, type ShareMode } from "./shareUtils";

/**
 * Creates a public share link. With `target` the location is fixed (inspector);
 * without it the form asks for a root and path (shares page).
 */
export function ShareForm({ target, roots = [], compact }: { target?: { rootSlug: string; path: string }; roots?: Root[]; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [rootSlug, setRootSlug] = useState(roots[0]?.slug ?? "");
  const [path, setPath] = useState("/");
  const [mode, setMode] = useState<ShareMode>("download");
  const [password, setPassword] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const location = target ?? { rootSlug: rootSlug || roots[0]?.slug || "", path: normalizeLogicalPath(path) ?? "" };
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
      setShareUrl(`${globalThis.location.origin}/s/${share.token}`);
      setCopied(false);
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["shares"] });
    }, "建立分享失敗");
  }

  async function copy() {
    await copyText(shareUrl);
    setCopied(true);
  }

  return (
    <form className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3")} onSubmit={submit}>
      {target ? null : (
        <>
          <Field label="位置">
            <Select value={location.rootSlug} onChange={(event) => setRootSlug(event.target.value)}>
              {roots.map((root) => <option key={root.id} value={root.slug}>{root.name}</option>)}
            </Select>
          </Field>
          <Field label="路徑" className={compact ? "" : "md:col-span-2"}>
            <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/public/file.jpg" />
          </Field>
        </>
      )}
      <Field label="權限" className={compact ? "col-span-2" : ""}>
        <Select value={mode} onChange={(event) => setMode(event.target.value as ShareMode)}>
          {shareModes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
      </Field>
      <Field label="有效天數">
        <Input type="number" min="1" value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} placeholder="不限" />
      </Field>
      <Field label="下載次數上限">
        <Input type="number" min="1" value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="不限" />
      </Field>
      <Field label="密碼（選填）" hint={passwordInvalid ? "至少 8 個字元" : undefined} className="col-span-2">
        <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <div className={cn("flex items-end", compact ? "col-span-2" : "")}>
        <Button type="submit" variant="default" className="w-full" disabled={!canSubmit}>建立分享連結</Button>
      </div>
      {shareUrl ? (
        <div className="col-span-full flex gap-2">
          <Input readOnly value={shareUrl} aria-label="分享連結" onFocus={(event) => event.target.select()} />
          <Button onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "已複製" : "複製"}</Button>
        </div>
      ) : null}
    </form>
  );
}
