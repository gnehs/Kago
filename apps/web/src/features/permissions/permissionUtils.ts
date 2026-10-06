export const permissionActions = [
  { key: "list", label: "列出資料夾" },
  { key: "read", label: "預覽" },
  { key: "download", label: "下載" },
  { key: "upload", label: "上傳" },
  { key: "create_folder", label: "建立資料夾" },
  { key: "rename", label: "重新命名" },
  { key: "move", label: "搬移" },
  { key: "copy", label: "複製" },
  { key: "delete", label: "刪除" },
  { key: "share", label: "分享" },
  { key: "manage_tags", label: "管理標籤" },
  { key: "manage_permissions", label: "管理權限" },
  { key: "compress", label: "壓縮" },
  { key: "extract", label: "解壓縮" },
  { key: "run_rsync", label: "執行 rsync" }
] as const;

export type PermissionAction = (typeof permissionActions)[number]["key"];

export const permissionPresets: Array<{ label: string; allow: PermissionAction[] }> = [
  { label: "唯讀", allow: ["list", "read", "download"] },
  { label: "可編輯", allow: ["list", "read", "download", "upload", "create_folder", "rename", "move", "copy", "delete", "compress", "extract", "manage_tags"] },
  { label: "完整控制", allow: permissionActions.map((action) => action.key) }
];

export const permissionLabel = (key: string) => permissionActions.find((action) => action.key === key)?.label ?? key;
