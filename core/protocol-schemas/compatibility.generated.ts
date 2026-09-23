// Generated from client-wire.schema.json. Do not edit.
export const CLIENT_COMPATIBILITY = {
  schemaVersion: 1,
  protocolMin: 1,
  protocolMax: 1,
  catalogs: [],
} as const;
export const SUPPORTED_PROTOCOL_MIN = CLIENT_COMPATIBILITY.protocolMin;
export const SUPPORTED_PROTOCOL_MAX = CLIENT_COMPATIBILITY.protocolMax;
export const CLIENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_MAX;
export const STATE_FRAME_MAX_BYTES = 65536 as const;
export const STATE_PART_MAX_BYTES = 49152 as const;
export const STATE_ASSEMBLED_MAX_BYTES = 524288 as const;
export const STATE_REPLAY_MAX_BYTES = 1048576 as const;
export const STATE_REPLAY_MAX_EVENTS = 64 as const;
