import { t } from "@/lib/i18n";

/**
 * Stable diagnostic codes are translated here; process errors and private paths never reach the page.
 * Only what went wrong is put into words: a test that passed is a checkmark and needs no sentence.
 */
const details: Record<string, string> = {
  "compatibility.nvidiaDeviceEnumerationUnavailable": t("Couldn’t list the NVIDIA GPUs, so they weren’t tested one by one."),
  "compatibility.vaapiDeviceEnumerationUnavailable": t("Couldn’t list the VA-API devices, so only the ones set by hand were tested."),
  "compatibility.capabilityProbeFailed": t("Couldn’t ask FFmpeg what it supports."),
  "compatibility.ffmpegMissing": t("FFmpeg didn’t start."),
  "compatibility.encoderUnavailable": t("This FFmpeg was built without the encoder."),
  "compatibility.decoderUnavailable": t("This FFmpeg was built without the decoder."),
  "compatibility.hardwareUnavailable": t("The GPU or its driver didn’t start."),
  "compatibility.hardwareBackendUnavailable": t("The server doesn’t have this kind of acceleration."),
  "compatibility.hardwareCodecUnsupported": t("The GPU doesn’t handle this format."),
  "compatibility.hardwareTestFailed": t("The GPU failed the test."),
  "compatibility.fixtureUnavailable": t("No test clip could be made, so decoding wasn’t tested."),
  "compatibility.encodeFailed": t("FFmpeg couldn’t encode the test clip."),
  "compatibility.decodeFailed": t("FFmpeg couldn’t decode the test clip."),
  "compatibility.outputInvalid": t("What came out wasn’t playable video.")
};

export const compatibilityDetail = (code: string): string | undefined => details[code];
