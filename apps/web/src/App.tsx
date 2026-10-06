import { Navigate, Route, Routes, useParams } from "react-router";
import { useMe, useSetupStatus } from "./api/hooks";
import { KagoDialogHost } from "./components/kago/dialog";
import { KagoLoading } from "./components/kago/empty-state";
import { KagoToaster } from "./components/kago/toaster";
import { Login } from "./features/auth/Login";
import { SetupAdmin } from "./features/auth/SetupAdmin";
import { PublicSharePage } from "./features/shares/PublicSharePage";
import { Workspace } from "./features/workspace/Workspace";

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<AppGate />} />
        <Route path="/login" element={<AppGate />} />
        <Route path="/_kago/*" element={<AppGate />} />
        <Route path="/s/:token" element={<PublicShareRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <KagoDialogHost />
      <KagoToaster />
    </>
  );
}

function PublicShareRoute() {
  const { token } = useParams();
  if (!token) return <Navigate to="/" replace />;
  return <PublicSharePage token={token} />;
}

function AppGate() {
  const setup = useSetupStatus();
  const me = useMe();

  if (setup.isLoading || me.isLoading) return <div className="h-full bg-canvas"><KagoLoading /></div>;
  if (setup.data?.needsSetup) return <SetupAdmin />;
  if (!me.data?.user) return <Login />;
  return <Workspace user={me.data.user} />;
}
