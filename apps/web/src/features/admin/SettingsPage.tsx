import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { getDensity, getTheme, setDensity, setTheme, type DensityPref, type ThemePref } from "@/lib/prefs";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import type { Root } from "@/types/kago";

export function SettingsPage({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const [theme, setThemeState] = useState(getTheme);
  const [density, setDensityState] = useState(getDensity);

  return (
    <Page title="設定">
      <Card title="外觀">
        <div className="grid grid-cols-2 gap-3">
          <Field label="主題">
            <Select value={theme} onChange={(event) => { setTheme(event.target.value as ThemePref); setThemeState(event.target.value as ThemePref); }}>
              <option value="system">跟隨系統</option>
              <option value="light">淺色</option>
              <option value="dark">深色</option>
            </Select>
          </Field>
          <Field label="密度">
            <Select value={density} onChange={(event) => { setDensity(event.target.value as DensityPref); setDensityState(event.target.value as DensityPref); }}>
              <option value="comfortable">舒適</option>
              <option value="compact">緊湊</option>
            </Select>
          </Field>
        </div>
      </Card>
      {isAdmin ? <RootSettings roots={roots} /> : null}
    </Page>
  );
}

function RootSettings({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [basePath, setBasePath] = useState("");
  const [readonly, setReadonly] = useState(false);
  const slugValid = /^[a-z0-9_-]+$/.test(slug);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["roots"] });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!slugValid) return;
    await run(async () => {
      await api("/api/roots", { method: "POST", body: JSON.stringify({ slug, name: name.trim() || slug, ...(basePath.trim() ? { basePath: basePath.trim() } : {}), readonly }) });
      setName("");
      setSlug("");
      setBasePath("");
      setReadonly(false);
      await refresh();
    }, "新增 Root 失敗");
  }

  async function setRootReadonly(root: Root, next: boolean) {
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ readonly: next }) });
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["fs"] })]);
    });
  }

  async function remove(root: Root) {
    const confirmed = await confirmAction({
      title: `移除「${root.name}」？`,
      description: "只會從 Kago 移除這個位置與相關設定，磁碟上的檔案不會被刪除。",
      confirmLabel: "移除",
      destructive: true
    });
    if (!confirmed) return;
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "DELETE" });
      await refresh();
    }, "移除 Root 失敗");
  }

  return (
    <>
      <Card title="新增 Root">
        <p className="m-0 mb-3 text-muted">Root 是掛載在 /data 底下、要交給 Kago 管理的資料夾。</p>
        <form className="grid grid-cols-2 gap-3" onSubmit={create}>
          <Field label="顯示名稱"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="相片" /></Field>
          <Field label="代號（slug）" hint={slug && !slugValid ? "只能使用小寫英文、數字、- 與 _" : "建立後不建議修改"}>
            <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="photos" />
          </Field>
          <Field label="資料夾路徑" hint="留空會使用 /data/代號" className="col-span-2">
            <Input value={basePath} onChange={(event) => setBasePath(event.target.value)} placeholder={`/data/${slug || "photos"}`} />
          </Field>
          <div className="col-span-2 flex items-center justify-between">
            <Checkbox label="唯讀（停用所有寫入操作）" checked={readonly} onChange={(event) => setReadonly(event.target.checked)} />
            <Button type="submit" variant="default" disabled={!slugValid}>新增 Root</Button>
          </div>
        </form>
      </Card>
      {roots.length > 0 ? (
        <RowList>
          {roots.map((root) => (
            <Row key={root.id} icon={<HardDrive />} title={root.name} subtitle={root.slug}>
              {root.readonly ? <KagoBadge>唯讀</KagoBadge> : null}
              <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? "允許寫入" : "設為唯讀"}</Button>
              <Button variant="destructive" onClick={() => void remove(root)}>移除</Button>
            </Row>
          ))}
        </RowList>
      ) : null}
    </>
  );
}
