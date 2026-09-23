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
    id: "computer-steps-faster",
    title: "Faster Computer steps",
    summary:
      "A Bot’s commands on its Computer no longer each wait for a screenshot.",
    kind: "improvement",
  },
  {
    id: "computer-card-current",
    title: "The Computer card is current",
    summary:
      "It shows the desktop as the Bot last left it, updated when a Turn ends.",
    kind: "fix",
  },
  {
    id: "voice-answers-after-tools",
    title: "Calls answer without a false error",
    summary:
      "Asking for something on a call no longer shows “I couldn’t get that answer out loud” before the reply, and a goodbye or hand-over is heard in full.",
    kind: "fix",
  },
  {
    id: "unread-keeps-up",
    title: "Unread that keeps up",
    summary:
      "A reply landing in the chat you have open no longer sends an alert, and Mark unread stays until you open the Bot again. On a Mac, the Dock badge updates while the window is minimised.",
    kind: "fix",
  },
  {
    id: "voice-smooth-playback",
    title: "Voice replies play smoothly",
    summary:
      "A Bot’s voice no longer breaks up mid-word when the connection is uneven.",
    kind: "fix",
  },
  {
    id: "steering",
    title: "A message sent mid-reply steers the Bot",
    summary:
      "It waits in the thread, and the Bot reads it at its next step instead of dropping what it was doing.",
    kind: "improvement",
    image: {
      file: "steering.webp",
      alt: "The end of a phone chat with Fox: under Fox’s “Starting with the runway numbers.”, the person’s next message waits greyed, with Fox working below it.",
    },
  },
  {
    id: "paused-call-colour",
    title: "A paused call keeps the Bot’s colour",
    summary:
      "A Bot’s character no longer turns back to its original colour while a call is paused.",
    kind: "fix",
  },
  {
    id: "release-version",
    title: "Profile names the release",
    summary:
      "The version at the foot of the page is the release that is running. The Mac app no longer calls itself a development build.",
    kind: "fix",
  },
  {
    id: "notices-under-header",
    title: "Chat notices sit under the header",
    summary:
      "Offline, paused and out-of-credit notices are no longer hidden behind it, and Reconnect and Open Billing can be pressed.",
    kind: "fix",
    image: {
      file: "notices-under-header.webp",
      alt: "A phone chat with Fox: under the header, the notice “You’re offline. Your Bot can keep working.” with Reconnect beside it.",
    },
  },
  {
    id: "whats-new-reading",
    title: "What’s New, easier to read",
    summary:
      "Changes share a card under their day, and a wide window keeps the page to a reading width.",
    kind: "improvement",
    image: {
      file: "whats-new-reading.webp",
      alt: "What’s New with two changes in one card under New, the unread one marked with a pink dot.",
    },
  },
  {
    id: "working-bot",
    title: "A working Bot sits at the end of the thread",
    summary:
      "A sheen crosses it while it works. A Bot it has asked something joins it once it starts on the answer.",
    kind: "improvement",
    image: {
      file: "working-bot.webp",
      alt: "The end of a phone chat with Fox: after “Messaged Dog”, Fox sits under a passing sheen with Dog beside it, above the composer.",
    },
  },
  {
    id: "stop-command",
    title: "Stop is /stop",
    summary:
      "The Stop button is gone from the chat. /stop ends what the Bot is doing.",
    kind: "improvement",
  },
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
