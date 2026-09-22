/**
 * The initial opening already read session Memory while assembling the prompt.
 * A wake, a handover, or any later open reads it again.
 */
export function voiceOpeningRereadsSessionMemoryV1(options: {
  handle?: string;
  handover?: boolean;
}): boolean {
  return Boolean(options.handle || options.handover);
}
