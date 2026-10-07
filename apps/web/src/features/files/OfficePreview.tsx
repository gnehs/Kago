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
      if (!response.ok) throw new Error("無法讀取檔案");
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
        <KagoIconButton label="下載" className="size-6" onClick={download}>
          <Download />
        </KagoIconButton>
      }
    >
      {tooLarge || unreadable || file.error ? (
        <KagoEmptyState
          className="min-h-0 flex-1"
          icon={<FileWarning />}
          title="無法預覽這個檔案"
          description={tooLarge ? `超過 ${formatSize(MAX_OFFICE_BYTES)} 的檔案請下載後開啟。` : file.error ? "讀取檔案時發生錯誤。" : "檔案可能已損毀、有密碼保護，或是不支援的格式。"}
        >
          <Button onClick={download}>下載</Button>
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
