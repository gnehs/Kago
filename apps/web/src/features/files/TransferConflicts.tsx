import { useEffect, useState } from "react";
import { Combine, CopyPlus, Replace, SkipForward } from "lucide-react";
import { create } from "zustand";
import { api } from "@/api/client";
import { KagoChoice } from "@/components/kago/choice";
import { KagoDialog } from "@/components/kago/dialog";
import { FileTile } from "@/components/kago/file-icon";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Select } from "@/components/ui/input";
import { formatDate, formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { FileRef } from "@/stores/clipboard";
import { folderTitle } from "@/stores/workspace";

/** What becomes of one of two that cannot both have the name. */
type Clash = "skip" | "replace" | "keep";
/** What a copy or move does where the destination already has a source's name; after `merge_`, what happens to a file both folders have. */
export type ConflictAction = Clash | `merge_${Clash}`;
/** The action chosen for each name the destination already has, in NFC. */
export type ConflictChoices = Record<string, ConflictAction>;

/** What tells one of the two from the other. A size is a file's only, and a time is 0 where the location keeps none. */
type Details = { kind: "file" | "folder"; size: number; mtime: number };
type Conflict = Details & { rootSlug: string; path: string; name: string; /** The one the destination has. */ existing: Details; /** It is where it would be put already. */ same: boolean };
type Answer = { action: ConflictAction; /** The same goes for every conflict still to come. */ all: boolean };
type ConflictRequest = { type: "copy" | "move"; conflict: Conflict; folder: string; remaining: number; resolve: (answer: Answer | null) => void };

const useConflictStore = create<{ request: ConflictRequest | null }>(() => ({ request: null }));

function ask(request: Omit<ConflictRequest, "resolve">) {
  return new Promise<Answer | null>((resolve) => {
    useConflictStore.getState().request?.resolve(null);
    useConflictStore.setState({ request: { ...request, resolve } });
  });
}

function settle(answer: Answer | null) {
  useConflictStore.getState().request?.resolve(answer);
  useConflictStore.setState({ request: null });
}

const mergeable = (conflict: Conflict) => conflict.kind === "folder" && conflict.existing.kind === "folder";

/** Only a folder goes into a folder: for anything else, merging means what was chosen for the files inside. */
const fitted = (action: ConflictAction, conflict: Conflict): ConflictAction => (action.startsWith("merge_") && !mergeable(conflict) ? (action.slice("merge_".length) as Clash) : action);

/**
 * Finds which of the sources the destination already has by name, and asks what to do with each.
 * Resolves to the choices made, to send along with the task, or to nothing when the whole thing was called off.
 */
export async function resolveConflicts(type: "copy" | "move", sources: FileRef[], destination: FileRef): Promise<ConflictChoices | null> {
  const { conflicts } = await api<{ conflicts: Conflict[] }>("/api/tasks/conflicts", { method: "POST", body: JSON.stringify({ sources, destination }) });
  const choices: ConflictChoices = {};
  const asked = conflicts.filter((conflict) => !conflict.same);
  // Put where it already is, a copy can only be a second one beside it, and a move has nothing to do.
  for (const conflict of conflicts) if (conflict.same) choices[conflict.name] = type === "copy" ? "keep" : "skip";
  let forAll: ConflictAction | null = null;
  for (const [index, conflict] of asked.entries()) {
    if (!forAll) {
      const answer = await ask({ type, conflict, folder: folderTitle(destination.rootSlug, destination.path), remaining: asked.length - index - 1 });
      if (!answer) return null;
      if (answer.all) forAll = answer.action;
      choices[conflict.name] = answer.action;
    } else choices[conflict.name] = fitted(forAll, conflict);
  }
  return choices;
}

/** One of the two, as what there is to compare: whether it is a file or a folder, how large, and when it was last changed. */
function Side({ label, details, newer }: { label: string; details: Details; newer: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="truncate">{details.kind === "folder" ? t("Folder") : formatSize(details.size)}</span>
      {details.mtime > 0 ? (
        <span className="truncate text-xs text-muted">
          {formatDate(details.mtime)}
          {newer ? <span className="font-medium text-accent"> · {t("Newer")}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export function TransferConflictDialogHost() {
  const pending = useConflictStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  const [choice, setChoice] = useState<Clash | "merge">("keep");
  const [inside, setInside] = useState<Clash>("keep");
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setRequest(pending);
    // What loses nothing is the one already chosen.
    setChoice(mergeable(pending.conflict) ? "merge" : "keep");
    setInside("keep");
    setAll(false);
  }, [pending]);

  if (!request) return null;
  const { type, conflict, folder, remaining } = request;
  const { existing } = conflict;
  const dated = conflict.mtime > 0 && existing.mtime > 0;
  const options = [
    ...(mergeable(conflict) ? [{ value: "merge" as const, label: t("Merge"), icon: <Combine /> }] : []),
    { value: "keep" as const, label: t("Keep both"), icon: <CopyPlus /> },
    { value: "replace" as const, label: t("Replace"), icon: <Replace /> },
    { value: "skip" as const, label: t("Skip"), icon: <SkipForward /> }
  ];
  const explained = {
    merge: t("What is in this folder is added to the one already there."),
    keep: t("This one goes beside it, under a name of its own."),
    replace: existing.kind === "folder" ? t("The folder already there is deleted with everything in it, and can’t be brought back.") : t("The one already there is deleted, and can’t be brought back."),
    skip: t("This one is left out, and the one already there stays as it is.")
  }[choice];

  return (
    <KagoDialog question open={Boolean(pending)} onClose={() => settle(null)} title={t("“{folder}” already has an item with this name", { folder })}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          settle({ action: choice === "merge" ? `merge_${inside}` : choice, all });
        }}
      >
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-5">
          <div className="flex max-w-full flex-col items-center text-center">
            <span className="mb-2.5 flex size-12 shrink-0 items-center justify-center">
              <FileTile item={{ kind: conflict.kind, name: conflict.name, type: "" }} className="size-12" />
            </span>
            <strong className="max-w-full truncate font-semibold">{conflict.name}</strong>
          </div>
          {/* The two side by side, the one arriving first: what there is to tell them apart by. */}
          <div className="grid grid-cols-2 divide-x divide-line rounded-md border border-line">
            <Side label={type === "copy" ? t("Being copied") : t("Being moved")} details={conflict} newer={dated && conflict.mtime > existing.mtime} />
            <Side label={t("Already there")} details={existing} newer={dated && existing.mtime > conflict.mtime} />
          </div>
          <KagoChoice label={t("What to do with it")} options={options} value={choice} onChange={setChoice} />
          <p className="m-0 text-center text-xs text-muted text-pretty">{explained}</p>
          {choice === "merge" ? (
            <Field label={t("Files both folders have")}>
              <Select value={inside} onChange={(event) => setInside(event.target.value as Clash)}>
                <option value="keep">{t("Keep both")}</option>
                <option value="replace">{t("Replace the ones already there")}</option>
                <option value="skip">{t("Skip")}</option>
              </Select>
            </Field>
          ) : null}
          {remaining > 0 ? (
            <Checkbox label={t("Do the same for the other {count} item | Do the same for the other {count} items", { count: remaining })} checked={all} onChange={(event) => setAll(event.target.checked)} />
          ) : null}
        </div>
        <footer className="grid shrink-0 grid-cols-2 gap-2 rounded-b-lg border-t border-line bg-elevated p-3">
          <Button size="lg" onClick={() => settle(null)}>{t("Cancel")}</Button>
          <Button size="lg" type="submit" variant={choice === "replace" || (choice === "merge" && inside === "replace") ? "destructive-primary" : "default"} autoFocus>
            {t("Continue")}
          </Button>
        </footer>
      </form>
    </KagoDialog>
  );
}
