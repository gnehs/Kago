import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Actor } from "@/types/kago";

/**
 * Makes a picture the profile picture of whoever is signed in, or with nothing goes back to the letter of their name.
 * As with the desktop background, the server keeps a copy of its own and the answer is what puts it on screen.
 */
export async function setAvatar(queryClient: QueryClient, picture: { rootSlug: string; path: string } | null) {
  const answer = await api<{ user: Actor }>("/api/avatar", picture ? { method: "POST", body: JSON.stringify(picture) } : { method: "DELETE" });
  queryClient.setQueryData(["auth", "me"], answer);
}
