// The apps a User can connect, and the identifiers they carry through the
// Package definition, the Connectors surface and a Bot's tool namespaces.
//
// One row per app, curated rather than read from the provider's 800-entry
// catalog: an entry here is a promise that the app works end to end, and the
// list grows by an edit. The provider behind every one of them is invisible
// plumbing — no copy anywhere names it, and a Bot sees "gmail", never a
// vendor's name for Gmail.

export interface ConnectToolkitV1 {
  /** The provider's toolkit slug; also the Bot-facing Tool Namespace. */
  slug: string;
  /** The Connectors row and the account's default label. */
  name: string;
  description: string;
}

export const CONNECT_PACKAGE_ID = "connect";

export const CONNECT_TOOLKITS_V1: readonly ConnectToolkitV1[] = [
  {
    slug: "gmail",
    name: "Gmail",
    description: "Read, search, label and send email in a Gmail account.",
  },
  {
    slug: "googlecalendar",
    name: "Google Calendar",
    description: "See and manage events on a Google Calendar.",
  },
  {
    slug: "googledrive",
    name: "Google Drive",
    description: "Find, read and create files in Google Drive.",
  },
  {
    slug: "github",
    name: "GitHub",
    description: "Work with repositories, issues and pull requests on GitHub.",
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Read and post messages in a Slack workspace.",
  },
  {
    slug: "notion",
    name: "Notion",
    description: "Search, read and write pages and databases in Notion.",
  },
];

export function connectConnectionTypeIdV1(slug: string): string {
  return `${CONNECT_PACKAGE_ID}-${slug}`;
}

export function connectCapabilityIdV1(slug: string): string {
  return `${CONNECT_PACKAGE_ID}-${slug}-tools`;
}

/** The app a Connection Type stands for, or nothing for a type this list does not carry. */
export function connectToolkitForConnectionTypeV1(
  connectionTypeId: string,
): ConnectToolkitV1 | undefined {
  return CONNECT_TOOLKITS_V1.find(
    (toolkit) => connectConnectionTypeIdV1(toolkit.slug) === connectionTypeId,
  );
}
