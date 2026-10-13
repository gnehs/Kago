import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Plus } from "lucide-react";
import { KagoChip, KagoChips } from "@/components/kago/chip";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { Card, Row, RowList } from "@/components/kago/page";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, Input } from "@/components/ui/input";
import { run } from "@/lib/run";
import { saveSettings, useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";
import type { FileMeta, FileTag, ListedTag, TagShape } from "@/types/kago";
import { colorShape, TagDot } from "./TagDots";
import { t } from "@/lib/i18n";

type Color = NonNullable<FileTag["color"]>;

/** As many as the account keeps in a list. */
const MAX_TAGS = 100;

// In the order the colours are listed everywhere, each with the name a tag of that colour alone goes by.
const colors: Array<{ color: Color; name: string }> = [
  { color: "red", name: t("Red") },
  { color: "orange", name: t("Orange") },
  { color: "yellow", name: t("Yellow") },
  { color: "green", name: t("Green") },
  { color: "blue", name: t("Blue") },
  { color: "purple", name: t("Purple") },
  { color: "gray", name: t("Gray") }
];

const shapes: Array<{ shape: TagShape; name: string }> = [
  { shape: "circle", name: t("Circle") },
  { shape: "triangle", name: t("Triangle") },
  { shape: "diamond", name: t("Diamond") },
  { shape: "square", name: t("Square") },
  { shape: "pentagon", name: t("Pentagon") },
  { shape: "hexagon", name: t("Hexagon") },
  { shape: "star", name: t("Star") }
];

const dot = (tag: FileTag) => <TagDot tag={tag} className="size-2.5" />;

const choice = "kago-tag-dot size-5 outline-2 outline-offset-2 outline-transparent focus-visible:outline-accent";

/** One tag of the list being written: a new one, or one that is there. */
function TagForm({ tag, taken, onSave, onClose }: { tag: ListedTag | null; /** The names the other tags of the list go by. */ taken: string[]; onSave: (tag: ListedTag) => void; onClose: () => void }) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState<Color | null>(tag?.color ?? null);
  // Left alone, the shape is the one the colour has everywhere.
  const [shape, setShape] = useState<TagShape | null>(tag?.shape ?? null);
  // A colour on its own makes the tag named after that colour.
  const colorName = colors.find((item) => item.color === color)?.name;
  const newName = name.trim() || colorName || "";
  const shown = shape ?? (color ? colorShape[color] : "circle");
  const clash = taken.includes(newName);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!newName || clash) return;
    onSave({ name: newName, color, ...(shape ? { shape } : {}) });
    onClose();
  }

  return (
    <form className="flex flex-col gap-4 p-4 pt-3" onSubmit={submit}>
      <Field label={t("Name")} hint={clash ? t("You already have a tag with this name") : undefined}>
        <Input autoFocus maxLength={255} placeholder={colorName} value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <FieldGroup label={t("Color##of a tag")}>
        <div className="flex items-center gap-2.5 py-1 pl-0.5" role="radiogroup" aria-label={t("Color##of a tag")}>
          <button type="button" role="radio" aria-checked={color === null} aria-label={t("No color")} title={t("No color")} className={cn(choice, color === null && "outline-ink")} onClick={() => setColor(null)} />
          {colors.map((item) => (
            <button
              key={item.color}
              type="button"
              role="radio"
              aria-checked={color === item.color}
              aria-label={item.name}
              title={item.name}
              data-color={item.color}
              className={cn(choice, color === item.color && "outline-ink")}
              onClick={() => setColor(item.color)}
            />
          ))}
        </div>
      </FieldGroup>
      <FieldGroup label={t("Shape")} hint={t("Told apart by shape, a tag needs no telling colors apart. Each color has a shape of its own until you pick another.")}>
        <div className="flex items-center gap-2.5 py-1 pl-0.5" role="radiogroup" aria-label={t("Shape")}>
          {shapes.map((item) => (
            <button
              key={item.shape}
              type="button"
              role="radio"
              aria-checked={shown === item.shape}
              aria-label={item.name}
              title={item.name}
              data-color={color ?? undefined}
              data-shape={item.shape}
              className={cn(choice, shown === item.shape && "outline-ink")}
              onClick={() => setShape(item.shape)}
            />
          ))}
        </div>
      </FieldGroup>
      <KagoDialogActions>
        <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
        <Button type="submit" variant="default" disabled={!newName || clash}>{tag ? t("Save") : t("Add")}</Button>
      </KagoDialogActions>
    </form>
  );
}

/** A list of tags with `tag` in it: one of that name already there is replaced where it stands. */
const withTag = <T extends FileTag>(tags: T[], tag: T) => (tags.some((item) => item.name === tag.name) ? tags.map((item) => (item.name === tag.name ? tag : item)) : [...tags, tag]);

/** A file or folder to tag, with the tags it has now. */
export type TagTarget = { path: string; tags: FileTag[] };

/** The tags of the selected files and folders, stored on the files themselves. Putting one on or taking one off reaches every one of them. */
export function TagEditor({ rootSlug, targets, readonly }: { rootSlug: string; targets: TagTarget[]; readonly: boolean }) {
  const queryClient = useQueryClient();
  // Every tag any of them has, each listed once.
  const tags = targets.flatMap((target) => target.tags).filter((tag, index, all) => all.findIndex((item) => item.name === tag.name) === index);
  // The only tags there are to put on: the ones kept at hand in the settings. Putting one on a file never adds to them.
  const mine = useSettingsStore((state) => state.settings.tags) ?? [];
  // A tag only some of them have is still there to put on the rest.
  const handy = mine.filter((tag) => !targets.every((target) => target.tags.some((item) => item.name === tag.name)));

  /** Writes the tags of each file `change` gives a new list for, one after another. */
  const save = (change: (tags: FileTag[]) => FileTag[] | null, fallback: string) =>
    run(async () => {
      try {
        for (const target of targets) {
          const next = change(target.tags);
          if (!next) continue;
          const meta = await api<FileMeta>("/api/fs/tags", { method: "PUT", body: JSON.stringify({ rootSlug, path: target.path, tags: next }) });
          queryClient.setQueryData(["fs", "meta", rootSlug, target.path], meta);
        }
      } finally {
        // The ones written before a failure are tagged all the same.
        await queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug] });
      }
    }, fallback);
  const has = (list: FileTag[], name: string) => list.some((item) => item.name === name);
  // The file keeps a name and a colour; the shape stays in the list.
  const add = ({ name, color }: ListedTag) => save((list) => (has(list, name) ? null : withTag(list, { name, color })), t("Couldn’t add the tag"));
  const remove = (name: string) => save((list) => (has(list, name) ? list.filter((item) => item.name !== name) : null), t("Couldn’t remove the tag"));

  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 ? (
        <KagoChips>
          {tags.map((tag) => (
            <KagoChip
              key={tag.name}
              dot={dot(tag)}
              removeLabel={t("Remove tag {name}", { name: tag.name })}
              onRemove={readonly ? undefined : () => void remove(tag.name)}
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
          {mine.length === 0 ? <p className="m-0 text-xs text-muted">{t("Set up your tags in Settings to put them on files.")}</p> : null}
          {targets.length > 1 ? <p className="m-0 text-xs text-muted">{t("Tags go on all {count} selected items.", { count: targets.length })}</p> : null}
        </>
      )}
    </div>
  );
}

/** The tags a person keeps at hand, as a card of the settings. They write it themselves: it is not gathered from files, and it lists no files. */
export function TagList() {
  const tags = useSettingsStore((state) => state.settings.tags) ?? [];
  const [editing, setEditing] = useState<ListedTag | "new" | null>(null);
  // The last tag stays on show while its dialog fades out.
  const [shown, setShown] = useState(editing);
  if (editing && editing !== shown) setShown(editing);
  const current = shown === "new" ? null : shown;

  const describe = (tag: ListedTag) => {
    const shape = tag.shape ?? (tag.color ? colorShape[tag.color] : "circle");
    return `${colors.find((item) => item.color === tag.color)?.name ?? t("No color")} · ${shapes.find((item) => item.shape === shape)?.name}`;
  };

  return (
    <Card
      title={t("Tags")}
      description={t("Tags you keep at hand. They appear in a file’s info, ready to put on it with one click.")}
      action={tags.length < MAX_TAGS ? <Button variant="default" onClick={() => setEditing("new")}><Plus />{t("Add tag")}</Button> : null}
    >
      {tags.length > 0 ? (
        <RowList bare>
          {tags.map((tag) => (
            <Row key={tag.name} icon={<TagDot tag={tag} className="mx-0.5 size-4" />} title={tag.name} subtitle={describe(tag)}>
              <Button onClick={() => setEditing(tag)}>{t("Edit")}</Button>
              <Button variant="destructive" onClick={() => void saveSettings({ tags: tags.filter((item) => item.name !== tag.name) })}>{t("Remove")}</Button>
            </Row>
          ))}
        </RowList>
      ) : (
        <p className="m-0 text-muted">{t("No tags yet.")}</p>
      )}
      <KagoDialog open={editing !== null} onClose={() => setEditing(null)} title={current ? t("Edit {name}", { name: current.name }) : t("Add tag")}>
        <TagForm
          key={current?.name ?? "new"}
          tag={current}
          taken={tags.filter((item) => item.name !== current?.name).map((item) => item.name)}
          onSave={(tag) => void saveSettings({ tags: current ? tags.map((item) => (item.name === current.name ? tag : item)) : [...tags, tag] })}
          onClose={() => setEditing(null)}
        />
      </KagoDialog>
    </Card>
  );
}
