import { useEffect, useState } from "react";
import { create } from "zustand";
import { useConvertSupport } from "@/api/hooks";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { Button } from "@/components/ui/button";
import type { ConvertSpec } from "@/types/kago";
import { ConvertFields, specIsValid } from "./ConvertFields";
import { specFor, supportedFormats, targetFormats, type MediaKind } from "./convertSpec";
import { t } from "@/lib/i18n";

type ConvertRequest = { kind: MediaKind; names: string[]; resolve: (spec: ConvertSpec | null) => void };

const useConvertStore = create<{ request: ConvertRequest | null }>(() => ({ request: null }));

/** Asks what to make of some files of one kind. Resolves to nothing when the dialog is closed. */
export function promptConvert(options: { kind: MediaKind; names: string[] }) {
  return new Promise<ConvertSpec | null>((resolve) => {
    useConvertStore.getState().request?.resolve(null);
    useConvertStore.setState({ request: { ...options, resolve } });
  });
}

function settle(spec: ConvertSpec | null) {
  useConvertStore.getState().request?.resolve(spec);
  useConvertStore.setState({ request: null });
}

/** What a file of a kind is most often wanted as, other than what it is already. */
function firstChoice(kind: MediaKind, names: string[], offered: string[]): string {
  const own = new Set(names.map((name) => name.slice(name.lastIndexOf(".") + 1).toLowerCase()));
  const wanted = kind === "video" ? ["mp4", "mkv"] : kind === "audio" ? ["mp3", "m4a"] : own.has("gif") && own.size === 1 ? ["mp4", "webp"] : ["jpg", "png"];
  return wanted.find((format) => offered.includes(format) && !own.has(format)) ?? offered[0] ?? wanted[0]!;
}

export function ConvertDialogHost() {
  const pending = useConvertStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  const support = useConvertSupport(Boolean(pending));
  const [spec, setSpec] = useState<ConvertSpec>(() => specFor("mp4"));
  const formats = request ? supportedFormats(targetFormats(request.kind, request.names), support.data) : null;
  const offered = formats ? [...formats.video, ...formats.audio, ...formats.image] : [];

  useEffect(() => {
    if (pending) setRequest(pending);
  }, [pending]);
  // Chosen once it is known what the server can make.
  useEffect(() => {
    if (!pending || !support.data) return;
    const all = supportedFormats(targetFormats(pending.kind, pending.names), support.data);
    setSpec(specFor(firstChoice(pending.kind, pending.names, [...all.video, ...all.audio, ...all.image])));
  }, [pending, support.data]);

  if (!request || !formats) return null;
  const count = request.names.length;
  const unavailable = support.data ? !support.data.available || offered.length === 0 : false;
  const canSubmit = Boolean(support.data) && !unavailable && offered.includes(spec.format) && specIsValid(spec);

  return (
    <KagoDialog open={Boolean(pending)} onClose={() => settle(null)} title={count > 1 ? t("Convert {count} item | Convert {count} items", { count }) : t("Convert “{name}”", { name: request.names[0] ?? "" })}>
      <form
        className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settle(spec);
        }}
      >
        {unavailable ? (
          <p className="m-0 text-muted text-pretty">{t("The server has no ffmpeg, so it can’t convert anything.")}</p>
        ) : (
          <>
            <ConvertFields spec={spec} formats={formats} support={support.data} onChange={setSpec} />
            <p className="m-0 text-xs text-faint text-pretty">{t("The new file goes in this folder, next to the original, which stays as it is.")}</p>
          </>
        )}
        <KagoDialogActions>
          <Button onClick={() => settle(null)}>{t("Cancel")}</Button>
          <Button type="submit" variant="default" disabled={!canSubmit}>{t("Convert")}</Button>
        </KagoDialogActions>
      </form>
    </KagoDialog>
  );
}
