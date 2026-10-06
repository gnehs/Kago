import { cn } from "@/lib/utils";
import type { FinderTag } from "@/types/kago";

export const finderTagColorClass: Record<NonNullable<FinderTag["color"]>, string> = {
  gray: "bg-tag-gray",
  green: "bg-tag-green",
  purple: "bg-tag-purple",
  blue: "bg-tag-blue",
  yellow: "bg-tag-yellow",
  red: "bg-tag-red",
  orange: "bg-tag-orange"
};

const MAX_DOTS = 3;

/** The coloured dots Finder shows next to a name. Tags without a colour only appear in the tooltip. */
export function FinderTagDots({ tags, className }: { tags?: FinderTag[]; className?: string }) {
  if (!tags?.length) return null;
  const colored = tags.filter((tag) => tag.color).slice(-MAX_DOTS);
  if (colored.length === 0) return null;
  const label = tags.map((tag) => tag.name).join("、");
  return (
    <span className={cn("flex shrink-0 items-center", className)} role="img" aria-label={`標籤：${label}`} title={label}>
      {colored.map((tag) => (
        <span key={tag.name} className={cn("-ml-1 size-2.5 rounded-full ring-1 ring-surface first:ml-0", finderTagColorClass[tag.color!])} />
      ))}
    </span>
  );
}
