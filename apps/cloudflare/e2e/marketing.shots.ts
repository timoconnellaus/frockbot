// The marketing site's app screenshots, taken from the production client on
// the browser harness: `bun run shots:marketing` from `apps/cloudflare`.
//
// Everything drawn is the real app. What is staged is what a screenshot cannot
// wait for: the Bots' replies come from a scripted model on this machine, the
// customer list and the tuner are Plugin pages served through the real
// plugin-page frame and bridge (as `plugin-page-panel.e2e.ts` does, since this
// harness has no build service), and Spending reads a fixture because a local
// deployment is unmetered.
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withPluginPageBridgeV1 } from "@frockbot/core/contracts";
import type { Page, APIRequestContext } from "@playwright/test";
import { PLUGIN_PAGE_CSP_V1 } from "../src/plugin-page-route.ts";
import { E2E_MODEL_ID } from "./harness.ts";
import {
  test,
  expect,
  openApplication,
  openBotPage,
  openProfileMenu,
  press,
  provisionAccountThroughApi,
  selectBot,
  sem,
  sendMessage,
  settle,
} from "./fixtures.ts";
import { botIdFromName, createBotCommandV1 } from "./provisioning.ts";

const OUT = fileURLToPath(
  new URL("../../marketing/public/assets/app/", import.meta.url),
);
const VIEWPORT = { width: 1440, height: 900 } as const;

/** Each Bot's id, filled in as the account is built: ids carry a random suffix. */
const ids: Record<string, string> = {};
const idOf = (name: string): string => {
  const id = ids[name];
  if (!id) throw new Error(`no Bot named ${name} yet`);
  return id;
};

/** What each Bot says back, keyed by what the person said. */
const REPLIES: Record<string, string> = {
  "Keep a list of my customers: who they are, what they've ordered, and when I should follow up.":
    "Done, it's in the panel on the right. I'll add new enquiries from your inbox as they arrive and keep each one up to date.",
  "Anything new this morning?":
    "A wholesale enquiry came in from Harbour Cafe, 40 bags a month. I've added them to your customer list as a lead, with a follow-up on Thursday.",
  "Can you make me a guitar tuner? Standard tuning.":
    "Here you go, it's beside our chat. Press Listen, allow the microphone, and play each string. It shows which way to turn.",
  "The A keeps going flat.":
    "New strings stretch for a day or two. Tune it up, give the string a gentle pull along its length, then tune again.",
  "Watch these headphones for me. I'll buy under $100, and only from a shop with free returns.":
    "Watching five shops for you. They're $129 today at the best one with free returns. I'll check every six hours.",
  "Any movement?":
    "They dropped to $89 overnight, the lowest in three months. Free returns, delivery by Thursday. Here's the link, in black, before it goes back up.",
  "Find me three quotes to clear the gutters before the rain.":
    "On it. I've emailed four local roofers with the photos from June, and I'll put the replies side by side as they come in.",
  "Flights to Bali for the school holidays, four of us, under $900 each.":
    "I'll check every morning at 7 and message you when something's worth grabbing.",
};

const CONVERSATIONS: Record<string, string[]> = {
  Home: ["Find me three quotes to clear the gutters before the rain."],
  Travel: [
    "Flights to Bali for the school holidays, four of us, under $900 each.",
  ],
  Deals: [
    "Watch these headphones for me. I'll buy under $100, and only from a shop with free returns.",
    "Any movement?",
  ],
  Guitar: [
    "Can you make me a guitar tuner? Standard tuning.",
    "The A keeps going flat.",
  ],
  Customers: [
    "Keep a list of my customers: who they are, what they've ordered, and when I should follow up.",
    "Anything new this morning?",
  ],
};

/** An OpenAI-compatible model that answers each message from `REPLIES`. */
function startScriptedModel(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const json = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/tags")
      return json({ models: [{ model: E2E_MODEL_ID }] });
    if (path === "/api/show") {
      request.resume();
      return json({
        capabilities: ["tools"],
        model_info: { "general.context_length": 8192 },
      });
    }
    // The Connection's inference probe.
    if (path === "/api/chat") {
      request.resume();
      return json({
        model: E2E_MODEL_ID,
        created_at: new Date(0).toISOString(),
        message: { role: "assistant", content: "h" },
        done: true,
        done_reason: "length",
      });
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8") || "{}",
      ) as {
        messages?: Array<{
          role?: string;
          content?: unknown;
          tool_calls?: Array<{ function?: { name?: string } }>;
        }>;
      };
      const messages = body.messages ?? [];
      const last = messages.findLastIndex((message) => message.role === "user");
      const said = messages
        .slice(last + 1)
        .some((message) =>
          message.tool_calls?.some(
            (call) => call.function?.name === "send_to_user",
          ),
        );
      const content = messages[last]?.content;
      const text =
        typeof content === "string" ? content : JSON.stringify(content);
      const reply = Object.entries(REPLIES).find(([asked]) =>
        text.includes(asked),
      )?.[1];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk: unknown) =>
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (reply && !said) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "shot-call",
                    type: "function",
                    function: {
                      name: "send_to_user",
                      arguments: JSON.stringify({
                        disposition: "finish",
                        payload: { type: "text", text: reply },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ delta: { content: "" } }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

/** A guitar's A string three cents flat, for the fake microphone. */
function nearlyInTune(): string {
  const frequency = 110 * 2 ** (-3 / 1200);
  const rate = 48_000;
  const cycles = Math.round(frequency * 2);
  const length = Math.round((cycles * rate) / frequency);
  const wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const phase = (2 * Math.PI * cycles * i) / length;
    const sample =
      0.3 * Math.sin(phase) +
      0.15 * Math.sin(2 * phase) +
      0.08 * Math.sin(3 * phase);
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + i * 2);
  }
  const path = join(tmpdir(), "frockbot-shots-a-string.wav");
  writeFileSync(path, wav);
  return path;
}

/** A zone where the run happens mid-morning, so the thread's times read like a day. */
function morningZone(): string {
  let offset = 9 - new Date().getUTCHours();
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  // POSIX signs Etc zones backwards: Etc/GMT-5 is five hours ahead.
  return offset === 0
    ? "Etc/GMT"
    : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

test.use({
  timezoneId: morningZone(),
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${nearlyInTune()}`,
    ],
  },
});

const CUSTOMERS_HASH = "e".repeat(64);
const TUNER_HASH = "f".repeat(64);

function customersPage(): string {
  const rows = [
    [
      "Harbour Cafe",
      "Lead · wholesale, 40 bags a month · follow up Thu",
      "Added just now",
      true,
    ],
    ["Northside Bakery", "Customer · reorder due Friday", "Mon", false],
    ["Lane & Co", "Lead · quote sent", "Last week", false],
    ["Green Room Florist", "Customer · monthly order", "2 Sep", false],
    ["Corner Deli", "Customer · paid, delivered", "28 Aug", false],
  ] as const;
  const list = rows
    .map(
      ([name, detail, when, fresh]) =>
        `<li class="${fresh ? "fresh" : ""}"><div><strong>${name.replace("&", "&amp;")}</strong><span>${detail}</span></div><time>${when}</time></li>`,
    )
    .join("");
  return withPluginPageBridgeV1(`<!doctype html>
<html><head><meta charset="utf-8"><title>Customers</title><style>
body{margin:0;padding:20px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#15151e;background:#fff}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px}
.stats div{background:#eceef3;border-radius:12px;padding:12px}
.stats b{display:block;font-size:20px}.stats span{font-size:12px;color:#5c5f70}
ul{list-style:none;margin:0;padding:0}
li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 10px;border-bottom:1px solid #dfe1e8}
li div{display:flex;flex-direction:column}li span{font-size:12px;color:#5c5f70}
time{font-size:11px;color:#5c5f70;white-space:nowrap}
li.fresh{background:#fdf0f5;border:1px solid #f5c3d7;border-radius:12px}li.fresh time{color:#b01d5a;font-weight:600}
</style></head><body>
<div class="stats"><div><b>24</b><span>Customers</span></div><div><b>5</b><span>Leads</span></div><div><b>2</b><span>Follow up</span></div></div>
<ul>${list}</ul>
</body></html>`);
}

function tunerPage(): string {
  const reference = readFileSync(
    new URL(
      "../../../app/plugins/skills/plugins/references/microphone.md",
      import.meta.url,
    ),
    "utf8",
  );
  const html = /```html\n([\s\S]*?)```/.exec(reference)?.[1];
  if (!html) throw new Error("microphone.md has no tuner page");
  return withPluginPageBridgeV1(html);
}

/** The Customers and Guitar Bots each run one Plugin page; no other Bot does. */
async function installPluginPages(page: Page, baseURL: string | undefined) {
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1:8787").origin;
  const focused = new Set<string>();
  const plugins: Record<
    string,
    { id: string; label: string; hash: string; abilities?: string[] }
  > = {
    customers: { id: "customers", label: "Customers", hash: CUSTOMERS_HASH },
    guitar: {
      id: "tuner",
      label: "Tuner",
      hash: TUNER_HASH,
      abilities: ["microphone"],
    },
  };
  await page.route(/\/api\/bots\/[^/]+\/panels\/device-use$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "recorded" }),
    }),
  );
  await page.route(
    /\/api\/bots\/[^/]+\/panels\/(open|focus)$/,
    async (route) => {
      const url = new URL(route.request().url());
      const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const plugin = Object.entries(plugins).find(([prefix]) =>
        botId.startsWith(`${prefix}-`),
      )?.[1];
      if (url.pathname.endsWith("/focus")) {
        focused.add(botId);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "applied" }),
        });
      }
      const empty = {
        schemaVersion: 1,
        bag: [],
        focus: { pluginId: null },
        doors: [],
      };
      if (!plugin) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(empty),
        });
      }
      const open = focused.has(botId);
      await route.fulfill({
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          schemaVersion: 1,
          bag: [
            {
              pluginId: plugin.id,
              displayName: plugin.label,
              surfaceId: plugin.id,
              label: plugin.label,
            },
          ],
          focus: open
            ? { pluginId: plugin.id, surfaceId: plugin.id }
            : { pluginId: null },
          ...(open
            ? {
                page: {
                  url: `${appOrigin}/plugin-pages/${plugin.hash}.html`,
                  state: {},
                  ...(plugin.abilities ? { abilities: plugin.abilities } : {}),
                },
              }
            : {}),
          doors: [
            {
              pluginId: plugin.id,
              label: plugin.label,
              opens: { pluginId: plugin.id, surfaceId: plugin.id },
            },
          ],
        }),
      });
    },
  );
  for (const [hash, body] of [
    [CUSTOMERS_HASH, customersPage()],
    [TUNER_HASH, tunerPage()],
  ] as const) {
    await page.route(`${appOrigin}/plugin-pages/${hash}.html`, (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": PLUGIN_PAGE_CSP_V1,
          "x-content-type-options": "nosniff",
        },
        body,
      }),
    );
  }
}

/** Spending, as a metered account a month in would see it. */
async function installSpending(page: Page) {
  const now = Date.now();
  const renews = now + 16 * 86_400_000;
  const spend: Array<[string, number, number]> = [
    ["Travel", 4_120_000, 41],
    ["Customers", 2_860_000, 37],
    ["Deals", 1_940_000, 52],
    ["Home", 910_000, 12],
    ["Guitar", 420_000, 9],
  ];
  const bots = () =>
    spend.map(
      ([name, micros, turns]) => [idOf(name), name, micros, turns] as const,
    );
  const days = () =>
    Array.from({ length: 30 }, (_, index) => {
      const i = 29 - index;
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      const wave = (1 + ((i * 7) % 11)) / 11;
      const stack = spend.map(([, micros]) =>
        Math.round((micros / 30) * wave * 1.4),
      );
      return { day, chargeMicros: stack.reduce((a, b) => a + b, 0), stack };
    });
  await page.route(/\/api\/billing\/spending/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        groupBy: new URL(route.request().url()).searchParams.get("groupBy"),
        filters: [],
        totalMicros: 10_250_000,
        previousTotalMicros: 9_400_000,
        operations: 420,
        turns: 151,
        days: days(),
        groups: bots().map(([id, label, chargeMicros, turns]) => ({
          key: id,
          label,
          chargeMicros,
          operations: turns * 3,
          turns,
          limitScope: `bot|${id}`,
          ...(label === "Deals"
            ? {
                limit: {
                  dailyMicros: 500_000,
                  todayMicros: 180_000,
                  reached: false,
                },
              }
            : {}),
        })),
        topCause: {
          key: `routine|${bots()[0]![0]}|fares`,
          label: "Fare watch",
          detail: "Travel",
          chargeMicros: 2_600_000,
          operations: 90,
          turns: 30,
        },
        credit: {
          availableMicros: 11_400_000,
          dailyMicros: 380_000,
          runsOutAt: renews + 14 * 86_400_000,
          renewsAt: renews,
        },
        topTurns: [
          {
            runId: "a",
            botId: bots()[0]![0],
            bot: "Travel",
            cause: "Fare watch",
            at: now - 86_400_000,
            chargeMicros: 310_000,
          },
          {
            runId: "b",
            botId: bots()[1]![0],
            bot: "Customers",
            cause: "You, in chat",
            at: now - 2 * 86_400_000,
            chargeMicros: 240_000,
          },
          {
            runId: "c",
            botId: bots()[2]![0],
            bot: "Deals",
            cause: "Price check",
            at: now - 3 * 86_400_000,
            chargeMicros: 190_000,
          },
        ],
      }),
    }),
  );
  await page.route(/\/api\/billing$/, (route) =>
    route.request().method() !== "GET"
      ? route.fallback()
      : route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            paymentsAvailable: true,
            metered: true,
            canSpend: true,
            subscribed: true,
            suspended: false,
            subscription: {
              status: "active",
              periodEnd: renews,
              cancelAtPeriodEnd: false,
            },
            includedMicros: 11_400_000,
            complimentaryMicros: 0,
            purchasedMicros: 0,
            reservedMicros: 0,
            payments: [],
            plan: {
              currency: "usd",
              monthlyCents: 2000,
              includedMicros: 15_000_000,
              topUpCents: [1000, 2500, 5000],
            },
            computerRate: {
              activeUsdPerHour: 2.75,
              storageIncludedGb: 100,
              viewerOpenSeconds: 30,
              viewerRenewSeconds: 30,
            },
            modelRates: {},
            usage: [],
          }),
        }),
  );
}

async function asUser(
  request: APIRequestContext,
  userId: string,
  path: string,
  data?: unknown,
) {
  const headers = { "x-frockbot-user-id": userId };
  const response =
    data === undefined
      ? await request.get(path, { headers })
      : await request.post(path, { headers, data });
  expect(response.ok(), `${path} answered ${response.status()}`).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

async function setAccountLook(
  request: APIRequestContext,
  userId: string,
  look: "ink" | "paper",
) {
  const settings = await asUser(request, userId, "/api/settings");
  await asUser(request, userId, "/api/settings", {
    schemaVersion: 1,
    type: "user/update-appearance",
    commandId: crypto.randomUUID(),
    expectedRevision: settings.revision,
    appearance: { look },
  });
}

async function dressDeals(request: APIRequestContext, userId: string) {
  const botId = idOf("Deals");
  const current = await asUser(request, userId, `/api/bots/${botId}/look`);
  await asUser(request, userId, `/api/bots/${botId}/look`, {
    schemaVersion: 1,
    type: "bot/update-look",
    commandId: crypto.randomUUID(),
    expectedRevision: current.revision,
    botId,
    look: "custom",
    document: {
      schemaVersion: 1,
      look: "ink",
      tokens: {
        surfaces: {
          window: "#0e1526",
          surface: "#121b30",
          raised: "#1a2540",
          text: "#eef2fb",
          muted: "#95a3c0",
          line: "#25324f",
          accent: "#f0a830",
          onAccent: "#1a1206",
        },
        type: "manrope",
        bubbles: { bot: "raised", me: "accent" },
      },
    },
  });
}

async function show(page: Page, name: string) {
  await selectBot(page, idOf(name), name);
  await settle(page);
}

async function openPluginPage(page: Page, pluginId: string, title: string) {
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${pluginId}`));
  await expect(sem(page, "conversation-panel-page")).toBeVisible({
    timeout: 60_000,
  });
  return page.locator(`iframe[title="${title}"]`).last().contentFrame();
}

async function shoot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  await settle(page);
  await page.waitForTimeout(1_500);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    ...(clip ? { clip } : {}),
  });
}

test("marketing screenshots", async ({ page, userId, baseURL }) => {
  test.setTimeout(900_000);
  const model = await startScriptedModel();
  try {
    await installPluginPages(page, baseURL);
    await installSpending(page);
    await page.setViewportSize(VIEWPORT);

    const order = ["Home", "Travel", "Deals", "Guitar", "Customers"];
    const account = await provisionAccountThroughApi(page.request, {
      userId,
      apiKey: "shots",
      apiBaseUrl: model.url,
      botName: order[0]!,
    });
    ids[order[0]!] = account.botId;
    const settings = await asUser(page.request, userId, "/api/settings");
    await asUser(page.request, userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/update-profile",
      commandId: crypto.randomUUID(),
      expectedRevision: settings.revision,
      profile: { name: "Sam" },
    });
    for (const name of order.slice(1)) {
      ids[name] = botIdFromName(name);
      const flock = await asUser(page.request, userId, "/api/bots");
      await asUser(
        page.request,
        userId,
        "/api/bots",
        createBotCommandV1({
          expectedRevision: flock.revision as number,
          botId: ids[name]!,
          name,
        }),
      );
    }

    await setAccountLook(page.request, userId, "paper");
    await openApplication(page, userId);
    for (const name of order) {
      await show(page, name);
      for (const said of CONVERSATIONS[name]!)
        await sendMessage(page, said, { replies: 1 });
    }

    await dressDeals(page.request, userId);

    // 1. The customer list, in Paper.
    await show(page, "Customers");
    const customers = await openPluginPage(page, "customers", "Customers");
    await expect(customers.getByText("Harbour Cafe")).toBeVisible({
      timeout: 30_000,
    });
    await shoot(page, "customers");

    // 2. The tuner, in Ink, listening.
    await setAccountLook(page.request, userId, "ink");
    await openApplication(page, userId);
    await show(page, "Guitar");
    const tuner = await openPluginPage(page, "tuner", "Tuner");
    await tuner.locator("#listen").click();
    await expect(sem(page, "plugin-page-microphone")).toBeVisible({
      timeout: 30_000,
    });
    await expect(tuner.locator("#note")).toHaveText("A2", { timeout: 30_000 });
    await shoot(page, "tuner");
    await press(sem(page, "plugin-page-microphone-stop"));

    // 3. Deals, in its own look.
    await show(page, "Deals");
    await shoot(page, "theme");

    // 4. Spending.
    await openProfileMenu(page);
    await press(sem(page, "profile-credit"));
    await expect(page.getByText(/Credit left|Spending/).first())
      .toBeVisible({ timeout: 30_000 })
      .catch(() => undefined);
    // The Billing pane alone: the account column beside it is chrome.
    await shoot(page, "spending", { x: 288, y: 0, width: 1152, height: 900 });
  } finally {
    await model.close();
  }
});
