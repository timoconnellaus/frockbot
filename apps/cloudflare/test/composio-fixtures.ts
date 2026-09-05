/** Public provider schemas with synthetic data. No account credentials or alternate runtime. */
export const composioFixtures = [
  {
    slug: "gmail",
    name: "Gmail",
    description: "Read and send email",
    version: "20260905_00",
    tool: {
      slug: "GMAIL_FETCH_EMAILS",
      name: "Fetch emails",
      description: "Read recent Gmail messages",
      input_parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
    result: {
      messages: [{ id: "mail-one", subject: "Hello from your inbox" }],
    },
    trigger: {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      name: "When a new email arrives in Gmail",
      description: "Run when your inbox receives a new message.",
      config: {
        type: "object",
        properties: {
          label: {
            type: "string",
            title: "Mailbox label",
            description: "Optional: listen only to messages with this label.",
          },
        },
      },
    },
  },
  {
    // https://docs.composio.dev/toolkits/googlecalendar, checked 2026-09-05.
    // Current config is camelCase; the delivered payload is snake_case.
    slug: "googlecalendar",
    name: "Google Calendar",
    description: "Plan your day and keep up with meetings",
    version: "20260826_00",
    tool: {
      slug: "GOOGLECALENDAR_EVENTS_LIST",
      name: "List events",
      description: "Read upcoming events on a calendar",
      input_parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", default: "primary" },
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          timeZone: { type: "string" },
          singleEvents: { type: "boolean" },
          orderBy: { type: "string" },
          maxResults: { type: "integer" },
        },
      },
    },
    result: {
      kind: "calendar#events",
      timeZone: "Australia/Sydney",
      items: [
        {
          id: "calendar-event-one",
          summary: "Team meeting",
          start: { dateTime: "2026-09-05T09:00:00+10:00" },
          end: { dateTime: "2026-09-05T09:30:00+10:00" },
        },
      ],
    },
    trigger: {
      slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER",
      name: "Event starting soon",
      description: "An event on your calendar is about to start.",
      type: "poll",
      // Exercise the provider's property-map schema dialect too.
      config: {
        calendarId: { type: "string", default: "primary" },
        countdownWindowMinutes: { type: "integer", default: 60 },
        includeAllDay: { type: "boolean", default: false },
        interval: { type: "number", default: 2 },
        minutesBeforeStart: { type: "integer", default: 10 },
      },
    },
  },
];
