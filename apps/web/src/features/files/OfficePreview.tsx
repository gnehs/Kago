import { useQuery } from "@tanstack/react-query";
import { Download, FileWarning } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { formatSize, type OfficeKind } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import { t } from "@/lib/i18n";

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
  const { rootSlug, item } = window.preview;
  const tooLarge = item.size > MAX_OFFICE_BYTES;
  const [unreadable, setUnreadable] = useState(false);
  const onError = useCallback(() => setUnreadable(true), []);
  const file = useQuery({
    queryKey: ["fs", "bytes", rootSlug, item.path, item.mtime],
    queryFn: async () => {
      const response = await fetch(previewUrl(rootSlug, item.path), { credentials: "include" });
      if (!response.ok) throw new Error(t("Couldn’t read the file"));
      return response.arrayBuffer();
    },
    enabled: !tooLarge,
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  });
  const View = views[kind];
  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={
        <KagoIconButton label={t("Download")} className="size-6" onClick={download}>
          <Download />
        </KagoIconButton>
      }
    >
      {tooLarge || unreadable || file.error ? (
        <KagoEmptyState
          className="min-h-0 flex-1"
          icon={<FileWarning />}
          title={t("Couldn’t preview this file")}
          description={tooLarge ? t("Files over {size} have to be downloaded to open.", { size: formatSize(MAX_OFFICE_BYTES) }) : file.error ? t("Something went wrong reading the file.") : t("The file may be damaged, password-protected, or in an unsupported format.")}
        >
          <Button onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      ) : !file.data ? (
        <KagoLoading />
      ) : (
        <Suspense fallback={<KagoLoading />}>
          <View data={file.data} onError={onError} />
        </Suspense>
      )}
    </KagoWindow>
  );
}
