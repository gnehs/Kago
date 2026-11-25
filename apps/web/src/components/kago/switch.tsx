import type { ReactNode } from "react";
import { Switch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

/**
 * A setting that is on or off, with its name beside it. What the setting needs once it is on (a password, a number)
 * is `children`, and stands at the end of the same line only while it is.
 */
export function KagoSwitch({ checked, onChange, label, className, children }: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <label className="flex min-w-0 flex-1 items-center gap-2.5 font-medium">
        <Switch.Root checked={checked} onCheckedChange={onChange} className="kago-switch">
          <Switch.Thumb className="kago-switch-thumb" />
        </Switch.Root>
        <span className="min-w-0">{label}</span>
      </label>
      {checked ? children : null}
    </div>
  );
}
