// What the fake transcription service always says, shared by the Worker that
// says it and the spec that asserts on it.
//
// Its own module because the two sides run in different runtimes: the fake
// lives in a workerd Worker and imports `cloudflare:workers`, and the spec
// runs in Node under Playwright. Nothing here imports anything, so both can
// have it.

/**
 * The sentence a dictated message settles on.
 *
 * Deterministic rather than derived from the audio: the browser sends
 * Chromium's generated tone under `--use-fake-device-for-media-stream`, and no
 * transcriber would make words of that. What is under test is the transport
 * and the composer, not a transcriber.
 */
export const E2E_DICTATED_TEXT_V1 = "Testing dictation from a fake microphone.";

/** Audio frames per streamed word: roughly a tenth of a second at 24 kHz. */
export const E2E_DICTATION_FRAMES_PER_WORD_V1 = 3;

/** What production returned when a beta Realtime handshake reached GA. */
export const E2E_REALTIME_BETA_REMOVED_ERROR_V1 =
  "The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API.";
