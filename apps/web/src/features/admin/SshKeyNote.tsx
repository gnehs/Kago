import { useSshKey } from "@/api/hooks";
import { KagoCopyField } from "@/components/kago/copy-field";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Kago's public SSH key, to be added to the other machine before it will let Kago in. */
export function SshKeyNote({ className }: { className?: string }) {
  const key = useSshKey();
  if (!key.data) return key.isError ? <p className={cn("m-0 text-xs text-danger", className)}>{t("This server cannot make an SSH key.")}</p> : null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs text-muted">{t("Add this key to ~/.ssh/authorized_keys on the other machine so that Kago can sign in.")}</span>
      <KagoCopyField value={key.data.publicKey} />
    </div>
  );
}
