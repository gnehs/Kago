import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { FileMeta, FinderTag } from "@/types/kago";
import { finderTagColorClass } from "./FinderTags";
import { t } from "@/lib/i18n";

type Color = NonNullable<FinderTag["color"]>;

// In Finder's own order, with the names it gives its colour tags.
const colors: Array<{ color: Color; name: string }> = [
  { color: "red", name: t("Red") },
  { color: "orange", name: t("Orange") },
  { color: "yellow", name: t("Yellow") },
  { color: "green", name: t("Green") },
  { color: "blue", name: t("Blue") },
  { color: "purple", name: t("Purple") },
  { color: "gray", name: t("Gray") }
];

/** Finder tags of one file or folder, stored on the file itself so Finder shows the same ones. */
export function FinderTagEditor({ rootSlug, path, tags, readonly }: { rootSlug: string; path: string; tags: FinderTag[]; readonly: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState<Color | null>(null);
  // A colour on its own adds Finder's tag of that colour.
  const newName = name.trim() || colors.find((item) => item.color === color)?.name || "";

  const save = (next: FinderTag[], fallback: string) =>
    run(async () => {
      const meta = await api<FileMeta>("/api/fs/finder-tags", { method: "PUT", body: JSON.stringify({ rootSlug, path, tags: next }) });
      queryClient.setQueryData(["fs", "meta", rootSlug, path], meta);
      await queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug] });
      return meta;
    }, fallback);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!newName) return;
    // Adding a name that is already there changes its colour in place.
    const tag = { name: newName, color };
    const next = tags.some((item) => item.name === newName) ? tags.map((item) => (item.name === newName ? tag : item)) : [...tags, tag];
    if (await save(next, t("Couldn’t add the Finder tag"))) {
      setName("");
      setColor(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {tags.map((tag) => (
            <li key={tag.name} className={cn("flex h-6 items-center gap-1.5 rounded-full bg-hover pl-2", readonly ? "pr-2" : "pr-1")}>
              <span className={cn("size-2 rounded-full", tag.color ? finderTagColorClass[tag.color] : "border border-line-strong")} />
              {tag.name}
              {readonly ? null : (
                <button aria-label={t("Remove Finder tag {name}", { name: tag.name })} className="rounded-full p-0.5 text-muted hover:text-ink" onClick={() => void save(tags.filter((item) => item.name !== tag.name), t("Couldn’t remove the Finder tag"))}>
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {readonly ? null : (
        <form className="flex flex-col gap-2" onSubmit={add}>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("Tag color")}>
            {colors.map((item) => (
              <button
                key={item.color}
                type="button"
                role="radio"
                aria-checked={color === item.color}
                aria-label={item.name}
                title={item.name}
                className={cn("size-4 rounded-full outline-none ring-offset-2 ring-offset-surface focus-visible:ring-2 focus-visible:ring-accent", finderTagColorClass[item.color], color === item.color && "ring-2 ring-ink")}
                onClick={() => setColor(color === item.color ? null : item.color)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Input placeholder={color ? colors.find((item) => item.color === color)?.name : t("Add Finder tag")} value={name} onChange={(event) => setName(event.target.value)} />
            <Button type="submit" disabled={!newName}>{t("Add")}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
