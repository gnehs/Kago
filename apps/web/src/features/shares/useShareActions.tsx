import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { FileTile } from "@/components/kago/file-icon";
import { useWindowScope } from "@/components/kago/window-scope";
import { displayPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { shareName, shareUrl } from "@/lib/shareModel";
import { dismissToast, toast } from "@/stores/toast";
import { confirmAction } from "@/stores/dialogs";
import type { ShareLink } from "@/types/kago";
import { copyShareLink, shareIconItem } from "./shareUtils";
import { t } from "@/lib/i18n";

/** Puts a link's address on the clipboard and says so. A link with no token has none to give. */
export async function copyShare(share: Pick<ShareLink, "token">, message = t("Link copied")) {
  if (!share.token) return;
  const copied = await copyShareLink(shareUrl(globalThis.location.origin, share.token));
  toast(copied ? message : t("The browser wouldn’t copy the link"), copied ? "info" : "error");
}

const PROGRESS_KEY = "shares:delete-all";

/** What can be done to a share, with the questions that go before the ones that cannot be taken back. */
export function useShareActions(rootName: (rootId: string) => string) {
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.shares() });
  const subject = (share: ShareLink) => ({ icon: <FileTile item={shareIconItem(share, rootName(share.root_id))} className="size-12" />, name: shareName(share, rootName(share.root_id)), detail: displayPath(rootName(share.root_id), share.path) });

  return {
    async change(share: ShareLink, body: { disabled?: boolean; expiresAt?: number | null; maxDownloads?: number | null }) {
      return (await run(async () => {
        await api(`/api/shares/${share.id}`, { method: "PATCH", body: JSON.stringify(body) });
        await refresh();
        return true;
      }, t("Couldn’t change the share"))) ?? false;
    },

    async rotate(share: ShareLink) {
      if (!(await confirmAction({ window: scope, title: t("Make a new link?"), subject: subject(share), description: t("The old link stops working right away. Anyone you sent it to needs the new one."), confirmLabel: t("Make new link"), destructive: true }))) return;
      const made = await run(async () => {
        const next = await api<ShareLink>(`/api/shares/${share.id}/rotate`, { method: "POST" });
        await refresh();
        return next;
      }, t("Couldn’t make a new link"));
      if (made) await copyShare(made, t("New link copied. The old one no longer works."));
    },

    async remove(share: ShareLink) {
      if (!(await confirmAction({ window: scope, title: t("Delete this share link?"), subject: subject(share), description: t("Links you’ve already sent stop working right away."), confirmLabel: t("Delete"), destructive: true }))) return;
      await run(async () => {
        await api(`/api/shares/${share.id}`, { method: "DELETE" });
        await refresh();
      }, t("Couldn’t delete the share"));
    },

    async removeAll(shares: ShareLink[]) {
      if (!(await confirmAction({ window: scope, title: t("Delete {count} share link? | Delete {count} share links?", { count: shares.length }), description: t("They don’t work any more. They are removed from the list for good."), confirmLabel: t("Delete all"), destructive: true }))) return;
      let done = 0;
      const say = () => toast(t("Deleting share links"), "info", { key: PROGRESS_KEY, ongoing: true, progress: { value: done, max: shares.length, detail: t("{count} of {total}", { count: done, total: shares.length }) } });
      say();
      try {
        for (const share of shares) {
          await api(`/api/shares/${share.id}`, { method: "DELETE" });
          done += 1;
          say();
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : t("Couldn’t delete the shares"), "error");
      } finally {
        dismissToast(PROGRESS_KEY);
        await refresh();
      }
    }
  };
}
