import { KagoSegmented } from "@/components/kago/segmented";
import { Input } from "@/components/ui/input";
import { formatUnixDate } from "@/lib/format";
import { resolveExpiry, type ExpiryChoice } from "@/lib/shareModel";
import { t } from "@/lib/i18n";

/** How long a link is to be valid, as it is picked. `custom` is the date under "Custom…", as the date input writes it. */
export type Validity = { choice: ExpiryChoice; custom: string };

/** The last second of the day picked, in the browser's own time zone. */
function endOfDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return year && month && day ? Math.floor(new Date(year, month - 1, day, 23, 59, 59).getTime() / 1000) : null;
}

export const resolveValidity = ({ choice, custom }: Validity, nowSeconds?: number) => resolveExpiry(choice, custom ? endOfDay(custom) : null, nowSeconds);

const tomorrow = () => new Date(Date.now() + 86400000).toLocaleDateString("sv");

/** Choose a number of days, no limit, or a date; the moment it comes to is written beside the choice. */
export function ExpiryField({ value, onChange }: { value: Validity; onChange: (value: Validity) => void }) {
  const resolved = resolveValidity(value);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <KagoSegmented
        label={t("Valid for")}
        value={value.choice}
        onChange={(choice) => onChange({ ...value, choice })}
        options={[
          { value: "1", label: t("1 day") },
          { value: "7", label: t("7 days") },
          { value: "30", label: t("30 days") },
          { value: "never", label: t("No limit") },
          { value: "custom", label: t("Custom…") }
        ]}
      />
      {value.choice === "custom" ? (
        <Input type="date" aria-label={t("Last day it works")} className="w-40" min={tomorrow()} value={value.custom} onChange={(event) => onChange({ ...value, custom: event.target.value })} />
      ) : "at" in resolved ? (
        <span className="text-xs text-muted">{resolved.at === null ? t("Never expires") : t("Expires {date}", { date: formatUnixDate(resolved.at) })}</span>
      ) : null}
    </div>
  );
}
