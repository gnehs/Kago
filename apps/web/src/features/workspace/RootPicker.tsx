import { useNavigate } from "react-router";
import { ChevronRight, HardDrive } from "lucide-react";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Root } from "@/types/kago";
import { pagePaths } from "./routes";

/** Shown on an empty workspace. Kago never opens a root on the user's behalf. */
export function RootPicker({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const navigate = useNavigate();

  if (roots.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <KagoEmptyState
          icon={<HardDrive />}
          title="還沒有可以開啟的位置"
          description={isAdmin ? "先在設定中把 /data 底下的資料夾新增為 Root。" : "請管理員授予你存取權限。"}
        >
          {isAdmin ? <Button variant="default" onClick={() => navigate(pagePaths.settings)}>前往設定</Button> : null}
        </KagoEmptyState>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <section className="w-full max-w-sm rounded-lg bg-surface p-2 shadow-window">
        <h2 className="m-0 px-2 pt-2 pb-1 text-sm font-semibold">選擇要開啟的位置</h2>
        <p className="m-0 px-2 pb-2 text-muted">每個位置會開成一個獨立的檔案視窗。</p>
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {roots.map((root) => (
            <li key={root.id}>
              <button
                className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50"
                onClick={() => useWorkspaceStore.getState().openRoot(root)}
              >
                <HardDrive className="text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium">{root.name}</span>
                {root.readonly ? <KagoBadge>唯讀</KagoBadge> : null}
                <ChevronRight className="text-faint" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
