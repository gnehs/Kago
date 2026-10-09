import { useState, type ReactNode } from "react";
import { Link2, X } from "lucide-react";
import { useFileMeta, useImageMetadata, useMediaInfo, usePathPermissions, useRoots, useShares } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { RuleList } from "@/features/permissions/RuleList";
import { ShareForm } from "@/features/shares/ShareForm";
import { parseShareMode, shareModeLabel } from "@/features/shares/shareUtils";
import { FinderTagEditor } from "@/features/tags/FinderTagEditor";
import { TagEditor } from "@/features/tags/TagEditor";
import { formatDate, formatSize, isPicture, isVideoType, kindLabel } from "@/lib/format";
import { displayPath } from "@/lib/paths";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FilmRecipe, FileWindow, ImageMetadata } from "@/types/kago";
import { FileThumbnail } from "./FileThumbnail";
import { videoInfoGroups } from "./videoInfo";
import { t } from "@/lib/i18n";

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
  // Likewise a video the server cannot probe.
  const video = useMediaInfo(rootSlug, path, Boolean(meta.data && meta.data.kind === "file" && isVideoType(meta.data.type))).data;
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
    <aside className="relative flex max-w-[60%] shrink-0 flex-col border-l border-line bg-surface" style={{ width }} aria-label={t("Info")}>
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize touch-none" {...resizeHandlers} />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <strong className="flex-1 font-semibold">{t("Info")}</strong>
        <KagoIconButton label={t("Close info panel")} onClick={() => store().updateWindow(activeWindow.id, { inspectorOpen: false })}><X /></KagoIconButton>
      </header>

      {meta.isLoading ? (
        <KagoLoading />
      ) : meta.error || !meta.data ? (
        <p className="m-0 p-4 text-muted">{t("Couldn’t load this item’s info.")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <FileThumbnail rootSlug={rootSlug} item={meta.data} size={path === "/" || meta.data.kind === "folder" ? 64 : 144} />
            <strong className="max-w-full text-sm font-semibold break-words">{path === "/" ? activeWindow.title : meta.data.name}</strong>
            <span className="-mt-1.5 text-muted">
              {kindLabel(meta.data)}
              {meta.data.kind === "file" ? ` · ${formatSize(meta.data.size)}` : ""}
            </span>
            {selectedCount > 1 ? <KagoBadge>{t("{count} selected, showing the last one", { count: selectedCount })}</KagoBadge> : null}
          </div>

          <Section title={t("General")}>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <Detail label={t("Modified")}>{formatDate(meta.data.mtime)}</Detail>
              <Detail label={t("Location")}><span title={`${rootSlug}:${path}`}>{displayPath(root?.name ?? rootSlug, path)}</span></Detail>
              {readonly ? <Detail label={t("Access")}>{t("Read-only")}</Detail> : null}
            </dl>
          </Section>

          {photo && Object.keys(photo).length > 0 ? <PhotoDetails photo={photo} /> : null}

          {video
            ? videoInfoGroups(video).map((group) => (
                <Section key={group.title} title={group.title}>
                  <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                    {group.rows.map((row, index) => <Detail key={index} label={row.label}>{row.value}</Detail>)}
                  </dl>
                </Section>
              ))
            : null}

          {/* Two kinds of tag, one place: where each is kept is what tells them apart. */}
          <Section title={t("Tags")}>
            {/* Finder tags are kept on the file itself, which only a folder on the server's own disk can do. */}
            {(readonly && !meta.data.finderTags?.length) || (root && root.provider !== "local") ? null : (
              <TagGroup label="Finder" hint={t("Stored on the file, visible in Finder too")}>
                <FinderTagEditor rootSlug={rootSlug} path={path} tags={meta.data.finderTags ?? []} readonly={readonly} />
              </TagGroup>
            )}
            <TagGroup label="Kago" hint={t("Kept in Kago only")}>
              <TagEditor rootSlug={rootSlug} path={path} />
            </TagGroup>
          </Section>

          <Section title={t("Share links")}>
            {pathShares.length > 0 ? (
              <ul className="m-0 mb-3 flex list-none flex-col gap-1.5 p-0">
                {pathShares.map((share) => (
                  <li key={share.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{shareModeLabel(parseShareMode(share.permission_json))} · {t("{count} download | {count} downloads", { count: share.download_count })}</span>
                    <KagoBadge tone={share.disabled ? "neutral" : "success"}>{share.disabled ? t("Disabled") : t("Active")}</KagoBadge>
                  </li>
                ))}
              </ul>
            ) : null}
            {sharingKey === shareKey ? (
              <>
                <ShareForm key={shareKey} target={{ rootSlug, path }} compact />
                <Button className="mt-2 w-full" onClick={() => setSharingKey(null)}>{t("Collapse")}</Button>
              </>
            ) : (
              <>
                {pathShares.length === 0 ? <p className="m-0 mb-2 text-faint">{t("Not shared yet")}</p> : null}
                <Button className="w-full" onClick={() => setSharingKey(shareKey)}><Link2 />{t("Create share link")}</Button>
              </>
            )}
            {pathShares.length > 0 ? <Button className="mt-2 w-full" onClick={() => store().openApp("shares")}>{t("Manage all shares")}</Button> : null}
          </Section>

          {isAdmin ? (
            <Section title={t("Permission rules")}>
              {permissions.data?.length ? <RuleList rules={permissions.data} /> : <span className="text-faint">{t("No rules apply to this path")}</span>}
              <Button className="mt-2 w-full" onClick={() => store().openApp("settings", "permissions")}>{t("Manage permissions")}</Button>
            </Section>
          ) : null}
        </div>
      )}
    </aside>
  );
}

// exiftool names these in English; the ones cameras actually write are few enough to translate.
const WHITE_BALANCE: Record<string, string> = { Auto: t("Auto"), Manual: t("Manual"), Daylight: t("Daylight"), Cloudy: t("Cloudy"), Shade: t("Shade"), Tungsten: t("Tungsten"), Fluorescent: t("Fluorescent"), Flash: t("Flash") };
const METERING: Record<string, string> = { "Multi-segment": t("Multi-segment"), "Center-weighted average": t("Center-weighted"), Spot: t("Spot"), Average: t("Average"), Partial: t("Partial") };
const PROGRAM: Record<string, string> = { Manual: t("Manual"), "Program AE": t("Program"), "Aperture-priority AE": t("Aperture priority"), "Shutter speed priority AE": t("Shutter priority"), Portrait: t("Portrait"), Landscape: t("Landscape") };

const LEVEL: Record<string, string> = { Off: t("Off"), Weak: t("Weak"), Strong: t("Strong"), Small: t("Small"), Large: t("Large") };

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
const trimLength = (value: string) => value.replace(/\.0+(?= ?mm)/, "");

/** What the camera recorded about a picture, in the order a photographer asks for it. */
export function PhotoDetails({ photo }: { photo: ImageMetadata }) {
  const exposure = [photo.exposureTime ? t("{seconds}s", { seconds: photo.exposureTime }) : "", photo.aperture ? `f/${photo.aperture}` : "", photo.iso ? `ISO ${photo.iso}` : ""].filter(Boolean).join(" · ");
  const focal = photo.focalLength ? trimLength(photo.focalLength) + (photo.focalLength35 && trimLength(photo.focalLength35) !== trimLength(photo.focalLength) ? t(" ({length} equivalent)", { length: trimLength(photo.focalLength35) }) : "") : "";
  const compensation = photo.exposureCompensation ? `${photo.exposureCompensation > 0 ? "+" : ""}${Math.round(photo.exposureCompensation * 100) / 100} EV` : "";
  const flash = photo.flash ? (/no flash|did not fire|^off/i.test(photo.flash) ? t("Did not fire") : /fired|^on/i.test(photo.flash) ? t("Fired") : photo.flash) : "";
  const program = photo.exposureProgram && photo.exposureProgram !== "Not Defined" ? PROGRAM[photo.exposureProgram] ?? photo.exposureProgram : "";
  const pixels = photo.width && photo.height ? t("{width} × {height} ({megapixels} MP)", { width: photo.width, height: photo.height, megapixels: ((photo.width * photo.height) / 1e6).toFixed(1) }) : "";
  const gps = photo.gps;
  return (
    <>
      <Section title={t("Photo info")}>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {photo.camera ? <Detail label={t("Camera")}>{photo.camera}</Detail> : null}
          {photo.lens ? <Detail label={t("Lens")}>{photo.lens}</Detail> : null}
          {photo.takenAt ? <Detail label={t("Taken")}>{photo.takenAt}{photo.timeZone ? <span className="text-faint"> {photo.timeZone}</span> : null}</Detail> : null}
          {exposure ? <Detail label={t("Exposure")}>{exposure}</Detail> : null}
          {focal ? <Detail label={t("Focal length")}>{focal}</Detail> : null}
          {compensation ? <Detail label={t("Exposure compensation")}>{compensation}</Detail> : null}
          {program ? <Detail label={t("Exposure mode")}>{program}</Detail> : null}
          {photo.meteringMode ? <Detail label={t("Metering")}>{METERING[photo.meteringMode] ?? photo.meteringMode}</Detail> : null}
          {photo.whiteBalance ? <Detail label={t("White balance")}>{WHITE_BALANCE[photo.whiteBalance] ?? photo.whiteBalance}</Detail> : null}
          {flash ? <Detail label={t("Flash")}>{flash}</Detail> : null}
          {pixels ? <Detail label={t("Dimensions")}>{pixels}</Detail> : null}
          {photo.colorSpace ? <Detail label={t("Color space")}>{photo.colorSpace}</Detail> : null}
          {photo.software ? <Detail label={t("Software")}>{photo.software}</Detail> : null}
          {gps ? (
            <Detail label={t("Location##GPS")}>
              <a className="text-accent underline underline-offset-2" href={`https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=15/${gps.latitude}/${gps.longitude}`} target="_blank" rel="noreferrer">
                {gps.latitude.toFixed(5)}, {gps.longitude.toFixed(5)}
              </a>
              {gps.altitude !== undefined ? <span className="text-faint"> · {t("{meters} m altitude", { meters: Math.round(gps.altitude) })}</span> : null}
            </Detail>
          ) : null}
        </dl>
      </Section>
      {photo.filmRecipe ? <FilmRecipeDetails recipe={photo.filmRecipe} /> : null}
    </>
  );
}

/** The settings behind a Fujifilm picture's look, in the order the camera's menu lists them. */
function FilmRecipeDetails({ recipe }: { recipe: FilmRecipe }) {
  const level = (value: string) => LEVEL[value] ?? value;
  const auto = (on?: boolean) => (on ? t(" (auto)") : "");
  // The size says nothing once the grain is off, and older bodies have no size to set.
  const grain = recipe.grainRoughness ? [recipe.grainRoughness, ...(recipe.grainRoughness !== "Off" && recipe.grainSize && recipe.grainSize !== "Off" ? [recipe.grainSize] : [])].map(level).join(" · ") : "";
  const shift = recipe.whiteBalanceShift;
  const priority = recipe.dRangePriority ? level(recipe.dRangePriority) + auto(recipe.dRangePriorityAuto) : recipe.dRangePriorityAuto ? t("Auto") : "";
  const monochrome = [recipe.monochromeWarmCool !== undefined ? `WC ${signed(recipe.monochromeWarmCool)}` : "", recipe.monochromeMagentaGreen !== undefined ? `MG ${signed(recipe.monochromeMagentaGreen)}` : ""].filter(Boolean).join(" · ");
  const steps: Array<[string, number | undefined]> = [
    [t("Highlights"), recipe.highlight],
    [t("Shadows"), recipe.shadow],
    [t("Color##film"), recipe.color],
    [t("Sharpness"), recipe.sharpness],
    [t("Noise reduction"), recipe.noiseReduction],
    [t("Clarity"), recipe.clarity]
  ];
  return (
    <Section title={t("Film recipe")}>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {recipe.simulation ? <Detail label={t("Film simulation")}>{recipe.simulation}</Detail> : null}
        {monochrome ? <Detail label={t("Monochromatic color")}>{monochrome}</Detail> : null}
        {grain ? <Detail label={t("Grain effect")}>{grain}</Detail> : null}
        {recipe.colorChrome ? <Detail label={t("Color Chrome effect")}>{level(recipe.colorChrome)}</Detail> : null}
        {recipe.colorChromeBlue ? <Detail label={t("Color Chrome FX Blue")}>{level(recipe.colorChromeBlue)}</Detail> : null}
        {recipe.colorTemperature ? <Detail label={t("Color temperature")}>{recipe.colorTemperature} K</Detail> : null}
        {shift ? <Detail label={t("White balance shift")}>R {signed(shift.red)} · B {signed(shift.blue)}</Detail> : null}
        {recipe.dynamicRange ? <Detail label={t("Dynamic range")}>DR{recipe.dynamicRange}{auto(recipe.dynamicRangeAuto)}</Detail> : null}
        {priority ? <Detail label={t("D-Range priority")}>{priority}</Detail> : null}
        {steps.map(([label, value]) => (value !== undefined ? <Detail key={label} label={label}>{signed(value)}</Detail> : null))}
      </dl>
    </Section>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
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

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}
