import { t } from "../../lib/i18n";
export const permissionActions = [
  { key: "list", label: t("List folders") },
  { key: "read", label: t("Preview") },
  { key: "download", label: t("Download") },
  { key: "upload", label: t("Upload") },
  { key: "create_folder", label: t("Create folders") },
  { key: "rename", label: t("Rename") },
  { key: "move", label: t("Move") },
  { key: "copy", label: t("Copy") },
  { key: "delete", label: t("Delete") },
  { key: "share", label: t("Share") },
  { key: "manage_tags", label: t("Manage tags") },
  { key: "manage_permissions", label: t("Manage permissions") },
  { key: "compress", label: t("Compress") },
  { key: "extract", label: t("Extract") },
  { key: "run_rsync", label: t("Run sync") }
] as const;

export type PermissionAction = (typeof permissionActions)[number]["key"];

export const permissionPresets: Array<{ label: string; allow: PermissionAction[] }> = [
  { label: t("Read-only"), allow: ["list", "read", "download"] },
  { label: t("Can edit"), allow: ["list", "read", "download", "upload", "create_folder", "rename", "move", "copy", "delete", "compress", "extract", "manage_tags"] },
  { label: t("Full control"), allow: permissionActions.map((action) => action.key) }
];

export const permissionLabel = (key: string) => permissionActions.find((action) => action.key === key)?.label ?? key;
