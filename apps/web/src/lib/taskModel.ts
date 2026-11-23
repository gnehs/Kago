import type { FileRef, FileTask as WireFileTask } from "@kago/contract";
import type { FileTask } from "../types/kago";

function readJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRef(value: unknown): FileRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { rootSlug, path } = value as Record<string, unknown>;
  return typeof rootSlug === "string" && rootSlug && typeof path === "string" && path ? { rootSlug, path } : null;
}

/**
 * Reads a task row's JSON columns into typed fields. A column that cannot be read comes out empty rather than
 * throwing: one bad row must not take the task list, or the socket handler, down with it.
 */
export function parseTask(row: WireFileTask): FileTask {
  const { sources_json, destination, auth_snapshot_json, ...rest } = row;
  const sources = readJson(sources_json);
  return {
    ...rest,
    sources: Array.isArray(sources) ? sources.flatMap((source) => asRef(source) ?? []) : [],
    destination: asRef(readJson(destination))
  };
}
