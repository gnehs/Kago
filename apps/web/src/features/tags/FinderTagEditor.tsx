import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { KagoChip, KagoChips } from "@/components/kago/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { run } from "@/lib/run";
import { saveSettings, useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";
import type { FileMeta, FinderTag } from "@/types/kago";
import { TagDot } from "./FinderTags";
import { t } from "@/lib/i18n";

type Color = NonNullable<FinderTag["color"]>;

/** As many as the account keeps. */
const MAX_TAGS = 100;

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

const dot = (tag: FinderTag) => <TagDot color={tag.color} className="size-2.5" />;

/** A name and a colour for one Finder tag, handed over as it is added. */
export function FinderTagForm({ placeholder, onAdd }: { placeholder: string; /** Answers whether the tag was taken, which clears the form. */ onAdd: (tag: FinderTag) => unknown }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<Color | null>(null);
  // A colour on its own adds Finder's tag of that colour.
  const newName = name.trim() || colors.find((item) => item.color === color)?.name || "";

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!newName) return;
    if (await onAdd({ name: newName, color })) {
      setName("");
      setColor(null);
    }
  }

  return (
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
            data-color={item.color}
            className={cn("kago-tag-dot size-4 outline-2 outline-offset-2 outline-transparent focus-visible:outline-accent", color === item.color && "outline-ink")}
            onClick={() => setColor(color === item.color ? null : item.color)}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Input placeholder={color ? colors.find((item) => item.color === color)?.name : placeholder} value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!newName}>{t("Add")}</Button>
      </div>
    </form>
  );
}

/** A list of tags with `tag` in it: one of that name already there takes its colour in place. */
const withFinderTag = (tags: FinderTag[], tag: FinderTag) => (tags.some((item) => item.name === tag.name) ? tags.map((item) => (item.name === tag.name ? tag : item)) : [...tags, tag]);

/** Finder tags of one file or folder, stored on the file itself so Finder shows the same ones. */
export function FinderTagEditor({ rootSlug, path, tags, readonly }: { rootSlug: string; path: string; tags: FinderTag[]; readonly: boolean }) {
  const queryClient = useQueryClient();
  // The tags kept at hand in the settings. Putting a tag on a file never adds to them.
  const handy = (useSettingsStore((state) => state.settings.finderTags) ?? []).filter((tag) => !tags.some((item) => item.name === tag.name));

  const save = (next: FinderTag[], fallback: string) =>
    run(async () => {
      const meta = await api<FileMeta>("/api/fs/finder-tags", { method: "PUT", body: JSON.stringify({ rootSlug, path, tags: next }) });
      queryClient.setQueryData(["fs", "meta", rootSlug, path], meta);
      await queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug] });
      return meta;
    }, fallback);
  const add = (tag: FinderTag) => save(withFinderTag(tags, tag), t("Couldn’t add the tag"));

  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 ? (
        <KagoChips>
          {tags.map((tag) => (
            <KagoChip
              key={tag.name}
              dot={dot(tag)}
              removeLabel={t("Remove tag {name}", { name: tag.name })}
              onRemove={readonly ? undefined : () => void save(tags.filter((item) => item.name !== tag.name), t("Couldn’t remove the tag"))}
            >
              {tag.name}
            </KagoChip>
          ))}
        </KagoChips>
      ) : null}
      {readonly ? null : (
        <>
          {handy.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t("Your tags")}>
              {handy.map((tag) => (
                <li key={tag.name}>
                  <button type="button" title={t("Add tag {name}", { name: tag.name })} className="flex h-6 items-center gap-1.5 rounded-full border border-line px-2 hover:bg-hover" onClick={() => void add(tag)}>
                    {dot(tag)}
                    {tag.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <FinderTagForm placeholder={t("Add tag")} onAdd={add} />
        </>
      )}
    </div>
  );
}

/** The Finder tags a person keeps at hand. They write it themselves: it is not gathered from files, and it lists no files. */
export function FinderTagList() {
  const tags = useSettingsStore((state) => state.settings.finderTags) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {tags.length > 0 ? (
        <KagoChips>
          {tags.map((tag) => (
            <KagoChip key={tag.name} dot={dot(tag)} removeLabel={t("Remove {name} from your tags", { name: tag.name })} onRemove={() => void saveSettings({ finderTags: tags.filter((item) => item.name !== tag.name) })}>
              {tag.name}
            </KagoChip>
          ))}
        </KagoChips>
      ) : null}
      {tags.length < MAX_TAGS ? (
        <FinderTagForm
          placeholder={t("Tag name")}
          onAdd={(tag) => {
            void saveSettings({ finderTags: withFinderTag(tags, tag) });
            return true;
          }}
        />
      ) : null}
    </div>
  );
}
