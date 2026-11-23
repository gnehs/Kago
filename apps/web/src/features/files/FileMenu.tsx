import { Archive, ArchiveRestore, CircleUserRound, ClipboardPaste, Copy, Download, ExternalLink, FileOutput, FileVideo, FolderOpen, FolderPlus, FolderUp, Inbox, Info, ListVideo, PanelTop, Pencil, Play, RefreshCw, Scissors, SquareArrowOutUpRight, Star, StarOff, Trash2, Upload, Wallpaper } from "lucide-react";
import { KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { chooseAvatar } from "@/features/auth/AvatarDialog";
import { autoConvertInto } from "@/features/convert/AutoConvertPage";
import { mediaKindOf } from "@/features/convert/convertSpec";
import { openTrackEditor } from "@/features/convert/TrackEditor";
import { isArchive } from "@/lib/fileKind";
import { isCueSheet, isMusicFile, isPicture, isVideoType } from "@/lib/format";
import { t } from "@/lib/i18n";
import { parentPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { useClipboardStore } from "@/stores/clipboard";
import { setFavorite, setWallpaper, useSettingsStore } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FolderWindow } from "@/types/kago";
import type { FileActions } from "./useFileActions";
import type { useUploadPicker } from "./useUploadPicker";
import { videoPageUrl } from "./VideoPage";

const store = useWorkspaceStore.getState;

export const canTrash = (readonly: boolean, targets: FileItem[]) => !readonly && !targets.some((item) => item.readonly);

type FileMenuProps = {
  win: FolderWindow;
  /** What the menu acts on, or nothing, for the folder itself. */
  targets: FileItem[];
  /** The folder the menu is for when `targets` is empty. */
  folder?: string;
  readonly: boolean;
  /** Everything the window's folder holds. */
  allItems: FileItem[];
  actions: FileActions;
  openItem: (item: FileItem, where?: "window" | "tab") => void;
  picker: Pick<ReturnType<typeof useUploadPicker>, "pickFiles" | "pickFolder">;
};

/** Every action for a set of items, or for `folder` when there are none. Shared by right click and the toolbar. */
export function FileMenu({ win, targets, folder = win.logicalPath, readonly, allItems, actions, openItem, picker }: FileMenuProps) {
  const clip = useClipboardStore((state) => state.clip);
  const favorites = useSettingsStore((state) => state.favorites);

  const favoriteToggle = (path: string) => {
    const here = { rootSlug: win.rootSlug, path };
    const favorite = favorites.some((entry) => entry.rootSlug === here.rootSlug && entry.path === path);
    return <KagoMenuItem icon={favorite ? <StarOff /> : <Star />} onClick={() => void setFavorite(here, !favorite)}>{favorite ? t("Remove from Favorites") : t("Add to Favorites")}</KagoMenuItem>;
  };

  const paths = targets.map((item) => item.path);
  const single = targets.length === 1 ? targets[0]! : null;
  const count = targets.length;
  // Video and music open in a player, so the menu says what opening them does.
  // Files of one kind of media can all be made into the same thing.
  const kinds = new Set(targets.map(mediaKindOf));
  const convertible = kinds.size === 1 ? [...kinds][0]! : null;
  const playable = single?.kind === "file" && (isVideoType(single.type) || isMusicFile(single) || isCueSheet(single));
  return targets.length > 0 ? (
    <>
      {single ? <KagoMenuItem icon={playable ? <Play /> : <FolderOpen />} shortcut="↩" onClick={() => openItem(single)}>{playable ? t("Play") : t("Open")}</KagoMenuItem> : null}
      {single?.kind === "folder" ? <KagoMenuItem icon={<PanelTop />} onClick={() => openItem(single, "tab")}>{t("Open in new tab")}</KagoMenuItem> : null}
      {single?.kind === "folder" ? <KagoMenuItem icon={<ExternalLink />} onClick={() => openItem(single, "window")}>{t("Open in new window")}</KagoMenuItem> : null}
      {single?.kind === "folder" ? favoriteToggle(single.path) : null}
      {single?.kind === "file" && isVideoType(single.type) ? (
        <KagoMenuItem icon={<SquareArrowOutUpRight />} onClick={() => globalThis.open(videoPageUrl(win.rootSlug, single.path), "_blank", "noopener")}>{t("Play in new tab")}</KagoMenuItem>
      ) : null}
      <KagoMenuItem icon={<Download />} onClick={() => void actions.download(targets)}>{count > 1 ? t("Download {count} item | Download {count} items", { count }) : t("Download")}</KagoMenuItem>
      <KagoMenuItem icon={<Inbox />} onClick={() => void actions.addToShelf(paths)}>{t("Add to Shelf")}</KagoMenuItem>
      <KagoMenuItem icon={<Info />} shortcut="⌘I" onClick={() => store().updateWindow(win.id, { inspectorOpen: true })}>{t("Info, tags and sharing")}</KagoMenuItem>
      {single && isPicture(single) ? (
        <KagoMenuItem
          icon={<Wallpaper />}
          onClick={() =>
            void run(async () => {
              await setWallpaper({ rootSlug: win.rootSlug, path: single.path });
              toast(t("Desktop background set"));
            }, t("Couldn’t set the desktop background"))
          }
        >
          {t("Set as desktop background")}
        </KagoMenuItem>
      ) : null}
      {single && isPicture(single) ? (
        <KagoMenuItem icon={<CircleUserRound />} onClick={() => chooseAvatar(win.rootSlug, single, win.id)}>{t("Set as profile picture…")}</KagoMenuItem>
      ) : null}
      <KagoMenuSeparator />
      <KagoMenuItem icon={<Copy />} shortcut="⌘C" onClick={() => actions.copy(paths)}>{t("Copy")}</KagoMenuItem>
      <KagoMenuItem icon={<Scissors />} shortcut="⌘X" disabled={readonly || targets.some((item) => item.readonly)} onClick={() => actions.cut(paths)}>{t("Cut")}</KagoMenuItem>
      {single ? <KagoMenuItem icon={<Pencil />} disabled={readonly || single.readonly} onClick={() => void actions.rename(single)}>{t("Rename")}</KagoMenuItem> : null}
      {count > 1 ? <KagoMenuItem icon={<Pencil />} disabled={readonly || targets.some((item) => item.readonly)} onClick={() => void actions.renameMany(targets)}>{t("Rename {count} item… | Rename {count} items…", { count })}</KagoMenuItem> : null}
      <KagoMenuItem icon={<FolderPlus />} disabled={readonly || targets.some((item) => item.readonly)} onClick={() => void actions.newFolderWith(paths)}>{count > 1 ? t("New folder with {count} item | New folder with {count} items", { count }) : t("New folder with selection")}</KagoMenuItem>
      <KagoMenuItem icon={<Archive />} disabled={readonly} onClick={() => void actions.compress(paths)}>{count > 1 ? t("Compress {count} item | Compress {count} items", { count }) : t("Compress")}</KagoMenuItem>
      {targets.every(isArchive) ? <KagoMenuItem icon={<ArchiveRestore />} disabled={readonly} onClick={() => void actions.extract(paths)}>{t("Extract here")}</KagoMenuItem> : null}
      {convertible ? <KagoMenuItem icon={<FileOutput />} disabled={readonly} onClick={() => void actions.convert(targets, convertible)}>{count > 1 ? t("Convert {count} item… | Convert {count} items…", { count }) : t("Convert…")}</KagoMenuItem> : null}
      {single && convertible === "video" ? <KagoMenuItem icon={<ListVideo />} disabled={readonly} onClick={() => openTrackEditor({ window: win.id, rootSlug: win.rootSlug, item: single, siblings: allItems.filter((item) => parentPath(item.path) === parentPath(single.path)) })}>{t("Edit tracks…")}</KagoMenuItem> : null}
      {single?.kind === "folder" ? <KagoMenuItem icon={<FileVideo />} disabled={readonly || single.readonly} onClick={() => autoConvertInto({ rootSlug: win.rootSlug, path: single.path })}>{t("Auto-convert into this folder…")}</KagoMenuItem> : null}
      <KagoMenuSeparator />
      <KagoMenuItem icon={<Trash2 />} destructive disabled={!canTrash(readonly, targets)} onClick={() => void actions.trash(paths)}>{t("Move to Trash")}</KagoMenuItem>
    </>
  ) : (
    <>
      {clip ? (
        <>
          <KagoMenuItem icon={<ClipboardPaste />} shortcut="⌘V" disabled={readonly} onClick={() => void actions.paste(folder)}>{t("Paste {count} item | Paste {count} items", { count: clip.items.length })}</KagoMenuItem>
          <KagoMenuSeparator />
        </>
      ) : null}
      <KagoMenuItem icon={<FolderPlus />} disabled={readonly} onClick={() => void actions.newFolder(folder)}>{t("New folder")}</KagoMenuItem>
      <KagoMenuItem icon={<Upload />} disabled={readonly} onClick={() => picker.pickFiles(folder)}>{t("Upload files")}</KagoMenuItem>
      <KagoMenuItem icon={<FolderUp />} disabled={readonly} onClick={() => picker.pickFolder(folder)}>{t("Upload folder")}</KagoMenuItem>
      <KagoMenuItem icon={<FileVideo />} disabled={readonly} onClick={() => autoConvertInto({ rootSlug: win.rootSlug, path: folder })}>{t("Auto-convert into this folder…")}</KagoMenuItem>
      <KagoMenuSeparator />
      <KagoMenuItem icon={<PanelTop />} shortcut="⌥T" onClick={() => store().openTab(win.id, win)}>{t("New tab")}</KagoMenuItem>
      <KagoMenuItem icon={<ExternalLink />} onClick={() => store().openWindow({ rootSlug: win.rootSlug, logicalPath: win.logicalPath, title: win.title })}>{t("Open this folder in a new window (⌥N)")}</KagoMenuItem>
      {favoriteToggle(folder)}
      <KagoMenuItem icon={<RefreshCw />} shortcut="⌘R" onClick={() => void actions.refresh()}>{t("Refresh")}</KagoMenuItem>
    </>
  );
}
