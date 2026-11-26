import type { ConvertSkipReason, RunFailureCode } from "@kago/contract";
import { t } from "./i18n";

/*
 * What a failure code says to a person. Each code has what went wrong and, where there is something to do about it,
 * what; one `Record` over the contract's codes, so that a code the server learns is a type error here until it has
 * its words.
 */

export const failureText: Record<RunFailureCode, { reason: string; advice: string | null }> = {
  unreadable: { reason: t("This file is damaged or isn’t a media file"), advice: t("Replace it with a good copy, or take it out of the input folder.") },
  unsupported: { reason: t("This codec or format can’t be converted here"), advice: t("Choose another format in the job’s settings, or leave this file out.") },
  no_space: { reason: t("There’s no room left at the destination"), advice: t("Free some space and run it again.") },
  permission: { reason: t("Kago isn’t allowed to do this there"), advice: t("Check that the folders aren’t read-only and that Kago’s account, or the login of a remote location, may use them.") },
  exists: { reason: t("Something is already in the way at the destination"), advice: t("Remove or rename it, then run it again.") },
  not_found: { reason: t("A folder or file this job uses is gone"), advice: t("Check that it still exists, or change the job’s settings.") },
  unreachable: { reason: t("The remote location didn’t answer"), advice: t("Check that it’s online and that its settings still work, then run it again.") },
  misconfigured: { reason: t("This job’s settings don’t work"), advice: t("Open its settings and check the folders and options.") },
  changed: { reason: t("The file changed while it was being converted"), advice: t("The original was left alone. Run the job again once the file has stopped changing.") },
  busy: { reason: t("Another task was writing this file"), advice: t("Run the job again when that task is done.") },
  timeout: { reason: t("Reading this file took too long"), advice: t("The disk or remote location may be slow, or the file damaged. Run it again.") },
  encoder_missing: { reason: t("The server can’t make this format"), advice: t("Choose another format in the job’s settings, or ask whoever runs the server to check ffmpeg.") },
  unknown: { reason: t("It failed for a reason Kago couldn’t tell"), advice: null }
};

/** A run from before the server wrote reasons down has none, and says only that. */
export const unrecordedText = { reason: t("The reason wasn’t recorded"), advice: null };

export const skipText: Record<ConvertSkipReason, string> = {
  too_new: t("Changed in the last 20 seconds: left for the next run"),
  busy: t("Being written by another task: left for the next run"),
  failed_earlier: t("Failed before and unchanged since: Run now tries them again")
};

export const skipUnknownText = t("Passed over");

/** What went wrong and what to do, for a code the server sent, or for a run that came without one. */
export const failureTextOf = (code: RunFailureCode | null) => (code === null ? unrecordedText : failureText[code]);

/** How a job's last run ended, for its row, when it did not end well: with the reason where the task said one. */
export const troubleText = (trouble: "failed" | "interrupted", reason: string | null) =>
  trouble === "interrupted" ? t("The last run was interrupted") : reason ? t("The last run failed: {reason}", { reason }) : t("The last run failed");
