import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileWarning, Pencil, Save } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError, downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { errorMessage } from "@/lib/format";
import { parentPath, triggerDownload } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { guardWindowClose, useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileMeta } from "@/types/kago";
import type { CodeEditorHandle } from "./CodeEditor";
import { FileIcon } from "./FileIcon";

// CodeMirror is only downloaded by someone who opens a text file.
const CodeEditor = lazy(() => import("./CodeEditor"));
const MarkdownView = lazy(() => import("./MarkdownView"));

type LoadedText = { mtime: number; text: string; bom: boolean; crlf: boolean; lossy: boolean };

async function loadText(rootSlug: string, path: string): Promise<LoadedText> {
  // The mtime is read before the bytes: a change in between is then caught on save rather than missed.
  const meta = await api<FileMeta>(`/api/fs/meta?${new URLSearchParams({ rootSlug, path }).toString()}`);
  const response = await fetch(previewUrl(rootSlug, path), { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("無法讀取檔案");
  let bytes = new Uint8Array(await response.arrayBuffer());
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bom) bytes = bytes.subarray(3);
  let text: string;
  let lossy = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: still worth reading, but writing it back would damage the file.
    text = new TextDecoder().decode(bytes);
    lossy = true;
  }
  return { mtime: meta.mtime, text, bom, crlf: text.includes("\r\n"), lossy };
}

/** A text file in the code editor: highlighted by its name, saved back with ⌘S. */
export function TextPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const queryClient = useQueryClient();
  const editor = useRef<CodeEditorHandle>(null);
  const baseMtime = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [language, setLanguage] = useState("");
  // Markdown opens as the page it describes; the source is one click away.
  const isMarkdown = /\.(md|markdown)$/i.test(item.name);
  const [previewing, setPreviewing] = useState(isMarkdown);
  // What the editor held when the preview was last opened; null until it has been edited at all.
  const [draft, setDraft] = useState<string | null>(null);

  // Fetched once: a refetch behind the user's back would replace what they are typing.
  const file = useQuery({
    queryKey: ["fs", "content", rootSlug, item.path],
    queryFn: () => loadText(rootSlug, item.path),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });
  const loaded = file.data;
  const readOnly = item.readonly || Boolean(loaded?.lossy);

  useEffect(() => {
    if (loaded) baseMtime.current = loaded.mtime;
  }, [loaded]);

  useEffect(() => {
    if (!dirty) return;
    const withdraw = guardWindowClose(window.id, () => confirmAction({ title: `要捨棄「${item.name}」的變更嗎？`, description: "尚未儲存的變更會遺失。", confirmLabel: "捨棄", destructive: true }));
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener("beforeunload", warn);
    return () => {
      withdraw();
      globalThis.removeEventListener("beforeunload", warn);
    };
  }, [dirty, window.id, item.name]);

  async function save() {
    if (!editor.current || !loaded || readOnly || saving) return;
    const snapshot = editor.current.snapshot();
    const content = (loaded.bom ? "﻿" : "") + snapshot.text;
    const write = (mtime?: number) => api<FileMeta>("/api/fs/content", { method: "PUT", body: JSON.stringify({ rootSlug, path: item.path, content, mtime }) });
    setSaving(true);
    try {
      let meta: FileMeta;
      try {
        meta = await write(baseMtime.current);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "FILE_CHANGED") throw error;
        const overwrite = await confirmAction({ title: "檔案在開啟後被修改過", description: "儲存會覆寫別處所做的變更。", confirmLabel: "覆寫", destructive: true });
        if (!overwrite) return;
        meta = await write();
      }
      baseMtime.current = meta.mtime;
      snapshot.commit();
      useWorkspaceStore.getState().setPreviewItem(window.id, { ...item, size: meta.size, mtime: meta.mtime });
      void queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug, parentPath(item.path)] });
      void queryClient.invalidateQueries({ queryKey: ["fs", "meta", rootSlug, item.path] });
    } catch (error) {
      toast(errorMessage(error, "儲存失敗"), "error");
    } finally {
      setSaving(false);
    }
  }

  function togglePreview() {
    if (!previewing) setDraft(editor.current?.snapshot().text ?? null);
    setPreviewing(!previewing);
  }

  useEffect(() => {
    if (!previewing) editor.current?.focus();
  }, [previewing]);

  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));

  return (
    <KagoWindow
      window={window}
      keepMounted
      icon={<FileIcon item={item} />}
      titleExtra={
        <>
          {isMarkdown && loaded ? (
            <KagoIconButton label={previewing ? "編輯" : "預覽"} className="size-6" onClick={togglePreview}>
              {previewing ? <Pencil /> : <Eye />}
            </KagoIconButton>
          ) : null}
          {readOnly ? null : (
            <KagoIconButton label="儲存（⌘S）" className={dirty ? "size-6 text-accent" : "size-6"} disabled={!dirty || saving} onClick={() => void save()}>
              <Save />
            </KagoIconButton>
          )}
          <KagoIconButton label="下載" className="size-6" onClick={download}>
            <Download />
          </KagoIconButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        {file.isPending ? (
          <KagoLoading />
        ) : !loaded ? (
          <KagoEmptyState className="h-full" icon={<FileWarning />} title="無法讀取檔案" description={errorMessage(file.error, "請稍後再試。")}>
            <Button onClick={() => void file.refetch()}>重試</Button>
            <Button onClick={download}>下載</Button>
          </KagoEmptyState>
        ) : (
          <Suspense fallback={<KagoLoading />}>
            {previewing ? <MarkdownView text={draft ?? loaded.text} rootSlug={rootSlug} path={item.path} /> : null}
            {/* The editor stays behind the preview: it is what holds the unsaved text. */}
            <div className={cn("min-h-0 flex-1", previewing && "hidden")}>
            <CodeEditor
              // A reload is new text for the same file, and the editor only reads its text once.
              key={file.dataUpdatedAt}
              ref={editor}
              fileName={item.name}
              initial={loaded.text}
              lineSeparator={loaded.crlf ? "\r\n" : undefined}
              readOnly={readOnly}
              onDirty={setDirty}
              onSave={() => void save()}
              onCursor={(line, column) => setCursor({ line, column })}
              onLanguage={setLanguage}
            />
            </div>
          </Suspense>
        )}
      </div>
      {loaded ? (
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-elevated px-3 text-muted">
          <span>{language}</span>
          {previewing ? (
            <span>預覽</span>
          ) : (
            <span className="tabular-nums">
              第 {cursor.line} 行，第 {cursor.column} 欄
            </span>
          )}
          {loaded.crlf ? <span>CRLF</span> : null}
          <span className="ml-auto">{loaded.lossy ? "不是 UTF-8 編碼，僅供檢視" : item.readonly ? "唯讀" : saving ? "儲存中…" : dirty ? "尚未儲存" : ""}</span>
        </footer>
      ) : null}
    </KagoWindow>
  );
}
