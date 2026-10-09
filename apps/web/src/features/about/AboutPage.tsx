import { Blocks, CodeXml, Scale } from "lucide-react";
import { BrandMark } from "@/components/kago/brand-mark";
import { Card, Page, Row, RowList, SettingRow } from "@/components/kago/page";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Where the source of this Kago is. The licence asks whoever runs a changed Kago for others to point this at theirs. */
const SOURCE_URL = "https://github.com/gnehs/Kago";

const build = __KAGO_BUILD__;
const linkButton = buttonVariants();

/** What Kago says of itself: which build is running, and whose work it is made of. */
export function AboutPage() {
  return (
    <Page>
      {/* Kago stands here as everything on the desktop does: its icon, and its name under it. */}
      <header className="flex flex-col items-center pt-4 pb-2 text-center">
        <BrandMark className="mb-3 size-16" />
        <h1 className="m-0 text-xl leading-tight font-semibold tracking-tight">Kago</h1>
        <p className="m-0 mt-1 text-muted">{t("A desktop-style file manager for your NAS.")}</p>
      </header>
      <Card>
        <div className="flex flex-col gap-3">
          <SettingRow label={t("Version")}>
            <span className="text-muted tabular-nums">{build.version}</span>
          </SettingRow>
          {build.commit ? (
            <SettingRow label={t("Commit")}>
              <a className="font-mono text-xs text-accent underline underline-offset-2" href={`${SOURCE_URL}/commit/${build.commit}`} title={build.commit} target="_blank" rel="noreferrer">{build.commit.slice(0, 7)}</a>
            </SettingRow>
          ) : null}
          {build.date ? (
            <SettingRow label={t("Built")}>
              <span className="text-muted tabular-nums">{formatDate(Date.parse(build.date))}</span>
            </SettingRow>
          ) : null}
        </div>
      </Card>
      <Card title={t("Open source")}>
        <RowList bare>
          <Row icon={<Scale />} title={t("License")} subtitle="GNU Affero General Public License v3.0">
            <a className={linkButton} href="/licenses/LICENSE.txt" target="_blank" rel="noreferrer">{t("View")}</a>
          </Row>
          <Row icon={<CodeXml />} title={t("Source code")} subtitle={SOURCE_URL.replace("https://", "")}>
            <a className={linkButton} href={SOURCE_URL} target="_blank" rel="noreferrer">{t("Open")}</a>
          </Row>
          <Row icon={<Blocks />} title={t("Third-party software")} subtitle={t("What Kago is distributed with, and the license of each.")}>
            <a className={linkButton} href="/licenses/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noreferrer">{t("View")}</a>
          </Row>
        </RowList>
      </Card>
    </Page>
  );
}
