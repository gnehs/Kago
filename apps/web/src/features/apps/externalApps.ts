import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { useWorkspaceStore } from "@/stores/workspace";
import type { ExternalApp } from "@/types/kago";

/**
 * Where a shortcut leads, when that is somewhere a link may lead. The server keeps only web addresses; the
 * interface still checks before it makes a link of one, as an address of another kind would run as script.
 */
export const appHref = (app: Pick<ExternalApp, "id" | "url" | "authUser">) =>
  // One with a sign-in is opened through Kago, which sends the browser on with the sign-in; the page never holds the password.
  !/^https?:\/\//i.test(app.url) ? undefined : app.authUser === null ? app.url : `/api/external-apps/${encodeURIComponent(app.id)}/open`;

/** The machine a shortcut leads to, which is what tells two services apart at a glance. */
export function appHost(app: Pick<ExternalApp, "url">) {
  try {
    return new URL(app.url).host;
  } catch {
    return app.url;
  }
}

/**
 * Whether the browser will refuse to show a service inside Kago whatever the service itself allows: a page served
 * over HTTPS may not hold one that is not, unless that one is on the very machine the browser runs on.
 */
export const blockedAsMixedContent = (app: Pick<ExternalApp, "url">) => location.protocol === "https:" && /^http:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/?#]|$))/i.test(app.url);

/** Opens a shortcut in a tab of its own, which learns nothing of the one it came from. */
export function openInNewTab(app: Pick<ExternalApp, "id" | "url" | "authUser">) {
  const href = appHref(app);
  if (href) window.open(href, "_blank", "noopener,noreferrer");
}

/** Opens a shortcut the way it was set up to open: in a tab of its own, or in a window of Kago's. */
export function openExternalApp(app: ExternalApp) {
  if (app.embed) useWorkspaceStore.getState().openExternal(app);
  else openInNewTab(app);
}

export async function removeExternalApp(queryClient: QueryClient, app: ExternalApp) {
  const confirmed = await confirmAction({
    title: t("Remove {name}?", { name: app.name }),
    description: app.shared ? t("The shortcut is removed from everyone’s desktop. The service itself is not touched.") : t("Only the shortcut is removed. The service itself is not touched."),
    confirmLabel: t("Remove"),
    destructive: true
  });
  if (!confirmed) return;
  await run(async () => {
    await api(`/api/external-apps/${app.id}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["external-apps"] });
  });
}
