import type { UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

export type Role = UserAccount["role"];
export const roleLabels: Record<Role, string> = { ADMIN: t("Administrator"), USER: t("Standard user") };
