import { errorMessage } from "./format";
import { toast } from "../stores/toast";

/** Runs a user-triggered action and surfaces any failure as a toast instead of an unhandled rejection. */
export async function run<T>(action: () => Promise<T>, fallback?: string): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    toast(errorMessage(error, fallback), "error");
    return undefined;
  }
}
