/**
 * ffmpeg tells what a file is by its contents, not its name, and some of what it reads are not media but lists of
 * other things to read: a playlist or a concat script saved as `song.ape` or `photo.jpg` would have it open files,
 * or addresses, that whoever put it there was never allowed to see. So every file of someone's is handed to it
 * with the formats it may be read as and the ways it may be reached spelt out.
 *
 * A format name of several parts (`mov,mp4,m4a…`) is matched by any one of them.
 */

/** Containers that hold their own sound and picture. */
export const MEDIA_FORMATS = [
  "aac", "ac3", "aiff", "amr", "ape", "asf", "au", "av1", "avi", "caf", "dsf", "dts", "dtshd", "dv", "eac3", "flac", "flv", "gxf", "h264", "hevc",
  "iff", "ivf", "live_flv", "m4v", "matroska", "mlp", "mov", "mp3", "mpc", "mpc8", "mpeg", "mpegts", "mpegvideo", "mxf", "nsv", "nut", "obu", "ogg", "oma",
  "rm", "shn", "swf", "tak", "truehd", "tta", "vc1", "voc", "w64", "wav", "wtv", "wv", "xwma"
];

/**
 * Still pictures. `mov` is among them because that is what HEIF and AVIF are kept in. SVG is not: it is a document
 * that can name other files to draw, not a picture.
 */
export const PICTURE_FORMATS = [
  "image2", "apng", "gif", "ico", "jpegxl_anim", "mov",
  ...["bmp", "dds", "dpx", "exr", "gif", "hdr", "j2k", "jpeg", "jpegls", "jpegxl", "pam", "pbm", "pcx", "pfm", "pgm", "pgmyuv", "phm", "png", "ppm", "psd", "qoi", "sgi", "sunrast", "tiff", "webp", "xbm", "xpm", "xwd"].map(
    (name) => `${name}_pipe`
  )
];

/** How ffmpeg may reach a file: off the disk, or for a remote location from this server's own address for it. Nothing in the file can add to that. */
export const inputProtocols = (input: string) => (/^http:\/\/127\.0\.0\.1:/.test(input) ? "http,tcp" : "file");

/** A file of someone's as ffmpeg is given it, held to the given formats and to the protocols above. */
export const guardedInput = (input: string, formats = MEDIA_FORMATS) => ["-protocol_whitelist", inputProtocols(input), "-format_whitelist", formats.join(","), "-i", input];

/** The same for ffprobe, which takes the file without `-i`. */
export const guardedProbe = (input: string, formats = MEDIA_FORMATS) => ["-protocol_whitelist", inputProtocols(input), "-format_whitelist", formats.join(","), input];
