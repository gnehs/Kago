import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, copyText } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Copies `text`, and says so until there is something else to copy. */
export function KagoCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const done = copied === text;
  return (
    <Button onClick={() => void copyText(text).then(() => setCopied(text))}>
      {done ? <Check /> : <Copy />}
      {done ? t("Copied") : t("Copy")}
    </Button>
  );
}

/** Something to be carried elsewhere as it is (a key, an address), shown on one line with the button that copies it. */
export function KagoCopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <code className="kago-well min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-xs">{value}</code>
      <KagoCopyButton text={value} />
    </div>
  );
}
