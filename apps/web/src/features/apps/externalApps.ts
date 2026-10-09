import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import type { ExternalApp } from "@/types/kago";

/**
 * Where a shortcut leads, when that is somewhere a link may lead. The server keeps only web addresses; the
 * interface still checks before it makes a link of one, as an address of another kind would run as script.
 */
export const appHref = (app: Pick<ExternalApp, "url">) => (/^https?:\/\//i.test(app.url) ? app.url : undefined);

/** The machine a shortcut leads to, which is what tells two services apart at a glance. */
export function appHost(app: Pick<ExternalApp, "url">) {
  try {
    return new URL(app.url).host;
  } catch {
    return app.url;
  }
}

/** Opens a shortcut the way they all open: in a tab of its own, which learns nothing of the one it came from. */
export function openExternalApp(app: ExternalApp) {
  const href = appHref(app);
  if (href) window.open(href, "_blank", "noopener,noreferrer");
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
