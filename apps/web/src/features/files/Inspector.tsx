import { useState, type ReactNode } from "react";
import { Link2, X } from "lucide-react";
import { useFileMeta, useImageMetadata, usePathPermissions, useRoots, useShares } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { RuleList } from "@/features/permissions/RuleList";
import { ShareForm } from "@/features/shares/ShareForm";
import { parseShareMode, shareModeLabel } from "@/features/shares/shareUtils";
import { FinderTagEditor } from "@/features/tags/FinderTagEditor";
import { TagEditor } from "@/features/tags/TagEditor";
import { formatDate, formatSize, isPicture, kindLabel } from "@/lib/format";
import { displayPath } from "@/lib/paths";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow, ImageMetadata } from "@/types/kago";
import { FileThumbnail } from "./FileThumbnail";

const MIN_WIDTH = 260;
const MAX_WIDTH = 440;

/** Panel inside a file window describing its selection, or its folder when nothing is selected. */
export function Inspector({ window: activeWindow, isAdmin }: { window: FileWindow; isAdmin: boolean }) {
  const width = useWorkspaceStore((state) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, state.inspector.width ?? 300)));
  const store = useWorkspaceStore.getState;
  const rootSlug = activeWindow.rootSlug;
  const path = activeWindow.selectedItems.at(-1) ?? activeWindow.logicalPath;
  const selectedCount = activeWindow.selectedItems.length;
  const meta = useFileMeta(rootSlug, path, true);
  const roots = useRoots();
  const shares = useShares();
  const permissions = usePathPermissions(rootSlug, path, isAdmin);
  // A picture without shooting data, or a server that cannot read it, simply has no such section.
  const photo = useImageMetadata(rootSlug, path, Boolean(meta.data && isPicture(meta.data))).data;
  const root = roots.data?.find((root) => root.slug === rootSlug);
  const rootId = root?.id;
  const readonly = Boolean(root?.readonly);
  const pathShares = (shares.data ?? []).filter((share) => share.root_id === rootId && share.path === path);
  // The share form only opens on request, and only for the item it was opened on.
  const [sharingKey, setSharingKey] = useState<string | null>(null);
  const shareKey = `${rootSlug}:${path}`;

  const resizeHandlers = usePointerDrag(
    () => width,
    (origin, dx) => store().updateInspector({ width: Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, origin - dx))) })
  );

  return (
    <aside className="relative flex max-w-[60%] shrink-0 flex-col border-l border-line bg-surface" style={{ width }} aria-label="資訊">
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize touch-none" {...resizeHandlers} />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <strong className="flex-1 font-semibold">資訊</strong>
        <KagoIconButton label="關閉資訊面板" onClick={() => store().updateWindow(activeWindow.id, { inspectorOpen: false })}><X /></KagoIconButton>
      </header>

      {meta.isLoading ? (
        <KagoLoading />
      ) : meta.error || !meta.data ? (
        <p className="m-0 p-4 text-muted">無法讀取這個項目的資訊。</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <FileThumbnail rootSlug={rootSlug} item={meta.data} size={path === "/" || meta.data.kind === "folder" ? 64 : 144} />
            <strong className="max-w-full text-sm font-semibold break-words">{path === "/" ? activeWindow.title : meta.data.name}</strong>
            <span className="-mt-1.5 text-muted">
              {kindLabel(meta.data)}
              {meta.data.kind === "file" ? ` · ${formatSize(meta.data.size)}` : ""}
            </span>
            {selectedCount > 1 ? <KagoBadge>已選取 {selectedCount} 項，顯示最後一項</KagoBadge> : null}
          </div>

          <Section title="一般">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <Detail label="修改時間">{formatDate(meta.data.mtime)}</Detail>
              <Detail label="位置"><span title={`${rootSlug}:${path}`}>{displayPath(root?.name ?? rootSlug, path)}</span></Detail>
              {readonly ? <Detail label="存取">唯讀</Detail> : null}
            </dl>
          </Section>

          {photo && Object.keys(photo).length > 0 ? <PhotoDetails photo={photo} /> : null}

          {/* Two kinds of tag, one place: where each is kept is what tells them apart. */}
          <Section title="標籤">
            {readonly && !meta.data.finderTags?.length ? null : (
              <TagGroup label="Finder" hint="存在檔案上，Finder 也看得到">
                <FinderTagEditor rootSlug={rootSlug} path={path} tags={meta.data.finderTags ?? []} readonly={readonly} />
              </TagGroup>
            )}
            <TagGroup label="Kago" hint="只存在 Kago 裡">
              <TagEditor rootSlug={rootSlug} path={path} />
            </TagGroup>
          </Section>

          <Section title="分享連結">
            {pathShares.length > 0 ? (
              <ul className="m-0 mb-3 flex list-none flex-col gap-1.5 p-0">
                {pathShares.map((share) => (
                  <li key={share.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{shareModeLabel(parseShareMode(share.permission_json))} · 已下載 {share.download_count} 次</span>
                    <KagoBadge tone={share.disabled ? "neutral" : "success"}>{share.disabled ? "已停用" : "啟用中"}</KagoBadge>
                  </li>
                ))}
              </ul>
            ) : null}
            {sharingKey === shareKey ? (
              <>
                <ShareForm key={shareKey} target={{ rootSlug, path }} compact />
                <Button variant="ghost" className="mt-2 w-full" onClick={() => setSharingKey(null)}>收合</Button>
              </>
            ) : (
              <>
                {pathShares.length === 0 ? <p className="m-0 mb-2 text-faint">還沒有分享出去</p> : null}
                <Button className="w-full" onClick={() => setSharingKey(shareKey)}><Link2 />建立分享連結</Button>
              </>
            )}
            {pathShares.length > 0 ? <Button variant="ghost" className="mt-2 w-full" onClick={() => store().openApp("shares")}>管理所有分享</Button> : null}
          </Section>

          {isAdmin ? (
            <Section title="權限規則">
              {permissions.data?.length ? <RuleList rules={permissions.data} /> : <span className="text-faint">這個路徑沒有套用任何規則</span>}
              <Button variant="ghost" className="mt-2 w-full" onClick={() => store().openApp("settings", "permissions")}>管理權限</Button>
            </Section>
          ) : null}
        </div>
      )}
    </aside>
  );
}

// exiftool names these in English; the ones cameras actually write are few enough to say in Chinese.
const WHITE_BALANCE: Record<string, string> = { Auto: "自動", Manual: "手動", Daylight: "日光", Cloudy: "陰天", Shade: "陰影", Tungsten: "鎢絲燈", Fluorescent: "螢光燈", Flash: "閃光燈" };
const METERING: Record<string, string> = { "Multi-segment": "多區評價", "Center-weighted average": "中央重點", Spot: "點測光", Average: "平均", Partial: "局部" };
const PROGRAM: Record<string, string> = { Manual: "手動", "Program AE": "程式自動", "Aperture-priority AE": "光圈先決", "Shutter speed priority AE": "快門先決", Portrait: "人像", Landscape: "風景" };

const trimLength = (value: string) => value.replace(/\.0+(?= ?mm)/, "");

/** What the camera recorded about a picture, in the order a photographer asks for it. */
function PhotoDetails({ photo }: { photo: ImageMetadata }) {
  const exposure = [photo.exposureTime ? `${photo.exposureTime} 秒` : "", photo.aperture ? `f/${photo.aperture}` : "", photo.iso ? `ISO ${photo.iso}` : ""].filter(Boolean).join(" · ");
  const focal = photo.focalLength ? trimLength(photo.focalLength) + (photo.focalLength35 && trimLength(photo.focalLength35) !== trimLength(photo.focalLength) ? `（等效 ${trimLength(photo.focalLength35)}）` : "") : "";
  const compensation = photo.exposureCompensation ? `${photo.exposureCompensation > 0 ? "+" : ""}${Math.round(photo.exposureCompensation * 100) / 100} EV` : "";
  const flash = photo.flash ? (/no flash|did not fire|^off/i.test(photo.flash) ? "未閃光" : /fired|^on/i.test(photo.flash) ? "有閃光" : photo.flash) : "";
  const program = photo.exposureProgram && photo.exposureProgram !== "Not Defined" ? PROGRAM[photo.exposureProgram] ?? photo.exposureProgram : "";
  const pixels = photo.width && photo.height ? `${photo.width} × ${photo.height}（${((photo.width * photo.height) / 1e6).toFixed(1)} MP）` : "";
  const gps = photo.gps;
  return (
    <Section title="拍攝資訊">
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {photo.camera ? <Detail label="相機">{photo.camera}</Detail> : null}
        {photo.lens ? <Detail label="鏡頭">{photo.lens}</Detail> : null}
        {photo.takenAt ? <Detail label="拍攝時間">{photo.takenAt}{photo.timeZone ? <span className="text-faint"> {photo.timeZone}</span> : null}</Detail> : null}
        {exposure ? <Detail label="曝光">{exposure}</Detail> : null}
        {focal ? <Detail label="焦距">{focal}</Detail> : null}
        {compensation ? <Detail label="曝光補償">{compensation}</Detail> : null}
        {program ? <Detail label="拍攝模式">{program}</Detail> : null}
        {photo.meteringMode ? <Detail label="測光">{METERING[photo.meteringMode] ?? photo.meteringMode}</Detail> : null}
        {photo.whiteBalance ? <Detail label="白平衡">{WHITE_BALANCE[photo.whiteBalance] ?? photo.whiteBalance}</Detail> : null}
        {flash ? <Detail label="閃光燈">{flash}</Detail> : null}
        {pixels ? <Detail label="尺寸">{pixels}</Detail> : null}
        {photo.colorSpace ? <Detail label="色彩空間">{photo.colorSpace}</Detail> : null}
        {photo.software ? <Detail label="軟體">{photo.software}</Detail> : null}
        {gps ? (
          <Detail label="位置">
            <a className="text-accent underline underline-offset-2" href={`https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=15/${gps.latitude}/${gps.longitude}`} target="_blank" rel="noreferrer">
              {gps.latitude.toFixed(5)}, {gps.longitude.toFixed(5)}
            </a>
            {gps.altitude !== undefined ? <span className="text-faint"> · 海拔 {Math.round(gps.altitude)} m</span> : null}
          </Detail>
        ) : null}
      </dl>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line p-4">
      <h3 className="m-0 mb-2.5 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function TagGroup({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="mt-3 flex flex-col gap-1.5 first-of-type:mt-0">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-muted">{label}</span>
        <span className="truncate text-faint">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}
