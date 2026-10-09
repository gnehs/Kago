import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useSshKey } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { cn, copyText } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Kago's public SSH key, to be added to the other machine before it will let Kago in. */
export function SshKeyNote({ className }: { className?: string }) {
  const key = useSshKey();
  const [copied, setCopied] = useState(false);
  if (!key.data) return key.isError ? <p className={cn("m-0 text-xs text-danger", className)}>{t("This server cannot make an SSH key.")}</p> : null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs text-muted">{t("Add this key to ~/.ssh/authorized_keys on the other machine so that Kago can sign in.")}</span>
      <div className="flex items-center gap-2">
        <code className="kago-well min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-xs">{key.data.publicKey}</code>
        <Button
          onClick={() => {
            void copyText(key.data.publicKey).then(() => setCopied(true));
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("Copied") : t("Copy")}
        </Button>
      </div>
    </div>
  );
}
