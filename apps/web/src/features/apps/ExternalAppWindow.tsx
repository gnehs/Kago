import { useState } from "react";
import { ExternalLink, RotateCw, ShieldAlert } from "lucide-react";
import { useFrameProbe } from "@/api/hooks";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/components/kago/window";
import { t } from "@/lib/i18n";
import type { ExternalWindow } from "@/stores/workspace";
import { ExternalAppGlyph } from "@/components/kago/external-app-icon";
import { blockedAsMixedContent, openInNewTab } from "./externalApps";

/**
 * Another service of the machine, shown inside a window of Kago's. What is in the frame is the service's own page,
 * which Kago cannot read, and a service that refuses to be framed leaves it blank without a word. So the server
 * asks the service beforehand, and a refusal is said here in its place; the way out to a tab is always at hand.
 */
export function ExternalAppWindow({ window }: { window: ExternalWindow }) {
  const app = window.external;
  // Counted up to load the service afresh.
  const [load, setLoad] = useState(0);
  // The server asks from where it stands, and may have been told otherwise than the browser will be.
  const [insisted, setInsisted] = useState(false);
  const mixed = blockedAsMixedContent(app);
  const refused = useFrameProbe(app.url, !mixed).data?.verdict === "blocked" && !insisted;
  const tabButton = <Button variant="default" onClick={() => openInNewTab(app)}><ExternalLink />{t("Open in new tab")}</Button>;

  return (
    <KagoWindow
      window={window}
      // The service goes on running while its window is put away: music keeps playing, and nothing has to sign in again.
      keepMounted
      icon={<ExternalAppGlyph icon={app.icon} className="text-muted" />}
      titleExtra={
        <>
          {mixed || refused ? null : <KagoIconButton label={t("Reload")} className="size-6" onClick={() => setLoad((count) => count + 1)}><RotateCw /></KagoIconButton>}
          <KagoIconButton label={t("Open in new tab")} className="size-6" onClick={() => openInNewTab(app)}><ExternalLink /></KagoIconButton>
        </>
      }
    >
      <div className="relative min-h-0 flex-1 bg-white">
        {mixed ? (
          <KagoEmptyState
            className="h-full bg-surface"
            icon={<ShieldAlert />}
            title={t("The browser won’t show this here")}
            description={t("Kago is served over HTTPS and this address is not, so the browser refuses to show it inside Kago.")}
          >
            {tabButton}
          </KagoEmptyState>
        ) : refused ? (
          <KagoEmptyState
            className="h-full bg-surface"
            icon={<ShieldAlert />}
            title={t("This service refuses to be shown here")}
            description={t("It is set up not to be shown inside another page (X-Frame-Options or frame-ancestors). Open it in a new tab, or change the service’s own settings.")}
          >
            {tabButton}
            <Button onClick={() => setInsisted(true)}>{t("Try anyway")}</Button>
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
        {window.focused || mixed || refused ? null : <div className="absolute inset-0" />}
      </div>
    </KagoWindow>
  );
}
