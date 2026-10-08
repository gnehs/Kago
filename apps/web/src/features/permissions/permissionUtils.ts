import { t } from "../../lib/i18n";
import type { PermissionRule } from "../../types/kago";

export type PermissionLevel = PermissionRule["level"];

export const permissionLevels: Array<{ key: PermissionLevel; label: string; description: string }> = [
  { key: "view", label: t("Can view"), description: t("Browse, preview, download and share.") },
  { key: "edit", label: t("Can edit"), description: t("Everything in Can view, plus upload, rename, move and delete.") }
];

export const permissionLabel = (level: PermissionLevel) => permissionLevels.find((item) => item.key === level)?.label ?? level;
