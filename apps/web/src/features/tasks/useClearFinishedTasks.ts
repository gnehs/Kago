import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import { t } from "@/lib/i18n";

/** Clears the finished tasks; shared by the tasks window and the top bar's popover. */
export function useClearFinishedTasks() {
  const queryClient = useQueryClient();
  return () =>
    run(async () => {
      await api("/api/tasks", { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(t("Finished tasks cleared"));
    }, t("Couldn’t clear the tasks"));
}
