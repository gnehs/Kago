import { FolderX, HardDrive, ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { useAdminContacts } from "@/api/hooks";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/format";
import { requestCloseWindow, useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow } from "@/types/kago";
import { t } from "@/lib/i18n";

export type FileWindowError = { kind: "root_missing" | "path_missing" | "forbidden" | "unknown"; title: string; message: string };

export function classifyFileWindowError(error: unknown): FileWindowError | null {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : "";
  if (code === "ROOT_NOT_FOUND") return { kind: "root_missing", title: t("Location not found"), message: t("The location this window pointed to no longer exists.") };
  if (code === "PATH_NOT_FOUND") return { kind: "path_missing", title: t("Folder not found"), message: t("The folder’s path is no longer valid.") };
  if (code === "FORBIDDEN") return { kind: "forbidden", title: t("No access"), message: t("You don’t have permission to open this location.") };
  return { kind: "unknown", title: t("Couldn’t load the folder"), message: errorMessage(error, t("Please try again later.")) };
}

/** A restored window whose target is gone stays open so the user decides what to do with it. */
export function WindowErrorState({ error, window, onRetry }: { error: FileWindowError; window: FileWindow; onRetry: () => void }) {
  const store = useWorkspaceStore.getState;
  const admins = useAdminContacts(error.kind === "forbidden").data ?? [];
  // Named in the text as well, so the request is not a dead end without a mail app.
  const contact = admins.length > 0 ? t(" Contact an administrator: {admins}.", { admins: admins.map((admin) => t("{name} ({email})", { name: admin.displayName, email: admin.email })).join(t(", ")) }) : "";

  function requestAccess() {
    const recipients = admins.map((admin) => encodeURIComponent(admin.email)).join(",");
    const subject = encodeURIComponent(t("Kago access request: {location}", { location: `${window.rootSlug}:${window.logicalPath}` }));
    const body = encodeURIComponent(t("Location: {root}\nPath: {path}\n\nPlease give me access to this folder.", { root: window.rootSlug, path: window.logicalPath }));
    globalThis.open(`mailto:${recipients}?subject=${subject}&body=${body}`, "_blank");
  }

  return (
    <KagoEmptyState
      className="h-full"
      icon={error.kind === "root_missing" ? <HardDrive /> : error.kind === "forbidden" ? <ShieldAlert /> : <FolderX />}
      title={error.title}
      description={error.kind === "forbidden" && contact ? `${error.message}${contact}` : error.message}
    >
      {error.kind === "path_missing" ? <Button onClick={() => store().updateWindow(window.id, { logicalPath: "/", selectedItems: [] })}>{t("Go to the top level")}</Button> : null}
      {error.kind === "forbidden" && admins.length > 0 ? <Button onClick={requestAccess}>{t("Request access by email")}</Button> : null}
      {error.kind === "unknown" ? <Button onClick={onRetry}>{t("Retry")}</Button> : null}
      <Button onClick={() => void requestCloseWindow(window.id)}>{t("Close window")}</Button>
    </KagoEmptyState>
  );
}
