import { cn } from "@/lib/utils";
import type { FinderTag } from "@/types/kago";

const colorClass: Record<NonNullable<FinderTag["color"]>, string> = {
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
        <span key={tag.name} className={cn("-ml-1 size-2.5 rounded-full ring-1 ring-surface first:ml-0", colorClass[tag.color!])} />
      ))}
    </span>
  );
}

/** Finder tags with their names. Kago shows them as they are on disk and does not edit them. */
export function FinderTagChips({ tags }: { tags: FinderTag[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {tags.map((tag) => (
        <li key={tag.name} className="flex h-6 items-center gap-1.5 rounded-full bg-hover px-2">
          <span className={cn("size-2 rounded-full", tag.color ? colorClass[tag.color] : "border border-line-strong")} />
          {tag.name}
        </li>
      ))}
    </ul>
  );
}
