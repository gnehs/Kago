export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.method && init.method !== "GET" ? { "x-kago-csrf": "1" } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? "Request failed");
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const downloadUrl = (rootSlug: string, path: string) =>
  `/api/fs/download?${new URLSearchParams({ rootSlug, path }).toString()}`;
