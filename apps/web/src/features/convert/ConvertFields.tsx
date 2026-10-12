import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConvertSpec, ConvertSupport } from "@/types/kago";
import { AUDIO_CODEC_LABELS, codecOf, DEFAULT_CRF, FORMAT_LABELS, HARDWARE_LABELS, keepsStreams, kindLabels, kindOfFormat, MAX_CRF, VIDEO_ENCODERS, videoEncoderLabel, withFormat, type MediaKind } from "./convertSpec";
import { t } from "@/lib/i18n";

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const SIDES = [3840, 2560, 1920, 1280, 800, 480];
const RATES = [60, 50, 30, 25, 24, 15, 10];
const BITRATES = [96, 128, 160, 192, 256, 320];

const numberOrNull = (value: string) => (value === "" ? null : Number(value));

/**
 * What to make of the files: the format, and for a video how tall. The rest (encoder, quality, frame rate, sound)
 * is folded away, since leaving it alone gives what plays in the most places.
 */
export function ConvertFields({ spec, formats, support, onChange }: { spec: ConvertSpec; /** The formats on offer, by what they hold. */ formats: Record<MediaKind, string[]>; support?: ConvertSupport; onChange: (spec: ConvertSpec) => void }) {
  const kind = kindOfFormat(spec.format);
  const animated = spec.format === "gif";
  const touched = spec.videoCodec !== "auto" || spec.crf !== null || spec.fps !== null || spec.audioCodec !== "auto" || spec.audioBitrate !== null || spec.quality !== null || !spec.hardware;
  const [advanced, setAdvanced] = useState(touched);
  const set = (patch: Partial<ConvertSpec>) => onChange({ ...spec, ...patch });
  const webm = spec.format === "webm";
  // Before the server has said what it makes, the GPU's encoders are not offered: it may have none.
  const videoEncoders = VIDEO_ENCODERS.filter((encoder) => (support ? support.videoCodecs.includes(encoder) : !encoder.includes("-hw")) && (!webm || ["vp9", "av1"].includes(codecOf(encoder))));
  const codec = webm && spec.videoCodec === "auto" ? "vp9" : codecOf(spec.videoCodec);
  const onGpu = spec.videoCodec.includes("-hw");
  const audioCodecs = (Object.keys(AUDIO_CODEC_LABELS) as Array<keyof typeof AUDIO_CODEC_LABELS>).filter((codec) => (!support || support.audioCodecs.includes(codec)) && (!webm || codec === "opus"));
  const copying = spec.videoCodec === "copy";
  const lossy = ["jpg", "webp", "avif"].includes(spec.format);
  const hasAdvanced = kind === "video" || animated || lossy || ["mp3", "m4a", "opus", "ogg"].includes(spec.format);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Format")} className={kind === "audio" ? "col-span-2" : undefined}>
          <Select value={spec.format} onChange={(event) => onChange(withFormat(spec, event.target.value))}>
            {(Object.keys(formats) as MediaKind[]).filter((group) => formats[group].length > 0).map((group) => (
              <optgroup key={group} label={kindLabels[group]}>
                {formats[group].map((format) => <option key={format} value={format}>{FORMAT_LABELS[format] ?? format}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        {kind === "video" ? (
          <Field label={t("Resolution")}>
            <Select value={spec.height ?? ""} disabled={copying} onChange={(event) => set({ height: numberOrNull(event.target.value) })}>
              <option value="">{t("Same as the original")}</option>
              {HEIGHTS.map((height) => <option key={height} value={height}>{height === 2160 ? "2160p (4K)" : `${height}p`}</option>)}
            </Select>
          </Field>
        ) : null}
        {kind === "image" ? (
          <Field label={t("Longest side")}>
            <Select value={spec.height ?? ""} onChange={(event) => set({ height: numberOrNull(event.target.value) })}>
              <option value="">{t("Same as the original")}</option>
              {SIDES.map((side) => <option key={side} value={side}>{`${side} px`}</option>)}
            </Select>
          </Field>
        ) : null}
      </div>
      {kind === "video" ? (
        <p className="m-0 text-xs text-faint text-pretty">
          {keepsStreams(spec)
            ? t("Picture and sound are kept as they are wherever the format can hold them, so nothing is lost and it takes moments. What it can’t hold is encoded again.")
            : copying
              ? t("The picture is moved over untouched. It fails if the format can’t hold it.")
              : t("The picture is encoded again, which takes a while and loses a little detail. A smaller original is never enlarged.")}
        </p>
      ) : null}
      {hasAdvanced ? (
        <div className="flex flex-col gap-3">
          <button type="button" aria-expanded={advanced} className="flex items-center gap-1 self-start rounded-md text-xs font-medium text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => setAdvanced(!advanced)}>
            <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
            {t("Advanced")}
          </button>
          {advanced ? (
            <div className="grid grid-cols-2 gap-3">
              {kind === "video" ? (
                <>
                  <Field label={t("Video encoder")}>
                    <Select value={spec.videoCodec} onChange={(event) => set({ videoCodec: event.target.value as ConvertSpec["videoCodec"], ...(event.target.value === "copy" ? { height: null, crf: null, fps: null } : {}) })}>
                      <option value="auto">{t("Automatic")}</option>
                      <option value="copy">{t("Keep the original (no re-encoding)")}</option>
                      {videoEncoders.map((encoder) => <option key={encoder} value={encoder}>{videoEncoderLabel(encoder, support?.hardware?.device)}</option>)}
                    </Select>
                  </Field>
                  <Field label={t("Quality (CRF)")} hint={t("Lower is better and larger.")}>
                    <Input type="number" inputMode="numeric" min={0} max={MAX_CRF[codec] ?? 51} disabled={copying} value={spec.crf ?? ""} placeholder={String(DEFAULT_CRF[codec] ?? 23)} onChange={(event) => set({ crf: numberOrNull(event.target.value) })} />
                  </Field>
                  <Field label={t("Frame rate")}>
                    <Select value={spec.fps ?? ""} disabled={copying} onChange={(event) => set({ fps: numberOrNull(event.target.value) })}>
                      <option value="">{t("Same as the original")}</option>
                      {RATES.map((rate) => <option key={rate} value={rate}>{`${rate} fps`}</option>)}
                    </Select>
                  </Field>
                  <Field label={t("Audio encoder")}>
                    <Select value={spec.audioCodec} onChange={(event) => set({ audioCodec: event.target.value as ConvertSpec["audioCodec"], ...(event.target.value === "copy" ? { audioBitrate: null } : {}) })}>
                      <option value="auto">{t("Automatic")}</option>
                      <option value="copy">{t("Keep the original (no re-encoding)")}</option>
                      {audioCodecs.map((codec) => <option key={codec} value={codec}>{AUDIO_CODEC_LABELS[codec]}</option>)}
                    </Select>
                  </Field>
                </>
              ) : null}
              {animated ? (
                <Field label={t("Frame rate")}>
                  <Select value={spec.fps ?? ""} onChange={(event) => set({ fps: numberOrNull(event.target.value) })}>
                    <option value="">15 fps</option>
                    {[30, 25, 20, 10, 5].map((rate) => <option key={rate} value={rate}>{`${rate} fps`}</option>)}
                  </Select>
                </Field>
              ) : null}
              {lossy ? (
                <Field label={t("Quality")} hint={t("From 1 to 100.")}>
                  <Input type="number" inputMode="numeric" min={1} max={100} value={spec.quality ?? ""} placeholder="85" onChange={(event) => set({ quality: numberOrNull(event.target.value) })} />
                </Field>
              ) : null}
              {kind === "video" || ["mp3", "m4a", "opus", "ogg"].includes(spec.format) ? (
                <Field label={t("Audio bitrate")}>
                  <Select value={spec.audioBitrate ?? ""} disabled={spec.audioCodec === "copy" || spec.audioCodec === "flac"} onChange={(event) => set({ audioBitrate: numberOrNull(event.target.value) })}>
                    <option value="">{t("Automatic")}</option>
                    {BITRATES.map((rate) => <option key={rate} value={rate}>{`${rate} kbps`}</option>)}
                  </Select>
                </Field>
              ) : null}
              {kind === "video" && support?.hardware ? (
                <div className="col-span-2 flex flex-col gap-1">
                  <Checkbox label={t("Use hardware acceleration ({device})", { device: HARDWARE_LABELS[support.hardware.device] ?? support.hardware.device })} checked={spec.hardware || onGpu} disabled={copying || onGpu} onChange={(event) => set({ hardware: event.target.checked })} />
                  <span className="text-xs text-faint text-pretty">
                    {t("Decodes on the GPU, and with the encoder on Automatic encodes there too. Much faster, but files come out larger for the same quality.")}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Whether what was typed into the fields is something the server takes. */
export function specIsValid(spec: ConvertSpec): boolean {
  const whole = (value: number | null, min: number, max: number) => value === null || (Number.isInteger(value) && value >= min && value <= max);
  return whole(spec.crf, 0, 63) && whole(spec.quality, 1, 100);
}
