/** User-facing What’s New entries. Dated by the first production tag that ships them. */

export const WHATS_NEW_KINDS_V1 = ["feature", "improvement", "fix"] as const;
export type WhatsNewKindV1 = (typeof WHATS_NEW_KINDS_V1)[number];

export type WhatsNewImageV1 = {
  /** File under `media/`, served at `/whats-new/<file>`. */
  file: string;
  alt: string;
};

export type WhatsNewEntrySourceV1 = {
  id: string;
  title: string;
  summary: string;
  kind: WhatsNewKindV1;
  image?: WhatsNewImageV1;
};

/**
 * Newest first. An id is stable: renaming one is a new entry, and a reused
 * id would inherit the earlier tag’s date.
 */
export const WHATS_NEW_ENTRIES_V1: readonly WhatsNewEntrySourceV1[] = [
  {
    id: "mac-window-place",
    title: "The Mac window keeps its place",
    summary:
      "It reopens where you left it and at the same size, including after an update. A double-click on the header zooms it, and the whole header moves it.",
    kind: "fix",
  },
  {
    id: "avatar-colour-flash",
    title: "Avatars open in their own colour",
    summary:
      "A Bot’s character no longer flashes its original colour when a screen opens.",
    kind: "fix",
  },
  {
    id: "flock-palette",
    title: "Colours from the characters",
    summary:
      "The pink, the creams and the black come from the characters. Your messages on Paper sit in a soft tint.",
    kind: "improvement",
    image: {
      file: "flock-palette.webp",
      alt: "A dark chat with Pixel: warm cream text, your messages in a pink tint, and a bright pink send button.",
    },
  },
  {
    id: "one-card-per-provider",
    title: "One card per model provider",
    summary:
      "A provider that takes a key or a sign-in is one card in the Marketplace, with both ways to connect.",
    kind: "improvement",
    image: {
      file: "one-card-per-provider.webp",
      alt: "The OpenRouter card in the Marketplace, open on two ways to connect: Use an API key and Sign in.",
    },
  },
  {
    id: "add-a-model",
    title: "Add a model in one go",
    summary:
      "Adding a provider in the Marketplace asks for its key straight away, then leads on to choosing a model.",
    kind: "improvement",
    image: {
      file: "add-a-model.webp",
      alt: "The DeepSeek card in the Marketplace after its key is connected, with the account ready and a Choose a model button.",
    },
  },
  {
    id: "plugins-per-bot",
    title: "Plugins live with each Bot",
    summary:
      "Built-in features are switched on a Bot’s own Plugins page, and every Bot can choose its own model. Account features is gone.",
    kind: "improvement",
    image: {
      file: "plugins-per-bot.webp",
      alt: "A Bot’s Plugins page on a phone: Web, Routines and Image under Built in, each with its own switch.",
    },
  },
  {
    id: "plugin-theme-refused",
    title: "A refused plugin theme is reported",
    summary:
      "The notice names the plugin and why its theme was refused. The Bot keeps its last theme.",
    kind: "fix",
  },
  {
    id: "voice-opening",
    title: "The first words of a call are kept",
    summary:
      "Speech at the start of a call is held until the line is ready, then sent in order.",
    kind: "improvement",
  },
  {
    id: "committed-chat",
    title: "Replies land as they are sent",
    summary:
      "A Bot’s message appears in the thread as soon as it is committed, without waiting for a refresh.",
    kind: "improvement",
  },
  {
    id: "voice-call-card",
    title: "A live call is a card",
    summary:
      "It sits at the top of the chat, with mute and hang-up under the wave.",
    kind: "improvement",
    image: {
      file: "voice-call-card.webp",
      alt: "A phone chat with the live call in a card under the header: the Bot, the wave, and you, with mute and hang-up on the row below.",
    },
  },
  {
    id: "header-align",
    title: "Chat header lines up",
    summary: "The back arrow, avatar, name, and panel icon share one center.",
    kind: "fix",
    image: {
      file: "header-align.webp",
      alt: "The phone chat header with Pixel, Dog, and Cow, each centered with the back arrow, name, and panel icon.",
    },
  },
  {
    id: "quiet-delivery",
    title: "Sends acknowledge immediately",
    summary:
      "A message is accepted as soon as it is saved. A long reply no longer looks like the send failed.",
    kind: "fix",
  },
  {
    id: "chat-scroll",
    title: "Earlier messages stay in reach",
    summary:
      "A long conversation scrolls back to them, and the scrollbar holds its place.",
    kind: "fix",
  },
  {
    id: "marketplace-installed",
    title: "Installed in the Marketplace",
    summary:
      "Configure or remove added models and connectors from Installed. Models and Connectors are checkboxes under search.",
    kind: "improvement",
  },
  {
    id: "chat-type",
    title: "Easier reading in chat",
    summary: "Messages use Inter at 14, with more air between list items.",
    kind: "improvement",
    image: {
      file: "chat-type.webp",
      alt: "A Bot message in Inter, with air between list items.",
    },
  },
  {
    id: "whats-new",
    title: "What’s New in the app",
    summary: "What landed in each release.",
    kind: "feature",
    image: {
      file: "whats-new.webp",
      alt: "The What’s New page, with this feature as its first entry.",
    },
  },
];
