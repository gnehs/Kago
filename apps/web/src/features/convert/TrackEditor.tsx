import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, AudioLines, Captions, Film, X } from "lucide-react";
import { create } from "zustand";
import { api } from "@/api/client";
import { useMediaInfo } from "@/api/hooks";
import { KagoDialog, KagoDialogActions } from "@/components/kago/dialog";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { followTask } from "@/features/tasks/taskToast";
import { extensionOf } from "@/lib/fileKind";
import { isMusicFile } from "@/lib/format";
import { nfc } from "@/lib/paths";
import { run } from "@/lib/run";
import { languageLabel } from "@/lib/subtitles";
import type { FileItem, FileTask, MediaInfo } from "@/types/kago";
import { t } from "@/lib/i18n";

type Kind = "video" | "audio" | "subtitle";
type EditorRequest = { rootSlug: string; item: FileItem; /** What else is in the folder, to add tracks from. */ siblings: FileItem[] };

type Track = {
  key: string;
  kind: Kind;
  /** Its place among the video's own tracks of its kind, or the file it is brought in from. */
  source: { index: number } | { file: FileItem };
  /** What it is, in the words of whoever encoded it. */
  detail: string;
  language: string;
  title: string;
  isDefault: boolean;
  forced: boolean;
  enabled: boolean;
  /** How the video itself has it, so that only what was changed is sent. */
  original?: { language: string; title: string };
};

const useEditorStore = create<{ request: EditorRequest | null }>(() => ({ request: null }));

/** Opens the track editor for a video. */
export function openTrackEditor(request: EditorRequest) {
  useEditorStore.setState({ request });
}

const SUBTITLE_FILES = new Set(["srt", "ass", "ssa", "vtt", "sup"]);
const stem = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/** The language a sidecar's name gives between the video's name and its own ending, as in `film.zh-TW.srt`. */
function languageInName(name: string): string {
  const tag = /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.exec(stem(name))?.[1] ?? "";
  return tag && languageLabel(tag) !== tag ? tag : "";
}

function tracksOf(info: MediaInfo): Track[] {
  const video: Track[] = info.video
    ? [{ key: "video:0", kind: "video", source: { index: 0 }, detail: [info.video.codec.toUpperCase(), `${info.video.width}×${info.video.height}`, info.video.hdr ? "HDR" : ""].filter(Boolean).join(" · "), language: "", title: "", isDefault: false, forced: false, enabled: true }]
    : [];
  const audio = info.audio.map((stream, index): Track => ({
    key: `audio:${index}`,
    kind: "audio",
    source: { index },
    detail: [stream.codec.toUpperCase(), stream.layout || (stream.channels ? t("{count} channel | {count} channels", { count: stream.channels }) : "")].filter(Boolean).join(" · "),
    language: stream.language,
    title: stream.title,
    isDefault: stream.default,
    forced: false,
    enabled: true,
    original: { language: stream.language, title: stream.title }
  }));
  const subtitles = info.subtitles.map((stream, index): Track => ({
    key: `subtitle:${index}`,
    kind: "subtitle",
    source: { index },
    detail: stream.codec.toUpperCase(),
    language: stream.language,
    title: stream.title,
    isDefault: stream.default,
    forced: stream.forced,
    enabled: true,
    original: { language: stream.language, title: stream.title }
  }));
  return [...video, ...audio, ...subtitles];
}

const KIND_META: Record<Kind, { label: string; icon: React.ReactNode }> = {
  video: { label: t("Video"), icon: <Film /> },
  audio: { label: t("Audio"), icon: <AudioLines /> },
  subtitle: { label: t("Subtitles"), icon: <Captions /> }
};

export function TrackEditorHost() {
  const pending = useEditorStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  useEffect(() => {
    if (pending) setRequest(pending);
  }, [pending]);
  if (!request) return null;
  const close = () => useEditorStore.setState({ request: null });
  return (
    <KagoDialog open={Boolean(pending)} onClose={close} title={t("Tracks of “{name}”", { name: nfc(request.item.name) })} className="w-[min(680px,calc(100vw-32px))]">
      <TrackEditor key={`${request.rootSlug}:${request.item.path}`} request={request} onClose={close} />
    </KagoDialog>
  );
}

function TrackEditor({ request, onClose }: { request: EditorRequest; onClose: () => void }) {
  const queryClient = useQueryClient();
  const info = useMediaInfo(request.rootSlug, request.item.path);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const base = stem(nfc(request.item.name));
  const [name, setName] = useState(() => (extensionOf(request.item.name) === "mkv" ? `${base}.remux.mkv` : `${base}.mkv`));
  const [attachments, setAttachments] = useState(true);
  const [chapters, setChapters] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (info.data && !tracks) setTracks(tracksOf(info.data));
  }, [info.data, tracks]);

  // What the folder has that could be packed in: the files named after the video first.
  const candidates = useMemo(() => {
    const used = new Set((tracks ?? []).flatMap((track) => ("file" in track.source ? [track.source.file.path] : [])));
    return request.siblings
      .filter((item) => item.kind === "file" && item.path !== request.item.path && !used.has(item.path))
      .map((item) => ({ item, kind: SUBTITLE_FILES.has(extensionOf(item.name)) ? ("subtitle" as const) : isMusicFile(item) || ["mka", "ac3", "dts", "eac3"].includes(extensionOf(item.name)) ? ("audio" as const) : null }))
      .filter((candidate): candidate is { item: FileItem; kind: "audio" | "subtitle" } => candidate.kind !== null)
      .sort((a, b) => Number(nfc(b.item.name).startsWith(base)) - Number(nfc(a.item.name).startsWith(base)) || a.item.name.localeCompare(b.item.name));
  }, [request, tracks, base]);

  const patch = (key: string, change: Partial<Track>) => setTracks((current) => (current ?? []).map((track) => (track.key === key ? { ...track, ...change } : track)));
  /** One track of a kind is the one a player starts with; choosing it lets go of the other. */
  const setDefault = (target: Track, isDefault: boolean) => setTracks((current) => (current ?? []).map((track) => (track.kind !== target.kind ? track : { ...track, isDefault: track.key === target.key ? isDefault : isDefault ? false : track.isDefault })));
  const move = (target: Track, by: -1 | 1) =>
    setTracks((current) => {
      const all = [...(current ?? [])];
      const peers = all.filter((track) => track.kind === target.kind);
      const other = peers[peers.indexOf(target) + by];
      if (!other) return all;
      const [a, b] = [all.indexOf(target), all.indexOf(other)];
      [all[a], all[b]] = [all[b]!, all[a]!];
      return all;
    });
  const add = (item: FileItem, kind: "audio" | "subtitle") =>
    setTracks((current) => [...(current ?? []), { key: `file:${item.path}`, kind, source: { file: item }, detail: nfc(item.name), language: languageInName(nfc(item.name)), title: "", isDefault: false, forced: false, enabled: true }]);

  const kept = (tracks ?? []).filter((track) => track.enabled);
  const taken = request.siblings.some((item) => nfc(item.name).toLowerCase() === nfc(name.trim()).toLowerCase() || nfc(item.name).toLowerCase() === `${nfc(name.trim()).toLowerCase()}.mkv`);
  const canSubmit = !busy && kept.length > 0 && name.trim().length > 0 && !taken && kept.every((track) => /^[A-Za-z0-9-]*$/.test(track.language));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    const body = {
      source: { rootSlug: request.rootSlug, path: request.item.path },
      name: name.trim(),
      attachments,
      chapters,
      tracks: (["video", "audio", "subtitle"] as const).flatMap((kind) =>
        kept.filter((track) => track.kind === kind).map((track) => ({
          ...("file" in track.source ? { from: "file", file: { rootSlug: request.rootSlug, path: track.source.file.path } } : { from: "source", index: track.source.index }),
          kind,
          ...(kind === "video" ? {} : {
            // What the video already says of its own tracks goes along untouched.
            ...(track.language !== track.original?.language ? { language: track.language } : {}),
            ...(track.title !== track.original?.title ? { title: track.title.trim() } : {}),
            default: track.isDefault,
            forced: track.forced
          })
        }))
      )
    };
    const task = await run(() => api<FileTask>("/api/remux", { method: "POST", body: JSON.stringify(body) }), t("Couldn’t start repacking"));
    setBusy(false);
    if (!task) return;
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    followTask(task);
    onClose();
  }

  if (info.isLoading || (info.data && !tracks)) return <div className="p-8"><KagoLoading /></div>;
  if (!info.data?.video || !tracks) {
    return (
      <div className="flex flex-col gap-3 p-4 pt-2">
        <p className="m-0 text-muted text-pretty">{info.data && !info.data.transcode && !info.data.video ? t("The server has no ffmpeg, so it can’t read this video’s tracks.") : t("This file’s tracks couldn’t be read.")}</p>
        <KagoDialogActions><Button onClick={onClose}>{t("Close")}</Button></KagoDialogActions>
      </div>
    );
  }

  return (
    <form className="flex min-h-0 flex-col" onSubmit={submit}>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-2">
        <p className="m-0 text-xs text-muted text-pretty">{t("Choose what goes into a new MKV file. Nothing is encoded again, so the picture and sound stay exactly as they are and it takes moments.")}</p>
        {(["video", "audio", "subtitle"] as const).map((kind) => {
          const group = tracks.filter((track) => track.kind === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind} className="flex flex-col gap-1.5">
              <h3 className="m-0 flex items-center gap-1.5 text-xs font-medium text-muted [&>.lucide]:size-3.5">{KIND_META[kind].icon}{KIND_META[kind].label}</h3>
              <ul className="kago-card m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line p-0">
                {group.map((track, position) => (
                  // Every row has the same columns, so the fields of one track stand under those of the last.
                  <li key={track.key} className="flex items-center gap-2 px-3 py-2">
                    <Checkbox
                      className="min-w-0 flex-[1_1_7rem]"
                      checked={track.enabled}
                      onChange={(event) => patch(track.key, { enabled: event.target.checked })}
                      label={<span className="truncate" title={track.detail}>{track.detail || t("Track {number}", { number: position + 1 })}</span>}
                    />
                    {kind === "video" ? null : (
                      <>
                        <Input aria-label={t("Language")} className="w-20 flex-none" placeholder={t("Language")} title={languageLabel(track.language)} value={track.language} disabled={!track.enabled} onChange={(event) => patch(track.key, { language: event.target.value.trim() })} />
                        <Input aria-label={t("Title")} className="min-w-0 flex-[1_1_6rem]" placeholder={t("Title")} value={track.title} disabled={!track.enabled} onChange={(event) => patch(track.key, { title: event.target.value })} />
                        <Checkbox className="w-16 flex-none" label={t("Default")} checked={track.isDefault} disabled={!track.enabled} onChange={(event) => setDefault(track, event.target.checked)} />
                        {kind === "subtitle" ? <Checkbox className="w-16 flex-none" label={t("Forced")} checked={track.forced} disabled={!track.enabled} onChange={(event) => patch(track.key, { forced: event.target.checked })} /> : null}
                        <span className="flex w-18 flex-none">
                          <KagoIconButton label={t("Move up")} className="size-6" disabled={position === 0} onClick={() => move(track, -1)}><ArrowUp /></KagoIconButton>
                          <KagoIconButton label={t("Move down")} className="size-6" disabled={position === group.length - 1} onClick={() => move(track, 1)}><ArrowDown /></KagoIconButton>
                          {"file" in track.source ? <KagoIconButton label={t("Remove")} className="size-6" onClick={() => setTracks(tracks.filter((item) => item.key !== track.key))}><X /></KagoIconButton> : null}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Picking a file adds it; the list then stands ready for the next one. */}
          <Select
            aria-label={t("Add a track from this folder")}
            className="w-auto max-w-full flex-none"
            value=""
            disabled={candidates.length === 0}
            onChange={(event) => {
              const picked = candidates.find((candidate) => candidate.item.path === event.target.value);
              if (picked) add(picked.item, picked.kind);
            }}
          >
            <option value="">{candidates.length > 0 ? t("Add a track from this folder…") : t("No audio or subtitle files in this folder")}</option>
            {(["audio", "subtitle"] as const).map((kind) => {
              const files = candidates.filter((candidate) => candidate.kind === kind);
              return files.length > 0 ? (
                <optgroup key={kind} label={KIND_META[kind].label}>
                  {files.map(({ item }) => <option key={item.path} value={item.path}>{nfc(item.name)}</option>)}
                </optgroup>
              ) : null;
            })}
          </Select>
          {info.data.fonts?.length ? <Checkbox label={t("Keep attached fonts ({count})", { count: info.data.fonts.length })} checked={attachments} onChange={(event) => setAttachments(event.target.checked)} /> : null}
          <Checkbox label={t("Keep chapters")} checked={chapters} onChange={(event) => setChapters(event.target.checked)} />
        </div>
        <Field label={t("Save as")} hint={taken ? t("This folder already has a file with that name.") : t("Saved next to the original, which stays as it is.")}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
      <footer className="shrink-0 rounded-b-lg border-t border-line bg-elevated p-3">
        <KagoDialogActions>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="default" disabled={!canSubmit}>{t("Repack")}</Button>
        </KagoDialogActions>
      </footer>
    </form>
  );
}
