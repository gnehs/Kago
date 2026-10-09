import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Actor } from "@/types/kago";

/**
 * A square cut out of a picture, in parts of the picture: `x` and `y` are its corner as parts of the width and
 * height, `size` its side as a part of the shorter of the two.
 */
export type AvatarCrop = { x: number; y: number; size: number };

/**
 * Makes a picture the profile picture of whoever is signed in, or with nothing goes back to the letter of their name.
 * As with the desktop background, the server keeps a copy of its own and the answer is what puts it on screen. Only
 * a square of the picture is kept: the one named, or without one the middle.
 */
export async function setAvatar(queryClient: QueryClient, picture: { rootSlug: string; path: string; crop?: AvatarCrop } | null) {
  const answer = await api<{ user: Actor }>("/api/avatar", picture ? { method: "POST", body: JSON.stringify(picture) } : { method: "DELETE" });
  queryClient.setQueryData(["auth", "me"], answer);
}
