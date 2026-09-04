/**
 * The human line a person reads in "All plugins", keyed by package id.
 *
 * The manifest carries no prose and gaining a field for one would bump the
 * manifest schema, so the copy lives beside the publisher that needs it. It is
 * also the text `package_search` matches on, so each line is written in the
 * words someone would search for ("remember", "schedule", "screenshot"),
 * naming what the Bot can now do rather than how the Bot is built.
 */
export const CATALOG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  admin: "Run the deployment: open or close sign-ups and manage who can join.",
  applets:
    "Build small apps the Bot writes for you, then publish, revert, or delete them.",
  audit:
    "Review a record of every command, browser step, and outside call the Bot made.",
  auth: "Sign in and stay signed in across the web app and your desktop.",
  authoring:
    "Let the Bot write and revise its own tools when no existing tool does the job.",
  "bot-template":
    "Export a Bot as a shareable template so someone else can start from your setup.",
  clock:
    "Tell the Bot the current date and time, so it stops guessing what today is.",
  computer:
    "Give the Bot a computer it can use: run commands, browse the web, take screenshots.",
  credentials:
    "Save logins and API keys once, so the Bot can reach your other services later.",
  "custom-models":
    "Point the Bot at your own model provider and API key instead of the built-in models.",
  "desktop-clipboard":
    "Let the Bot read and write the clipboard on your desktop computer.",
  "desktop-directory-picker":
    "Pick a folder on your computer and hand the Bot access to the files in it.",
  "desktop-notifications":
    "Get a desktop notification when the Bot finishes work or needs an answer.",
  echo: "A tiny demo tool that repeats what you send it, handy for checking a Bot works.",
  flock:
    "Give the Bot a name, a face, and a profile, and let it look after its own settings.",
  "fly-sprite":
    "Host the Bot's computer on a real machine, so its desktop and files are still there later.",
  identity: "Tell the Bot who it is, so it answers in a consistent voice.",
  image: "Generate pictures from a written description.",
  "machine-messages":
    "Read and send messages on your Mac, so the Bot can follow and answer your texts.",
  mcp: "Connect outside MCP servers, so the tools they offer show up for the Bot to use.",
  memory:
    "Remember things across conversations, so you do not have to repeat yourself.",
  "mobile-clipboard":
    "Let the Bot read and write the clipboard on your phone.",
  "mobile-notifications":
    "Get a push notification on your phone when the Bot needs you or finishes a job.",
  "package-catalog":
    "Search for plugins and install, update, or remove them, so the Bot picks up new tools.",
  "package-publisher":
    "Publish a plugin you built, so other people can find and install it.",
  "provider-flock-ai": "Use Flock AI models to power the Bot's replies.",
  "provider-foundation":
    "Use the models that ship with the app, so a brand new Bot answers with no setup.",
  "provider-ollama-cloud":
    "Use Ollama Cloud models, including their web search, to power the Bot's replies.",
  routines:
    "Schedule the Bot to do something on a repeat, like a daily summary or hourly check.",
  search:
    "Search your past chats to find a message or an answer you saw before.",
  settings: "Change how the app and each of your Bots behave, in one place.",
  shell:
    "The chat itself: talk to your Bot, approve what it asks for, and hand a job to another Bot.",
  skills:
    "Teach the Bot reusable instructions it can load when a job calls for them.",
  subagents:
    "Hand a long job to a helper the Bot runs in the background, then collect the result.",
  "ui-theme": "Choose how the app looks, including light and dark mode.",
  "user-machine":
    "Register your own computer, so the Bot can run commands and move files on it once you approve.",
  web: "Search the web and read pages, so the Bot can answer with current information.",
};

export function catalogDescriptionFor(packageId: string): string | undefined {
  return CATALOG_DESCRIPTIONS[packageId];
}
