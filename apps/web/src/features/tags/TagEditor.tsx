import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useFileTags } from "@/api/hooks";
import { KagoChip, KagoChips } from "@/components/kago/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { run } from "@/lib/run";
import { t } from "@/lib/i18n";

/** Kago DB tags for one file or folder. */
export function TagEditor({ rootSlug, path }: { rootSlug: string; path: string }) {
  const queryClient = useQueryClient();
  const tags = useFileTags(rootSlug, path);
  const [name, setName] = useState("");
  const current = tags.data ?? [];

  async function save(tagIds: string[]) {
    await api("/api/tags/file", { method: "PUT", body: JSON.stringify({ rootSlug, path, tagIds }) });
    await queryClient.invalidateQueries({ queryKey: ["tags", "file", rootSlug, path] });
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await run(async () => {
      const tag = await api<{ id: string }>("/api/tags", { method: "POST", body: JSON.stringify({ name: trimmed }) });
      await save([...new Set([...current.map((item) => item.id), tag.id])]);
      setName("");
    }, t("Couldn’t apply the tag"));
  }

  return (
    <div className="flex flex-col gap-2">
      {current.length > 0 ? (
        <KagoChips>
          {current.map((tag) => (
            <KagoChip
              key={tag.id}
              dot={<span className="size-2 rounded-full bg-accent" style={tag.color ? { background: tag.color } : undefined} />}
              removeLabel={t("Remove tag {name}", { name: tag.name })}
              onRemove={() => void run(() => save(current.filter((item) => item.id !== tag.id).map((item) => item.id)))}
            >
              {tag.name}
            </KagoChip>
          ))}
        </KagoChips>
      ) : null}
      <form className="flex gap-2" onSubmit={add}>
        <Input placeholder={t("Add tag")} value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!name.trim()}>{t("Add")}</Button>
      </form>
    </div>
  );
}
