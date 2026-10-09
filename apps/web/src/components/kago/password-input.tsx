import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { ArrowBigUpDash, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { KagoTooltip } from "./tooltip";

/**
 * Where a password is typed: the same well as any other field, with a key at its end that shows what was typed
 * for as long as it is held on, and a mark that comes up while Caps Lock is on, before the password is turned down
 * for it.
 */
export function KagoPasswordInput({ className, onKeyDown, onKeyUp, onBlur, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  // The keyboard only says whether the lock is on while a key goes down or comes up.
  const watch = (event: KeyboardEvent<HTMLInputElement>) => setCaps(event.getModifierState?.("CapsLock") ?? false);

  return (
    <span className={cn("kago-well flex h-(--kago-control-h) w-full min-w-0 items-center rounded-md transition-shadow has-[input:disabled]:opacity-50", className)}>
      <input
        type={shown ? "text" : "password"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 rounded-[inherit] bg-transparent pr-1 pl-2.5 text-ink outline-none placeholder:text-faint"
        onKeyDown={(event) => {
          watch(event);
          onKeyDown?.(event);
        }}
        onKeyUp={(event) => {
          watch(event);
          onKeyUp?.(event);
        }}
        onBlur={(event) => {
          setCaps(false);
          onBlur?.(event);
        }}
        {...props}
      />
      {caps ? (
        <KagoTooltip label={t("Caps Lock is on")}>
          <span role="img" aria-label={t("Caps Lock is on")} className="flex px-1 text-warning"><ArrowBigUpDash /></span>
        </KagoTooltip>
      ) : null}
      <KagoTooltip label={shown ? t("Hide password") : t("Show password")}>
        <button
          type="button"
          aria-label={shown ? t("Hide password") : t("Show password")}
          aria-pressed={shown}
          disabled={props.disabled}
          className="mr-0.5 flex size-6.5 shrink-0 items-center justify-center kago-flat rounded-[calc(var(--kago-radius-md)-2px)] text-faint outline-none hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-accent/50"
          // Pressed with the pointer it leaves the caret where it was, so that Return still sends the form.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      </KagoTooltip>
    </span>
  );
}
