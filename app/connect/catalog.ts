// The apps a User can connect, and the identifiers they carry through the
// Package definition, the Connectors surface and a Bot's tool namespaces.
//
// Every app the provider's hosted sign-in can finish with nothing of ours — its
// own OAuth app, dynamic client registration, a key, token or password the
// person types on the provider's page, the person's own developer app, or no
// sign-in at all — is here, generated into `apps.generated.ts` by
// `scripts/generate-connect-catalog.ts`. AI model providers are not: models are
// chosen in Models. The featured apps below lead the list in our own words; the
// rest follow alphabetically in the provider's. The provider behind every one
// of them is invisible plumbing — no copy anywhere names it, and a Bot sees
// "gmail", never a vendor's name for Gmail.
import { CONNECT_GENERATED_APPS_V1 } from "./apps.generated.js";

/**
 * How an app signs in. Each one ends on the provider's hosted page except
 * `NO_AUTH`, which needs no page at all.
 *
 * - `managed`: an OAuth app the provider runs.
 * - `DCR_OAUTH`: OAuth whose client registers itself.
 * - `API_KEY`, `BEARER_TOKEN`, `BASIC`: a credential the person types on the
 *   provider's page; it never passes through this deployment.
 * - `OAUTH2`, `OAUTH1`, `S2S_OAUTH2`, `SAML`: the same, for the person's own
 *   developer app — the page asks for its client id and secret, or a
 *   company's signing key, and says how to register one.
 * - `NO_AUTH`: nothing to sign in to.
 */
export type ConnectAuthV1 =
  | "managed"
  | "DCR_OAUTH"
  | "NO_AUTH"
  | "API_KEY"
  | "BEARER_TOKEN"
  | "BASIC"
  | "OAUTH2"
  | "OAUTH1"
  | "S2S_OAUTH2"
  | "SAML";

/** One generated row: `[slug, name, description, auth]`. */
export type ConnectGeneratedAppV1 = readonly [
  slug: string,
  name: string,
  description: string,
  auth: ConnectAuthV1,
];

export interface ConnectToolkitV1 {
  /** The provider's toolkit slug; also the Bot-facing Tool Namespace. */
  slug: string;
  /** The Connectors row and the account's default label. */
  name: string;
  description: string;
  auth: ConnectAuthV1;
}

export const CONNECT_PACKAGE_ID = "connect";

/** The apps people reach for first, in the order the list shows them. */
const FEATURED: readonly (readonly [
  slug: string,
  name: string,
  description: string,
])[] = [
  ["gmail", "Gmail", "Read, search, label and send email in a Gmail account."],
  [
    "googlecalendar",
    "Google Calendar",
    "See and manage events on a Google Calendar.",
  ],
  [
    "googledrive",
    "Google Drive",
    "Find, read and create files in Google Drive.",
  ],
  [
    "github",
    "GitHub",
    "Work with repositories, issues and pull requests on GitHub.",
  ],
  ["slack", "Slack", "Read and post messages in a Slack workspace."],
  ["notion", "Notion", "Search, read and write pages and databases in Notion."],
  [
    "googlesheets",
    "Google Sheets",
    "Read, update and create spreadsheets in Google Sheets.",
  ],
  [
    "outlook",
    "Outlook",
    "Read, search and send email, and manage events, in Outlook.",
  ],
  [
    "googledocs",
    "Google Docs",
    "Create, read and edit documents in Google Docs.",
  ],
  [
    "supabase",
    "Supabase",
    "Manage Supabase projects and functions, and run database queries.",
  ],
  [
    "hubspot",
    "HubSpot",
    "Work with contacts, companies, deals and tickets in HubSpot.",
  ],
  [
    "linear",
    "Linear",
    "Create, search and update issues and projects in Linear.",
  ],
  ["airtable", "Airtable", "Read, add and update records in Airtable bases."],
  [
    "jira",
    "Jira",
    "Create, search and update issues, sprints and projects in Jira.",
  ],
  [
    "youtube",
    "YouTube",
    "Manage videos, playlists and comments on a YouTube channel.",
  ],
  [
    "bitbucket",
    "Bitbucket",
    "Work with repositories, branches and pull requests on Bitbucket.",
  ],
  [
    "googletasks",
    "Google Tasks",
    "Add, update and complete tasks in Google Tasks.",
  ],
  [
    "figma",
    "Figma",
    "Read files, components, comments and design tokens in Figma.",
  ],
  ["reddit", "Reddit", "Search, read, post and comment on Reddit."],
  ["cal", "Cal.com", "See bookings, event types and free time in Cal.com."],
  ["wrike", "Wrike", "Create and track tasks, folders and projects in Wrike."],
  [
    "sentry",
    "Sentry",
    "Look into errors, issues, alerts and releases in Sentry.",
  ],
  [
    "microsoft_teams",
    "Microsoft Teams",
    "Read and send chat and channel messages, and set up meetings, in Microsoft Teams.",
  ],
  ["asana", "Asana", "Create, assign and track tasks and projects in Asana."],
  ["linkedin", "LinkedIn", "Share posts and comments from a LinkedIn profile."],
  [
    "google_maps",
    "Google Maps",
    "Look up places, addresses, directions and travel times with Google Maps.",
  ],
  ["one_drive", "OneDrive", "Find, share and organise files in OneDrive."],
  [
    "salesforce",
    "Salesforce",
    "Work with accounts, contacts, leads and opportunities in Salesforce.",
  ],
  [
    "calendly",
    "Calendly",
    "Share scheduling links and see booked meetings in Calendly.",
  ],
  ["trello", "Trello", "Work with boards, lists and cards in Trello."],
  ["clickup", "ClickUp", "Create and update tasks, lists and docs in ClickUp."],
  [
    "stripe",
    "Stripe",
    "Look up customers, payments, invoices and subscriptions in Stripe.",
  ],
  [
    "mailchimp",
    "Mailchimp",
    "Manage audiences and contacts, and send campaigns, in Mailchimp.",
  ],
  ["attio", "Attio", "Work with people, companies, deals and notes in Attio."],
  [
    "googlemeet",
    "Google Meet",
    "Set up meetings and read recordings and transcripts in Google Meet.",
  ],
  [
    "zoho",
    "Zoho CRM",
    "Work with leads, contacts, deals and notes in Zoho CRM.",
  ],
  ["dropbox", "Dropbox", "Find, share and organise files in Dropbox."],
  [
    "confluence",
    "Confluence",
    "Search, read and write pages and blog posts in Confluence.",
  ],
  [
    "googlebigquery",
    "Google BigQuery",
    "Query datasets and manage tables in Google BigQuery.",
  ],
  [
    "monday",
    "monday.com",
    "Work with boards, items and columns in monday.com.",
  ],
  [
    "whatsapp",
    "WhatsApp Business",
    "Send messages and manage templates from a WhatsApp Business account.",
  ],
  [
    "dynamics365",
    "Dynamics 365",
    "Work with leads, cases, opportunities and invoices in Dynamics 365.",
  ],
  [
    "zendesk",
    "Zendesk",
    "Search and read support tickets and users in Zendesk.",
  ],
  [
    "googlephotos",
    "Google Photos",
    "Upload photos and put together albums in Google Photos.",
  ],
  [
    "zoom",
    "Zoom",
    "Schedule meetings and read recordings and summaries in Zoom.",
  ],
  [
    "googleads",
    "Google Ads",
    "Report on and adjust campaigns, ad groups and ads in Google Ads.",
  ],
  [
    "pagerduty",
    "PagerDuty",
    "Look into incidents, alerts, services and on-call in PagerDuty.",
  ],
  ["miro", "Miro", "Create boards, sticky notes, cards and shapes in Miro."],
  [
    "share_point",
    "SharePoint",
    "Find and read sites, pages, lists and files in SharePoint.",
  ],
  [
    "contentful",
    "Contentful",
    "Create, edit and publish entries and content types in Contentful.",
  ],
  ["apaleo", "Apaleo", "Manage properties, units and unit groups in Apaleo."],
  [
    "zoho_books",
    "Zoho Books",
    "Handle invoices, bills, expenses and contacts in Zoho Books.",
  ],
  [
    "zoho_inventory",
    "Zoho Inventory",
    "Track items, orders, invoices and bills in Zoho Inventory.",
  ],
  [
    "facebook",
    "Facebook",
    "Post, comment and answer messages on a Facebook Page.",
  ],
  ["webex", "Webex", "Read and send messages in Webex rooms and teams."],
  ["canva", "Canva", "Import, resize and export designs in Canva."],
  ["linkhut", "Linkhut", "Save, tag and find bookmarks in Linkhut."],
  ["timely", "Timely", "Read time, projects and reports in Timely."],
  ["box", "Box", "Find, share and comment on files in Box."],
  [
    "productboard",
    "Productboard",
    "Capture notes and manage features and releases in Productboard.",
  ],
  [
    "freshbooks",
    "FreshBooks",
    "See clients, projects and journal entries in FreshBooks.",
  ],
  [
    "zoho_bigin",
    "Zoho Bigin",
    "Work with contacts, pipelines and notes in Zoho Bigin.",
  ],
  [
    "gorgias",
    "Gorgias",
    "Handle support tickets, customers and macros in Gorgias.",
  ],
  [
    "google_analytics",
    "Google Analytics",
    "Run traffic and audience reports in Google Analytics.",
  ],
  [
    "todoist",
    "Todoist",
    "Add, update and complete tasks and projects in Todoist.",
  ],
  [
    "zoho_desk",
    "Zoho Desk",
    "Create, search and update support tickets in Zoho Desk.",
  ],
  [
    "square",
    "Square",
    "Look up payments, orders, customers and inventory in Square.",
  ],
  ["yandex", "Yandex", "Reach Yandex Disk files, Music and Metrica stats."],
  [
    "dialpad",
    "Dialpad",
    "Place calls and manage users and numbers in Dialpad.",
  ],
  [
    "ynab",
    "YNAB",
    "Read budgets, accounts and transactions, and schedule new ones, in YNAB.",
  ],
  ["gumroad", "Gumroad", "See products, sales and licences on Gumroad."],
  ["gong", "Gong", "Read calls, transcripts and activity in Gong."],
  [
    "servicem8",
    "ServiceM8",
    "Create jobs, notes and payments, and see clients, in ServiceM8.",
  ],
  [
    "harvest",
    "Harvest",
    "Log time and expenses, and send estimates and invoices, in Harvest.",
  ],
  [
    "wakatime",
    "WakaTime",
    "Read coding time, projects, goals and insights from WakaTime.",
  ],
  [
    "boldsign",
    "BoldSign",
    "Send documents for signature and follow them in BoldSign.",
  ],
  ["zoho_mail", "Zoho Mail", "Read, search and send email in Zoho Mail."],
  ["mural", "Mural", "Find murals and add sticky notes in Mural."],
  [
    "intercom",
    "Intercom",
    "Handle conversations, contacts and tickets in Intercom.",
  ],
  [
    "eventbrite",
    "Eventbrite",
    "Create and manage events, tickets and venues on Eventbrite.",
  ],
  [
    "exist",
    "Exist",
    "Read and log personal stats, averages and insights in Exist.",
  ],
  [
    "zoho_invoice",
    "Zoho Invoice",
    "Create invoices, estimates and payments in Zoho Invoice.",
  ],
  [
    "stack_exchange",
    "Stack Exchange",
    "Search questions and read answers across Stack Exchange.",
  ],
  [
    "basecamp",
    "Basecamp",
    "Work with to-dos, cards, docs and messages in Basecamp.",
  ],
  [
    "capsule_crm",
    "Capsule CRM",
    "Work with contacts, opportunities and tasks in Capsule CRM.",
  ],
  [
    "crowdin",
    "Crowdin",
    "Manage translation projects, strings and glossaries in Crowdin.",
  ],
  ["dart", "Dart", "Create and track tasks and docs in Dart."],
  ["dub", "Dub", "Create and track short links in Dub."],
  ["excel", "Excel", "Read and edit workbooks, sheets and tables in Excel."],
  ["fathom", "Fathom", "Read meeting summaries and transcripts from Fathom."],
  [
    "freeagent",
    "FreeAgent",
    "Create invoices, bills and timeslips, and read reports, in FreeAgent.",
  ],
  [
    "gitlab",
    "GitLab",
    "Work with projects, issues, merge requests and pipelines on GitLab.",
  ],
  [
    "google_classroom",
    "Google Classroom",
    "See courses, coursework, announcements and students in Google Classroom.",
  ],
  [
    "google_search_console",
    "Google Search Console",
    "Check search performance, sitemaps and pages in Google Search Console.",
  ],
  [
    "googleslides",
    "Google Slides",
    "Create and edit presentations in Google Slides.",
  ],
  [
    "instagram",
    "Instagram",
    "Post, reply to comments and answer messages on an Instagram business or creator account.",
  ],
  ["kit", "Kit", "Manage subscribers, tags and broadcasts in Kit."],
  [
    "moneybird",
    "Moneybird",
    "Manage contacts and sales invoices in Moneybird.",
  ],
  ["omnisend", "Omnisend", "Sync contacts, products and orders with Omnisend."],
  [
    "pinterest",
    "Pinterest",
    "Create pins and boards, and read trends and analytics, on Pinterest.",
  ],
  [
    "pinterest_ads",
    "Pinterest Ads",
    "Report on and adjust campaigns, ad groups and ads in Pinterest Ads.",
  ],
  ["prisma", "Prisma", "Manage Prisma Postgres databases and run SQL."],
  [
    "pushbullet",
    "Pushbullet",
    "Send pushes and files to your devices with Pushbullet.",
  ],
  [
    "quickbooks",
    "QuickBooks",
    "Record bills, payments and sales, and run reports, in QuickBooks.",
  ],
  [
    "reddit_ads",
    "Reddit Ads",
    "Report on campaigns, ad groups and audiences in Reddit Ads.",
  ],
  ["roam", "Roam", "Send and read messages, and share meeting links, in Roam."],
  [
    "shippo",
    "Shippo",
    "Compare shipping rates, buy labels and track parcels with Shippo.",
  ],
  [
    "splitwise",
    "Splitwise",
    "Add and split expenses with friends and groups in Splitwise.",
  ],
  [
    "ticketmaster",
    "Ticketmaster",
    "Search events, attractions and venues on Ticketmaster.",
  ],
  [
    "ticktick",
    "TickTick",
    "Add, update and complete tasks and projects in TickTick.",
  ],
  ["typeform", "Typeform", "Create forms and read responses in Typeform."],
  ["zeplin", "Zeplin", "Read projects, screens and styles in Zeplin."],
];

function catalog(): readonly ConnectToolkitV1[] {
  const generated = new Map(
    CONNECT_GENERATED_APPS_V1.map(([slug, name, description, auth]) => [
      slug,
      { slug, name, description, auth },
    ]),
  );
  const featured = FEATURED.flatMap(([slug, name, description]) => {
    const app = generated.get(slug);
    if (!app) return [];
    generated.delete(slug);
    return [{ ...app, name, description }];
  });
  return [...featured, ...generated.values()];
}

export const CONNECT_TOOLKITS_V1: readonly ConnectToolkitV1[] = catalog();

/** How many apps a person can connect; what the product and the site say. */
export const CONNECT_APP_COUNT_V1 = CONNECT_TOOLKITS_V1.length;

const BY_SLUG = new Map(
  CONNECT_TOOLKITS_V1.map((toolkit) => [toolkit.slug, toolkit]),
);

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
  const prefix = `${CONNECT_PACKAGE_ID}-`;
  return connectionTypeId.startsWith(prefix)
    ? BY_SLUG.get(connectionTypeId.slice(prefix.length))
    : undefined;
}

/** The app a toolkit slug names, or nothing for an app this list does not carry. */
export function connectToolkitV1(slug: string): ConnectToolkitV1 | undefined {
  return BY_SLUG.get(slug);
}

/** The featured slugs, for the test that keeps each one generated. */
export const CONNECT_FEATURED_SLUGS_V1: readonly string[] = FEATURED.map(
  ([slug]) => slug,
);
