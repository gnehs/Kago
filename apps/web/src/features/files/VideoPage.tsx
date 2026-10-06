import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router";
import { baseName } from "@/lib/paths";
import { VideoPreview } from "./VideoPreview";

export const videoPageUrl = (rootSlug: string, path: string) => `/_kago/play?${new URLSearchParams({ rootSlug, path }).toString()}`;

/** A video in a browser tab of its own: the same player as the preview window, filling the page. */
export function VideoPage() {
  const [params, setParams] = useSearchParams();
  const rootSlug = params.get("rootSlug");
  const path = params.get("path");

  useEffect(() => {
    if (!path) return;
    const previous = document.title;
    document.title = baseName(path);
    return () => {
      document.title = previous;
    };
  }, [path]);

  if (!rootSlug || !path) return <Navigate to="/" replace />;
  return (
    <div className="flex h-full flex-col bg-black">
      <VideoPreview rootSlug={rootSlug} path={path} onNavigate={(item) => setParams({ rootSlug, path: item.path })} />
    </div>
  );
}
