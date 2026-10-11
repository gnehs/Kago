import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";
import type { FileTag, TagShape } from "@/types/kago";
import { t } from "@/lib/i18n";

/**
 * The shape each colour is drawn in, so that tags are told apart without telling the colours apart. The colours most
 * often taken for one another (red, orange, yellow and green; blue and purple) have the shapes least alike.
 */
export const colorShape: Record<NonNullable<FileTag["color"]>, TagShape> = {
  red: "triangle",
  orange: "diamond",
  yellow: "star",
  green: "square",
  blue: "circle",
  purple: "pentagon",
  gray: "hexagon"
};

/** The shape a tag is drawn in: the one its owner's list gives a tag of that name, or else the shape of its colour. */
function useTagShape(tag: FileTag): TagShape {
  const own = useSettingsStore((state) => state.settings.tags?.find((item) => item.name === tag.name)?.shape);
  return own ?? (tag.color ? colorShape[tag.color] : "circle");
}

/** A tag's colour and shape, small; a hollow for a tag without a colour. Its size comes from `className`. */
export function TagDot({ tag, className }: { tag: FileTag; className?: string }) {
  const shape = useTagShape(tag);
  return <span data-color={tag.color ?? undefined} data-shape={shape} className={cn("kago-tag-dot", className)} />;
}

const MAX_DOTS = 3;

/** The marks of a file's coloured tags, next to its name. They stand side by side: one laid over another would hide its shape. Tags without a colour only appear in the tooltip. */
export function TagDots({ tags, className }: { tags?: FileTag[]; className?: string }) {
  if (!tags?.length) return null;
  const colored = tags.filter((tag) => tag.color).slice(-MAX_DOTS);
  if (colored.length === 0) return null;
  const label = tags.map((tag) => tag.name).join("、");
  return (
    <span className={cn("flex shrink-0 items-center gap-px", className)} role="img" aria-label={t("Tags: {label}", { label })} title={label}>
      {colored.map((tag) => (
        <TagDot key={tag.name} tag={tag} className="size-2.5" />
      ))}
    </span>
  );
}
