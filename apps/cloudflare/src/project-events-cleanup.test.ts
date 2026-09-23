import { expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  SessionEventLog,
  sessionEventLogPagePrefixV1,
  sessionEventPayloadPrefixV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  cleanProjectEventsV1,
  withoutProjectShapesV1,
} from "./project-events-cleanup.js";

const SESSION = "user:bob";
const turn = { turn: 1, step: 1 };

function events() {
  const fact = (text: string) => ({
    scope: "user" as const,
    groupId: "",
    tier: "profile" as const,
    via: "",
    learnedAt: "2026-09-01",
    text,
  });
  const inputs: SessionEventInput[] = [
    { type: "turn/start", turn: 1 },
    { type: "step/start", ...turn },
    {
      type: "memory/injected",
      turn: 1,
      sources: [
        {
          scope: "user",
          groupId: "",
          path: "by-agent/bot-2/profile.md",
          generationId: "g1",
          contentHash: "h1",
        },
      ],
      facts: [fact("Tim teaches on Tuesdays.")],
      omissions: [],
    },
    {
      type: "memory/written",
      ...turn,
      effectId: "e-1",
      action: "write",
      scope: "bot",
      groupId: "",
      tier: "log",
      path: "bot/log",
      generationId: "records",
      contentHash: "c1",
    },
    // Stand-ins for the two Project membership events, rewritten below into
    // the shapes an older Bot stored.
    { type: "step/start", turn: 1, step: 2 },
    { type: "step/start", turn: 1, step: 3 },
    // Large enough to be stored cut, with its exact bytes in payload chunks.
    {
      type: "memory/injected",
      turn: 1,
      sources: [],
      facts: Array.from({ length: 40 }, (_, index) =>
        fact(`${index} ${"x".repeat(480)}`),
      ),
      omissions: [],
    },
    { type: "turn/end", turn: 1, outcome: "completed" },
  ];
  return inputs.map((input, seq) =>
    decodeSessionEvent({
      ...input,
      seq,
      timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    }),
  );
}

function asProject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asProject);
  if (!value || typeof value !== "object") return value;
  const { groupId, ...rest } = value as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(rest).map(([key, item]) => [key, asProject(item)]),
  );
  return groupId === undefined ? mapped : { ...mapped, projectId: groupId };
}

/** A log exactly as a Bot stored it before Group Chats replaced Projects. */
async function projectEraLog(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await new SessionEventLog(storage).append(SESSION, events());
  const [pageKey, page] = [
    ...(await storage.list<{
      entries: Array<Record<string, any>>;
    }>({ prefix: sessionEventLogPagePrefixV1(SESSION) })),
  ][0]!;
  const at = (seq: number) =>
    page.entries.find(
      (entry) => (entry.event ?? entry.projection).seq === seq,
    )!;
  at(2).event = asProject(at(2).event);
  at(3).event = {
    ...(asProject(at(3).event) as object),
    scope: "project",
    projectId: "acme",
  };
  at(4).event = {
    type: "memory/project-intent",
    seq: 4,
    timestamp: at(4).event.timestamp,
    ...turn,
    effectId: "e-p",
    action: "create",
    projectId: "acme",
  };
  at(5).event = {
    type: "memory/project-changed",
    seq: 5,
    timestamp: at(5).event.timestamp,
    ...turn,
    effectId: "e-p",
    action: "create",
    projectId: "acme",
    projects: ["acme"],
  };
  const cut = at(6);
  expect(cut.storage).toBe("cut");
  const payloadPrefix = sessionEventPayloadPrefixV1(SESSION);
  const chunkKeys = [...storage.values.keys()].filter((key) =>
    key.startsWith(payloadPrefix),
  );
  const exact = JSON.parse(
    chunkKeys.map((key) => storage.values.get(key) as string).join(""),
  );
  const old = JSON.stringify(asProject(exact));
  for (const key of chunkKeys) storage.values.delete(key);
  storage.values.set(chunkKeys[0]!, old);
  cut.payload = {
    chunks: 1,
    bytes: new TextEncoder().encode(old).byteLength,
    sha256: await sha256HexTextV1(old),
  };
  storage.values.set(pageKey, page);
  await expect(new SessionEventLog(storage).read(SESSION)).rejects.toThrow();
  return storage;
}

test("a Project-era log reads again, every event in place", async () => {
  const storage = await projectEraLog();

  await cleanProjectEventsV1(storage);

  const read = await new SessionEventLog(storage).read(SESSION);
  expect(read.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(read[2]).toMatchObject({
    sources: [{ scope: "user", groupId: "" }],
    facts: [{ scope: "user", groupId: "" }],
  });
  expect(read[3]).toMatchObject({ scope: "group", groupId: "acme" });
  expect(read[4]).toMatchObject({
    type: "package/tool-call",
    packageId: "memory",
    callId: "e-p",
    name: "project_create",
    input: { project: "acme" },
  });
  expect(read[5]).toMatchObject({
    type: "package/tool-result",
    name: "project_create",
    content: "Projects: acme",
    isError: false,
  });
  const big = read[6];
  if (big?.type !== "memory/injected") throw new Error("unreachable");
  expect(big.facts).toHaveLength(40);
  expect(big.facts.every((fact) => fact.groupId === "")).toBe(true);
});

test("the walk runs once per object", async () => {
  const storage = await projectEraLog();
  await cleanProjectEventsV1(storage);
  const receipt = storage.values.get("maintenance:project-events:2026-09-23");
  expect(receipt).toMatchObject({ sessions: 1, events: 5, unreadable: [] });
  const before = new Map(storage.values);
  await cleanProjectEventsV1(storage);
  expect(storage.values).toEqual(before);
});

test("an event already in today's shape is left as it is", () => {
  for (const event of events()) {
    expect(
      withoutProjectShapesV1(event as unknown as Record<string, unknown>),
    ).toBeUndefined();
  }
});
