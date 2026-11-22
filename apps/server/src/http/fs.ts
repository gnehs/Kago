import fs from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { sendFile } from "../lib/send-file.js";
import { zipStream } from "../lib/zip-stream.js";
import { fileTagsSchema, fsQuerySchema, mkdirSchema, renameManySchema, renameSchema, searchQuerySchema, sqliteRowsSchema, thumbnailQuerySchema, uploadConflictSchema, writeTextSchema, zipQuerySchema } from "../services/fs.service.js";
import { abortOnClose, contentDisposition, isPlayable, sandboxContent, sendNdjson, sendUserFile } from "./respond.js";
import { signedIn } from "./guards.js";

export const register = signedIn((app, s) => {
  app.get("/api/fs/list", async (request, reply) => {
    const { actor } = request;
    const query = fsQuerySchema.parse(request.query);
    if (!request.headers.accept?.includes("application/x-ndjson")) return s.fsService.list(actor, query.rootSlug, query.path);
    // Asked for line by line, a folder is sent as it is read: what it is, then its entries a few at a time, then that it is whole.
    const gone = abortOnClose(reply);
    const { batches, ...folder } = await s.fsService.listStream(actor, query.rootSlug, query.path, gone.signal);
    return sendNdjson(reply, gone.signal, folder, batches, () => ({ done: true }));
  });
  // A search is always sent line by line: what was searched, the matches a folder at a time, then whether it went through everything.
  app.get("/api/fs/search", async (request, reply) => {
    const query = searchQuerySchema.parse(request.query);
    const gone = abortOnClose(reply);
    const { batches, state, ...folder } = await s.fsService.search(request.actor, query.rootSlug, query.path, query.q, gone.signal);
    return sendNdjson(reply, gone.signal, folder, batches, () => ({ done: true, truncated: state.truncated }));
  });
  app.get("/api/fs/meta", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    return s.fsService.meta(request.actor, query.rootSlug, query.path);
  });
  app.get("/api/fs/size", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    // A large folder takes a while to read through; whoever looks elsewhere meanwhile drops the connection, and the count with it.
    const gone = abortOnClose(reply);
    try {
      return await s.fsService.size(request.actor, query.rootSlug, query.path, gone.signal);
    } catch (error) {
      // Nobody is left to tell, and giving up is not a failure to record.
      if (gone.signal.aborted) return reply.status(204).send();
      throw error;
    }
  });
  app.get("/api/fs/download", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.download(request.actor, query.rootSlug, query.path);
    return sendUserFile(request, reply, file.source, file.contentType, file.name, true);
  });
  // Folders and selections as one archive, at an address that can be handed to the browser before anything is prepared.
  app.get("/api/fs/download-zip", async (request, reply) => {
    const query = zipQuerySchema.parse(request.query);
    const archive = await s.fsService.downloadZip(request.actor, query.rootSlug, query.path);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", archive.fileName));
    reply.header("X-Accel-Buffering", "no");
    return reply.send(Readable.from(zipStream(archive.entries)));
  });
  app.get("/api/fs/preview", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.preview(request.actor, query.rootSlug, query.path);
    if (isPlayable(file.contentType)) reply.raw.once("close", s.media.directPlay());
    return sendUserFile(request, reply, file.source, file.contentType, file.name);
  });
  app.put("/api/fs/content", async (request) => s.fsService.writeText(request.actor, writeTextSchema.parse(request.body)));
  app.get("/api/fs/sqlite", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    return s.fsService.sqliteOverview(request.actor, query.rootSlug, query.path);
  });
  app.get("/api/fs/archive", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    return s.fsService.archiveEntries(request.actor, query.rootSlug, query.path);
  });
  app.get("/api/fs/sqlite/rows", async (request) => s.fsService.sqliteRows(request.actor, sqliteRowsSchema.parse(request.query)));
  app.get("/api/fs/image", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.localFile(request.actor, query.rootSlug, query.path);
    const rendition = await s.images.rendition(file.localPath, file.stat);
    reply.header("Cache-Control", "private, max-age=86400");
    sandboxContent(reply);
    return sendFile(request, reply, rendition, await fs.promises.stat(rendition), "image/jpeg");
  });
  app.get("/api/fs/exif", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await s.fsService.localFile(request.actor, query.rootSlug, query.path);
    return s.images.metadata(file.localPath);
  });
  app.get("/api/fs/thumbnail", async (request, reply) => {
    const query = thumbnailQuerySchema.parse(request.query);
    const thumbnail = await s.fsService.thumbnail(request.actor, query.rootSlug, query.path, query.size === "medium");
    reply.header("Content-Type", thumbnail.contentType);
    reply.header("Cache-Control", "private, max-age=86400");
    // A picture ffmpeg could not draw is sent as the file itself, and that file may be an SVG.
    sandboxContent(reply);
    if ("data" in thumbnail) return thumbnail.data;
    reply.header("Content-Length", String(thumbnail.size));
    return fs.createReadStream(thumbnail.path);
  });

  app.post("/api/fs/mkdir", async (request) => {
    const input = mkdirSchema.parse(request.body);
    return s.fsService.mkdir(request.actor, input.rootSlug, input.path, input.name, input.conflict);
  });
  app.post("/api/fs/rename", async (request) => {
    const input = renameSchema.parse(request.body);
    return s.fsService.rename(request.actor, input.rootSlug, input.path, input.name);
  });
  app.post("/api/fs/rename-many", async (request) => {
    const input = renameManySchema.parse(request.body);
    return s.fsService.renameMany(request.actor, input.rootSlug, input.items);
  });
  app.put("/api/fs/tags", async (request) => s.fsService.setFileTags(request.actor, fileTagsSchema.parse(request.body)));
  app.post("/api/fs/upload", async (request) => {
    // Files are streamed straight to their destination, so an upload is bounded by free disk space rather than by a temp copy.
    const fields: Record<string, unknown> = {};
    const uploaded = [];
    for await (const part of request.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = part.value;
        continue;
      }
      // The destination fields are sent ahead of the files.
      const input = uploadRequestSchema.parse(fields);
      uploaded.push(await s.fsService.upload(request.actor, input.rootSlug, input.path, part.filename, part.file, input.conflicts?.[part.filename.normalize("NFC")]));
    }
    if (uploaded.length === 0) throw new AppError(400, "At least one file is required", "UPLOAD_FILE_REQUIRED");
    // A file left out where one of its name was already has nothing to say of itself.
    return { items: uploaded.filter((item) => item !== null) };
  });
});


const uploadRequestSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  /** What to do with each file whose name the folder already has, by its name in NFC. A form field is text, so it comes as JSON. */
  conflicts: z
    .string()
    .transform((value, context) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        context.addIssue({ code: "custom", message: "Invalid JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), uploadConflictSchema))
    .optional()
});
