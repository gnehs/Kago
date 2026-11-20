import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useParams } from "react-router";
import { SESSION_ENDED_EVENT } from "./api/client";
import { useMe, useSetupStatus } from "./api/hooks";
import { KagoDialogHost } from "./components/kago/dialog";
import { KagoLoading } from "./components/kago/empty-state";
import { KagoToaster } from "./components/kago/toaster";
import { AvatarDialogHost } from "./features/auth/AvatarDialog";
import { Login } from "./features/auth/Login";
import { SessionEnded } from "./features/auth/SessionEnded";
import { SetupAdmin } from "./features/auth/SetupAdmin";
import { useSsoNotice } from "./features/auth/sso";
import { ArchivePasswordDialogHost } from "./features/files/ArchivePassword";
import { BatchRenameDialogHost } from "./features/files/BatchRenameDialog";
import { CompressDialogHost } from "./features/files/CompressDialog";
import { TransferConflictDialogHost } from "./features/files/TransferConflicts";
import { ConvertDialogHost } from "./features/convert/ConvertDialog";
import { TrackEditorHost } from "./features/convert/TrackEditor";
import { VideoPage } from "./features/files/VideoPage";
import { PublicSharePage } from "./features/shares/PublicSharePage";
import { Workspace } from "./features/workspace/Workspace";

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<AppGate />} />
        <Route path="/login" element={<AppGate />} />
        <Route path="/_kago/play" element={<AppGate><VideoPage /></AppGate>} />
        <Route path="/_kago/*" element={<AppGate />} />
        <Route path="/s/:token" element={<PublicShareRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <KagoDialogHost />
      <CompressDialogHost />
      <TransferConflictDialogHost />
      <ConvertDialogHost />
      <TrackEditorHost />
      <BatchRenameDialogHost />
      <ArchivePasswordDialogHost />
      <AvatarDialogHost />
      <KagoToaster />
    </>
  );
}

function PublicShareRoute() {
  const { token } = useParams();
  if (!token) return <Navigate to="/" replace />;
  // Keyed by the link, so another one starts from nothing and the last one's answer is not heard.
  return <PublicSharePage key={token} token={token} />;
}

/** Everything behind the sign-in. `children` is a page of its own in place of the desktop. */
function AppGate({ children }: { children?: ReactNode }) {
  const setup = useSetupStatus();
  const me = useMe();
  useSsoNotice(me.isLoading ? undefined : Boolean(me.data?.user));
  const queryClient = useQueryClient();
  const user = me.data?.user ?? null;
  // Whoever was signed in stays on the desktop when the session ends under them, and is asked to sign in over it.
  const [last, setLast] = useState(user);
  useEffect(() => {
    if (user) setLast(user);
  }, [user]);
  useEffect(() => {
    const ended = () => void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
  }, [queryClient]);

  if (setup.isLoading || me.isLoading) return <div className="h-full bg-canvas"><KagoLoading /></div>;
  if (setup.data?.needsSetup) return <SetupAdmin />;
  const shown = user ?? last;
  if (!shown) return <Login />;
  return (
    <>
      {children ?? <Workspace user={shown} />}
      <SessionEnded open={!user} user={shown} />
    </>
  );
}
