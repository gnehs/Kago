import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus } from "lucide-react";
import { useExternalApps } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page, Row, RowList } from "@/features/workspace/Page";
import { t } from "@/lib/i18n";
import { editExternalApp } from "./ExternalAppDialog";
import { ExternalAppIcon } from "./ExternalAppIcon";
import { removeExternalApp } from "./externalApps";

/** The shortcuts on one's desktop to other services: one's own, and the ones an administrator put on everyone's. */
export function AppsPage() {
  const queryClient = useQueryClient();
  const apps = useExternalApps();
  const addButton = <Button variant="default" onClick={() => editExternalApp("new")}><Plus />{t("Add app")}</Button>;

  return (
    <Page
      title={t("Apps")}
      description={t("Shortcuts on the desktop to the other services you run, such as Jellyfin or Home Assistant. Each opens in a new tab, or in a window inside Kago.")}
      actions={apps.data?.length ? addButton : null}
    >
      {apps.isLoading ? <KagoLoading /> : null}
      {apps.isError ? <p className="m-0 text-danger">{t("Couldn’t load the apps")}</p> : null}
      {apps.data?.length === 0 ? (
        <KagoEmptyState icon={<LayoutGrid />} title={t("No apps yet")} description={t("Add the address of a service and it gets an icon on the desktop.")}>
          {addButton}
        </KagoEmptyState>
      ) : null}
      {apps.data?.length ? (
        <RowList>
          {apps.data.map((app) => (
            <Row key={app.id} icon={<ExternalAppIcon name={app.name} icon={app.icon} className="size-8" />} title={app.name} subtitle={app.url}>
              {app.shared ? <KagoBadge>{t("Everyone")}</KagoBadge> : null}
              {app.editable ? (
                <>
                  <Button onClick={() => editExternalApp(app)}>{t("Edit")}</Button>
                  <Button variant="destructive" onClick={() => void removeExternalApp(queryClient, app)}>{t("Remove")}</Button>
                </>
              ) : null}
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
