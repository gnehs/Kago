import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { isPictureFormat } from "../lib/subtitles.js";
import { sendFile } from "../lib/send-file.js";
import { fsQuerySchema } from "../services/fs.service.js";
import { mediaAudioSchema, mediaPanoramaSchema, mediaPrewarmSchema, mediaSessionSchema, mediaStreamSchema } from "../services/media.service.js";
import { sandboxContent } from "./respond.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor } = guards(s);

  app.get("/api/media/info", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    return s.media.info(file.input, file.stat);
  });
  app.get("/api/media/subtitles", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const sidecars = await s.fsService.subtitles(actor, query.rootSlug, query.path);
    // Something ffprobe cannot read simply has no streams of its own to offer.
    const info = await s.media.info(file.input, file.stat).catch(() => null);
    const own = new URLSearchParams({ rootSlug: query.rootSlug, path: query.path }).toString();
    const embedded = info?.subtitles ?? [];
    // A DVD index holds a stream for each language; they are listed apart, and say their own language where the name does not.
    const pictureFiles = info?.transcode
      ? (
          await Promise.all(
            sidecars.map(async ({ path: sidecarPath, name, absolutePath, stat, ...track }) => {
              if (!isPictureFormat(track.format) || !absolutePath || !stat) return [];
              const streams = await s.media.pictureStreams({ absolutePath, stat, format: track.format });
              return streams.map((stream) => ({
                ...track,
                language: track.language || stream.language,
                id: streams.length > 1 ? `file:${sidecarPath}#${stream.index}` : `file:${sidecarPath}`,
                embedded: false,
                url: "",
                file: sidecarPath,
                stream: stream.index
              }));
            })
          )
        ).flat()
      : [];
    return {
      tracks: [
        ...sidecars
          .filter((sidecar) => !isPictureFormat(sidecar.format))
          .map(({ path: sidecarPath, name, absolutePath, stat, ...track }) => ({
            ...track,
            id: `file:${sidecarPath}`,
            embedded: false,
            url: `/api/fs/preview?${new URLSearchParams({ rootSlug: query.rootSlug, path: sidecarPath }).toString()}`
          })),
        ...embedded
          .filter((stream) => stream.text)
          .map(({ index, codec, text, picture, ...track }) => ({
            ...track,
            format: codec === "ass" || codec === "ssa" ? "ass" : "srt",
            id: `stream:${index}`,
            embedded: true,
            url: `/api/media/subtitle?${own}&index=${index}`
          })),
        // Picture subtitles (Blu-ray, DVD) come after the text ones: showing one means transcoding, as it is drawn into the frames.
        ...pictureFiles,
        ...embedded
          .filter((stream) => stream.picture && info?.transcode)
          .map(({ index, codec, text, picture, ...track }) => ({
            ...track,
            format: PICTURE_FORMATS[codec] ?? "picture",
            id: `stream:${index}`,
            embedded: true,
            url: "",
            stream: index
          }))
      ],
      fonts: (info?.fonts ?? []).map((font) => `/api/media/attachment?${own}&index=${font.index}`),
      /** Subtitles in a form that can be neither handed to the browser nor drawn into the picture. */
      unsupported: embedded.filter((stream) => !stream.text && !(stream.picture && info?.transcode)).length
    };
  });
  app.get("/api/media/subtitle", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const subtitle = await s.media.subtitle(file.input, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, subtitle.file, await fs.promises.stat(subtitle.file), "text/plain; charset=utf-8");
  });
  app.get("/api/media/attachment", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const font = await s.media.font(file.input, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, font, await fs.promises.stat(font), "application/octet-stream");
  });
  app.get("/api/media/cover", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const cover = await s.media.cover(file.input, file.stat);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, cover, await fs.promises.stat(cover), cover.endsWith(".avif") ? "image/avif" : "image/jpeg");
  });
  app.get("/api/media/storyboard", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    return s.media.storyboard(file.input, file.stat);
  });
  app.get("/api/media/storyboard/sheet", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const sheet = await s.media.storyboardSheet(file.input, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=86400");
    sandboxContent(reply);
    return sendFile(request, reply, sheet, await fs.promises.stat(sheet), "image/jpeg");
  });
  app.get("/api/media/audio", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaAudioSchema.parse(request.query);
    const file = await s.fsService.media(actor, query.rootSlug, query.path);
    const audio = await s.media.audioStream(actor.id, file.input, file.stat, query.start);
    // A player that seeks or closes drops the connection, and the encoder with it.
    reply.raw.on("close", audio.stop);
    // One that left while the file was still being looked at will never be heard from again.
    if (request.raw.socket.destroyed || reply.raw.destroyed) audio.stop();
    reply.header("Content-Type", "audio/webm");
    sandboxContent(reply);
    reply.header("Cache-Control", "no-store");
    return reply.send(audio.stream);
  });
  app.post("/api/media/sessions", async (request) => {
    const actor = requireActor(request);
    const input = mediaSessionSchema.parse(request.body);
    const file = await s.fsService.media(actor, input.rootSlug, input.path);
    // A subtitle file is taken only from among the ones found for this video, never as a path of the caller's choosing.
    const sidecar = input.subtitlePath === null ? null : (await s.fsService.subtitles(actor, input.rootSlug, input.path)).find((item) => item.path === input.subtitlePath);
    const subtitleFile = sidecar && isPictureFormat(sidecar.format) && sidecar.absolutePath && sidecar.stat ? { absolutePath: sidecar.absolutePath, stat: sidecar.stat, format: sidecar.format } : null;
    if (input.subtitlePath !== null && !subtitleFile) throw new AppError(400, "Unsupported subtitle", "INVALID_INPUT");
    const session = await s.media.createSession(actor.id, file.input, file.stat, { ...input, subtitleFile });
    return { id: session.id, hdr: session.hdr, playlistUrl: `/api/media/sessions/${session.id}/index.m3u8` };
  });
  app.post("/api/media/panoramas", async (request) => {
    const actor = requireActor(request);
    const input = mediaPanoramaSchema.parse(request.body);
    // The other half of a recording lies beside the opened file; each is read only by someone who may view it.
    if (input.companionPath !== null && path.posix.dirname(input.companionPath) !== path.posix.dirname(input.path)) throw new AppError(400, "The other file must be in the same folder", "INVALID_INPUT");
    const files = await Promise.all(
      [input.path, ...(input.companionPath === null ? [] : [input.companionPath])].map(async (logicalPath) => {
        const file = await s.fsService.media(actor, input.rootSlug, logicalPath);
        return { name: file.name, absolutePath: file.input, stat: file.stat };
      })
    );
    return s.media.createPanorama(actor.id, files);
  });
  app.post("/api/media/sessions/:id/prewarm", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = mediaPrewarmSchema.parse(request.body);
    return s.media.prewarm(actor.id, params.id, input);
  });
  app.get("/api/media/sessions/:id/:file", async (request, reply) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1), file: z.string().regex(/^(index\.m3u8|init\.mp4|\d{1,9}\.(ts|m4s))$/) }).parse(request.params);
    reply.header("Cache-Control", "no-store");
    if (params.file === "index.m3u8") {
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return s.media.playlist(actor.id, params.id);
    }
    const segment = params.file === "init.mp4" ? await s.media.initSegment(actor.id, params.id) : await s.media.segment(actor.id, params.id, Number.parseInt(params.file, 10));
    reply.header("Content-Type", params.file.endsWith(".ts") ? "video/mp2t" : "video/mp4");
    const stat = await fs.promises.stat(segment);
    reply.header("Content-Length", String(stat.size));
    return reply.send(fs.createReadStream(segment));
  });
  app.delete("/api/media/sessions/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    s.media.close(actor.id, params.id);
    return { ok: true };
  });
}

/** What the player calls each kind of picture subtitle. */
const PICTURE_FORMATS: Record<string, string> = { hdmv_pgs_subtitle: "pgs", dvd_subtitle: "vobsub", dvb_subtitle: "dvb" };
