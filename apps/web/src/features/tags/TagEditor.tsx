import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/api/client";
import { useFileTags } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { run } from "@/lib/run";

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
    }, "無法套用標籤");
  }

  return (
    <div className="flex flex-col gap-2">
      {current.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {current.map((tag) => (
            <li key={tag.id} className="flex h-6 items-center gap-1 rounded-full bg-hover pr-1 pl-2">
              <span className="size-2 rounded-full bg-accent" style={tag.color ? { background: tag.color } : undefined} />
              {tag.name}
              <button aria-label={`移除標籤 ${tag.name}`} className="rounded-full p-0.5 text-muted hover:text-ink" onClick={() => void run(() => save(current.filter((item) => item.id !== tag.id).map((item) => item.id)))}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="flex gap-2" onSubmit={add}>
        <Input placeholder="新增標籤" value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!name.trim()}>加入</Button>
      </form>
    </div>
  );
}
