import { useState } from "react";
import { ExternalLink, Globe, RotateCw, ShieldAlert } from "lucide-react";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { t } from "@/lib/i18n";
import type { ExternalWindow } from "@/stores/workspace";
import { appHost, blockedAsMixedContent, openInNewTab } from "./externalApps";

/**
 * Another service of the machine, shown inside a window of Kago's. What is in the frame is the service's own page,
 * which Kago can neither read nor tell apart from a page that refused to be framed: so the way out to a tab of
 * its own is always at hand, and the window says why it may be needed.
 */
export function ExternalAppWindow({ window }: { window: ExternalWindow }) {
  const app = window.external;
  // Counted up to load the service afresh.
  const [load, setLoad] = useState(0);
  const blocked = blockedAsMixedContent(app);

  return (
    <KagoWindow
      window={window}
      // The service goes on running while its window is put away: music keeps playing, and nothing has to sign in again.
      keepMounted
      icon={<Globe className="text-muted" />}
      titleExtra={
        <>
          {blocked ? null : <KagoIconButton label={t("Reload")} className="size-6" onClick={() => setLoad((count) => count + 1)}><RotateCw /></KagoIconButton>}
          <KagoIconButton label={t("Open in new tab")} className="size-6" onClick={() => openInNewTab(app)}><ExternalLink /></KagoIconButton>
        </>
      }
    >
      <div className="relative min-h-0 flex-1 bg-white">
        {blocked ? (
          <KagoEmptyState
            className="h-full bg-surface"
            icon={<ShieldAlert />}
            title={t("The browser won’t show this here")}
            description={t("Kago is served over HTTPS and this address is not, so the browser refuses to show it inside Kago.")}
          >
            <Button variant="default" onClick={() => openInNewTab(app)}><ExternalLink />{t("Open in new tab")}</Button>
          </KagoEmptyState>
        ) : (
          <iframe
            key={`${load}:${app.updated_at}`}
            title={app.name}
            // Kago's own page, which frames the service: the interface itself may frame nothing but Kago.
            src={`/api/external-apps/${encodeURIComponent(app.id)}/frame`}
            allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture"
            className="block size-full border-0"
          />
        )}
        {/* A click inside a frame never reaches Kago. A window that is not in front is covered, so the click that lands on it brings it forward. */}
        {window.focused ? null : <div className="absolute inset-0" />}
      </div>
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-elevated px-3 text-muted">
        <span className="shrink-0 truncate">{appHost(app)}</span>
        {blocked ? null : <span className="ml-auto truncate text-xs text-faint">{t("Nothing showing, or can’t sign in? The service may not allow being shown inside another page. Open it in a new tab instead.")}</span>}
      </footer>
    </KagoWindow>
  );
}
