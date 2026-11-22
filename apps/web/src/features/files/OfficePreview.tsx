import { useQuery } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { FileWarning } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { previewUrl } from "@/api/client";
import { KagoLoading } from "@/components/kago/empty-state";
import { formatSize, type OfficeKind } from "@/lib/format";
import { checkZip, MAX_UNPACKED_BYTES, type ZipVerdict } from "@/lib/zipCheck";
import type { PreviewWindow } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import { PreviewFailure, PreviewWindowFrame, usePreviewFile } from "./PreviewWindowFrame";

// Each format's parser is its own download, made by whoever opens a file of that kind.
const views = {
  document: lazy(() => import("./DocxView")),
  sheet: lazy(() => import("./SheetView")),
  slides: lazy(() => import("./SlidesView"))
};

/** The file is parsed in the browser, whole, so there is a size past which opening it is not worth the wait. */
const MAX_OFFICE_BYTES = 50 * 1024 * 1024;

/** A Word, Excel or PowerPoint file, read in the browser: nothing is converted on the server. */
export function OfficePreviewWindow({ window, kind }: { window: PreviewWindow; kind: OfficeKind }) {
  const [unreadable, setUnreadable] = useState(false);
  const { rootSlug, item, download } = usePreviewFile(window, () => setUnreadable(false));
  const tooLarge = item.size > MAX_OFFICE_BYTES;
  const onError = useCallback(() => setUnreadable(true), []);
  const file = useQuery({
    queryKey: keys.fs.bytes(rootSlug, item.path, item.mtime),
    queryFn: async () => {
      const response = await fetch(previewUrl(rootSlug, item.path), { credentials: "include" });
      if (!response.ok) throw new Error(t("Couldn’t read the file"));
      const data = await response.arrayBuffer();
      // Every format here but the old binary ones is a zip, unpacked whole by its parser.
      return { data, verdict: await checkZip(data) };
    },
    enabled: !tooLarge,
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  });
  const View = views[kind];
  const verdict: ZipVerdict = file.data?.verdict ?? "ok";

  return (
    <PreviewWindowFrame window={window}>
      {tooLarge || unreadable || file.error || verdict !== "ok" ? (
        <PreviewFailure
          className="min-h-0 flex-1"
          icon={<FileWarning />}
          title={t("Couldn’t preview this file")}
          description={tooLarge ? t("Files over {size} have to be downloaded to open.", { size: formatSize(MAX_OFFICE_BYTES) }) : verdict === "too-large" ? t("This file unpacks to more than {size}, which is too much to open here.", { size: formatSize(MAX_UNPACKED_BYTES) }) : file.error ? t("Something went wrong reading the file.") : t("The file may be damaged, password-protected, or in an unsupported format.")}
          onDownload={download}
        />
      ) : !file.data ? (
        <KagoLoading />
      ) : (
        <Suspense fallback={<KagoLoading />}>
          <View data={file.data.data} onError={onError} />
        </Suspense>
      )}
    </PreviewWindowFrame>
  );
}
