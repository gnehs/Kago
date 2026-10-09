import type { PictureJob, SharpRequest, SharpResponse } from "./sharp.js";

type Sharp = (typeof import("sharp"))["default"];

/** The least effort that still comes out smaller than the encoders ffmpeg has, in about the time they took. */
const EFFORT = 2;
const TIMEOUT_SECONDS = 30;

let loading: Promise<Sharp> | undefined;

/** sharp is only loaded once a picture needs writing. */
function loadSharp(): Promise<Sharp> {
  return (loading ??= import("sharp").then(({ default: sharp }) => {
    // It would remember a file by its name, and answer for one changed since with what it was before.
    sharp.cache(false);
    return sharp;
  }));
}

async function write(sharp: Sharp, job: PictureJob): Promise<void> {
  let picture = sharp(job.input);
  // Turned the way the camera was held, which ffmpeg does by itself for what it reads.
  if (job.edge) picture = picture.rotate().resize(job.edge, job.edge, { fit: "inside", withoutEnlargement: true });
  if (job.opaque) picture = picture.flatten({ background: "#ffffff" });
  await picture.timeout({ seconds: TIMEOUT_SECONDS }).avif({ quality: job.quality, effort: EFFORT }).toFile(job.target);
}

process.on("message", async (request: SharpRequest) => {
  let response: SharpResponse;
  try {
    const sharp = await loadSharp();
    if (request.job) await write(sharp, request.job);
    response = { id: request.id, ok: true };
  } catch (error) {
    response = { id: request.id, ok: false, message: (error as Error).message };
  }
  process.send?.(response);
});

// The server is gone, whether it stopped or was killed.
process.on("disconnect", () => process.exit(0));
