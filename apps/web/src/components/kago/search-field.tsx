import { Search, X } from "lucide-react";
import { t } from "@/lib/i18n";

/** The search field at the head of a window's list: narrows what is listed as it is typed. Escape clears it before it closes anything else. */
export function KagoSearchField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <label className="kago-well flex h-(--kago-control-h) min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5">
      <Search className="size-3.5 shrink-0 text-muted" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !value) return;
          event.stopPropagation();
          onChange("");
        }}
      />
      {value ? <button type="button" aria-label={t("Clear search")} className="text-muted hover:text-ink" onClick={() => onChange("")}><X className="size-3.5" /></button> : null}
    </label>
  );
}
