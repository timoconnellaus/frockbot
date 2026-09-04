/**
 * The shared icon set. Glyphs are 24-unit stroke paths so every icon shares
 * the same optical weight and sits centred inside a control; plugins must not
 * fall back to Unicode symbols, whose ink offsets differ per font.
 */
export type UiIconName =
  | "applets"
  | "arrow-down"
  | "arrow-up"
  | "check"
  | "chevron-left"
  | "chevrons-left"
  | "chevrons-right"
  | "close"
  | "gear"
  | "history"
  | "link"
  | "menu"
  | "mic"
  | "plugins"
  | "plus"
  | "refresh"
  | "search"
  | "sparkle"
  | "stop"
  | "trash"
  | "user"
  | "waveform";

export const uiIconPaths: Record<UiIconName, string[]> = {
  // An Applet: a window with its own title bar, standing on the shell.
  applets: [
    "M4 5h16v14H4z",
    "M4 9h16",
    "M7 7h.01",
    "M9.5 7h.01",
    "M8 13h5",
    "M8 16h8",
  ],
  "arrow-down": ["m19 12-7 7-7-7", "M12 5v14"],
  "arrow-up": ["m5 12 7-7 7 7", "M12 19V5"],
  check: ["M20 6 9 17l-5-5"],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevrons-left": ["m11 17-5-5 5-5", "m18 17-5-5 5-5"],
  "chevrons-right": ["m6 17 5-5-5-5", "m13 17 5-5-5-5"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  gear: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  history: [
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
    "M12 7v5l4 2",
  ],
  link: [
    "M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5",
    "M14 11a5 5 0 0 0-7.07 0l-2.83 2.83a5 5 0 0 0 7.07 7.07L12.5 19.5",
  ],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  mic: [
    "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z",
    "M19 10v2a7 7 0 0 1-14 0v-2",
    "M12 19v3",
  ],
  plugins: [
    "M4 4h6v6H4z",
    "M14 4h6v6h-6z",
    "M4 14h6v6H4z",
    "M17 14v6",
    "M14 17h6",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  refresh: [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"],
  sparkle: ["M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"],
  stop: ["M6 6h12v12H6z"],
  // Discard. A lid, a rim, and a body — the same three strokes every bin in
  // this weight is drawn from.
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M20 21a8 8 0 0 0-16 0"],
  // Dictation. Bars rather than a microphone: the control captures speech as
  // *text*, and the same shape animates while it is listening.
  waveform: ["M5 10v4", "M9 7v10", "M12 4v16", "M15 7v10", "M19 10v4"],
};
