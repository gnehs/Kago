import { cn } from "@/lib/utils";
import type { FinderTag } from "@/types/kago";
import { t } from "@/lib/i18n";

/** A tag's colour as a small bead, or a hollow for a tag without one. Its size comes from `className`. */
export function TagDot({ color, className }: { color: FinderTag["color"]; className?: string }) {
  return <span data-color={color ?? undefined} className={cn("kago-tag-dot", className)} />;
}

const MAX_DOTS = 3;

/** The coloured dots Finder shows next to a name. Tags without a colour only appear in the tooltip. */
export function FinderTagDots({ tags, className }: { tags?: FinderTag[]; className?: string }) {
  if (!tags?.length) return null;
  const colored = tags.filter((tag) => tag.color).slice(-MAX_DOTS);
  if (colored.length === 0) return null;
  const label = tags.map((tag) => tag.name).join("、");
  return (
    <span className={cn("flex shrink-0 items-center", className)} role="img" aria-label={t("Tags: {label}", { label })} title={label}>
      {colored.map((tag) => (
        <TagDot key={tag.name} color={tag.color} className="-ml-1 size-2.5 outline outline-1 outline-surface first:ml-0" />
      ))}
    </span>
  );
}
