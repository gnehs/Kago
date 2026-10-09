import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api } from "@/api/client";
import { KagoDialog } from "@/components/kago/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox, Field } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import type { FileRef } from "@/stores/clipboard";
import type { FileTask } from "@/types/kago";

type ExtractRequest = { sources: FileRef[]; destination: FileRef };
type PasswordChoice = { password: string; remember: boolean };
type PasswordPrompt = { name: string; wrong: boolean; resolve: (choice: PasswordChoice | null) => void };

/** What the server says when none of the passwords it has opens an archive. */
const passwordErrors = ["Archive password required", "Wrong archive password"];

/** Extractions started in this tab; one that turns out to need a password asks for it here. */
export const pendingExtracts = new Map<string, ExtractRequest>();

const usePromptStore = create<{ prompt: PasswordPrompt | null }>(() => ({ prompt: null }));

function settle(choice: PasswordChoice | null) {
  usePromptStore.getState().prompt?.resolve(choice);
  usePromptStore.setState({ prompt: null });
}

function promptArchivePassword(options: { name: string; wrong: boolean }) {
  return new Promise<PasswordChoice | null>((resolve) => {
    usePromptStore.getState().prompt?.resolve(null);
    usePromptStore.setState({ prompt: { ...options, resolve } });
  });
}

/** The extraction a failed task was, if what it failed on was the password. */
export function lockedExtract(task: FileTask): ExtractRequest | null {
  if (task.type !== "extract" || task.status !== "failed" || !passwordErrors.includes(task.error_message ?? "") || !task.destination) return null;
  try {
    const destination = JSON.parse(task.destination) as Partial<FileRef>;
    const sources = JSON.parse(task.sources_json) as FileRef[];
    return typeof destination.rootSlug === "string" && typeof destination.path === "string" ? { sources, destination: { rootSlug: destination.rootSlug, path: destination.path } } : null;
  } catch {
    return null;
  }
}

export async function startExtract(queryClient: QueryClient, request: ExtractRequest, options?: PasswordChoice) {
  const task = await api<FileTask>("/api/tasks", { method: "POST", body: JSON.stringify({ type: "extract", ...request, options }) });
  pendingExtracts.set(task.id, request);
  await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  return task;
}

/** Asks for the password of an archive the saved ones did not open, and extracts it again with the answer. */
export async function extractWithPassword(queryClient: QueryClient, request: ExtractRequest, error: string) {
  const first = request.sources[0]?.path ?? "";
  const choice = await promptArchivePassword({ name: first.slice(first.lastIndexOf("/") + 1), wrong: error === "Wrong archive password" });
  if (choice) await run(() => startExtract(queryClient, request, choice));
}

/** Takes over a failed extraction of this tab's if a password is all it lacks; says whether it did. */
export function askForArchivePassword(queryClient: QueryClient, taskId: string, error: string | undefined): boolean {
  const request = pendingExtracts.get(taskId);
  pendingExtracts.delete(taskId);
  if (!request || !error || !passwordErrors.includes(error)) return false;
  void extractWithPassword(queryClient, request, error);
  return true;
}

export function ArchivePasswordDialogHost() {
  const pending = usePromptStore((state) => state.prompt);
  // The last request stays on show while its dialog fades out.
  const [prompt, setPrompt] = useState(pending);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setPrompt(pending);
    setPassword("");
    setRemember(false);
  }, [pending]);

  if (!prompt) return null;

  return (
    <KagoDialog open={Boolean(pending)} onClose={() => settle(null)} title={prompt.wrong ? t("That password didn’t open the archive") : t("This archive needs a password")}>
      <form
        className="flex flex-col gap-3 p-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (password) settle({ password, remember });
        }}
      >
        <p className="m-0 truncate text-muted">{prompt.name}</p>
        <Field label={t("Password")}>
          <KagoPasswordInput autoFocus autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Checkbox label={t("Remember this password for other archives")} checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => settle(null)}>{t("Cancel")}</Button>
          <Button type="submit" variant="default" disabled={!password}>{t("Extract")}</Button>
        </div>
      </form>
    </KagoDialog>
  );
}
