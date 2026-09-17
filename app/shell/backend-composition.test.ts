// An Applet member contributes no module and nothing to health-check, so the
// only thing this seam does with it is register its tools. What matters is
// *which* generation those tools reach: the description handed to the model
// names the pinned generation, and the call names it too, so the Applet
// Durable Object executes that generation or refuses. A DTO that carried only
// the Applet id let a publish landing mid-Turn run new code behind the schema
// and provenance the model was shown.
import { describe, expect, test } from "bun:test";
import {
  cardSurfacePrefixV1,
  decodePluginDescriptorV1,
  decodeSendToUserPayloadV1,
  ISOLATE_CONTRACT_VERSION,
  type BotCapabilitiesStub,
  type PluginWorkerEntrypoint,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionAppletMemberV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import type { BotIsolateLoader } from "@frockbot/frock-compose";
import {
  createShellCompositionHost,
  type ShellMountedComposition,
} from "./backend-composition.js";
import { approvalKeyV1 } from "./approvals.js";
import {
  CARD_APPROVAL_BINDING_PREFIX,
  cardApprovalBindingKeyV1,
  cardValuesDigestV1,
  createCardApprovalStoreV1,
  type CardApprovalStoreV1,
} from "./cards.js";

const USER = "user-1";
const APPLET = "applet-1";

const APPLET_MEMBER: CompositionAppletMemberV1 = {
  kind: "applet",
  appletId: APPLET,
  generationId: "2026-09-05T00:00:00.000Z:A",
  tools: [
    {
      name: "add_todo",
      description: "Add a todo",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  ],
  provenance: {
    kind: "user",
    packageId: APPLET,
    version: "2026-09-05T00:00:00.000Z:A",
    userId: USER,
    authoredAt: "2026-09-05T00:00:00.000Z",
  },
  ownerBotId: "bot-1",
  sharedWithBotIds: ["bot-2"],
};

async function generationWithApplet(
  applets: CompositionAppletMemberV1[] = [APPLET_MEMBER],
): Promise<CompositionGenerationV1> {
  const members: CompositionMemberV1[] = [];
  const artifactSetHash = await compositionArtifactSetHashV1(members, applets);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-05T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    applets,
    status: "active",
  });
}

describe("Applet tools mounted into a Turn's Composition", () => {
  test("the call carries the generation the Turn pinned, not just the Applet id", async () => {
    const calls: Array<{ appletId: string; generationId: string }> = [];
    const generation = await generationWithApplet();
    const { signal } = new AbortController();
    const mounted = await createShellCompositionHost({
      botId: "bot-1",
      sessionId: `${USER}:bot-1`,
      sessionEvents: [],
      admitEffect: () => Promise.resolve(true),
      applets: {
        invokeTool: (request) => {
          calls.push({
            appletId: request.appletId,
            generationId: request.generationId,
          });
          return Promise.resolve({ status: "ok" as const, content: "added" });
        },
      },
    }).mount(generation, signal);
    try {
      await mounted.verify(signal);
      const schema = mounted.runtime.services.tools
        .schemas({ turnType: "chat" })
        .find((entry) => entry.name === "add_todo");
      expect(schema).toBeDefined();
      // The pin the model is shown, and the pin the call carries, are one
      // string. If they ever diverge the Turn stops being reconstructable.
      expect(schema?.description).toContain(APPLET_MEMBER.generationId);

      const call = { id: "call-1", name: "add_todo", input: { title: "milk" } };
      const context = {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId: `${USER}:bot-1`,
        compositionGenerationId: generation.generationId,
        effectId: "effect-1",
        toolCall: call,
        turnType: "chat" as const,
        signal,
      };
      const prepared = await mounted.runtime.services.tools.prepare(
        call,
        context,
      );
      expect(prepared.kind).toBe("ready");
      const outcome = await mounted.runtime.services.tools.executePrepared(
        prepared as Extract<typeof prepared, { kind: "ready" }>,
        context,
      );
      expect(outcome).toMatchObject({ isError: false });
      expect(calls).toEqual([
        { appletId: APPLET, generationId: APPLET_MEMBER.generationId },
      ]);
    } finally {
      await mounted.dispose();
    }
  });

  // The generation is the User's and names every available Applet, so the
  // mount is where a Bot's access is applied — from the access the generation
  // pinned, not from whatever the directory says mid-Turn (ADR 0027).
  test("registers only the Applets the mounting Bot owns or is shared", async () => {
    const generation = await generationWithApplet([
      APPLET_MEMBER,
      {
        ...APPLET_MEMBER,
        appletId: "applet-2",
        tools: [{ ...APPLET_MEMBER.tools[0]!, name: "other_bots_tool" }],
        ownerBotId: "bot-3",
        sharedWithBotIds: [],
      },
    ]);
    const { signal } = new AbortController();
    for (const [botId, expected] of [
      ["bot-1", ["add_todo"]],
      ["bot-2", ["add_todo"]],
      ["bot-3", ["other_bots_tool"]],
      ["bot-4", []],
    ] as const) {
      const mounted = await createShellCompositionHost({
        botId,
        sessionId: `${USER}:${botId}`,
        sessionEvents: [],
        admitEffect: () => Promise.resolve(true),
        applets: {
          invokeTool: () =>
            Promise.resolve({ status: "ok" as const, content: "ok" }),
        },
      }).mount(generation, signal);
      try {
        await mounted.verify(signal);
        const names = mounted.runtime.services.tools
          .schemas({ turnType: "chat" })
          .map((entry) => entry.name)
          .filter((name) => name === "add_todo" || name === "other_bots_tool");
        expect(names).toEqual([...expected]);
      } finally {
        await mounted.dispose();
      }
    }
  });
});

function pluginMember(id: string, contentHash: string): CompositionMemberV1 {
  return {
    packageId: id,
    version: "0.0.1",
    provenance: {
      kind: "user",
      packageId: id,
      version: "0.0.1",
      userId: USER,
      authoredAt: "2026-09-05T00:00:00.000Z",
    },
    artifact: {
      contentHash,
      size: 32,
      mediaType: "application/javascript",
      bundlerVersion: "1",
    },
    descriptor: decodePluginDescriptorV1({
      id,
      displayName: id,
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        {
          name: `${id}_tool`,
          description: `${id} tool`,
          inputSchema: { type: "object" },
        },
      ],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    }),
  };
}

async function generationWithPlugins(): Promise<CompositionGenerationV1> {
  const members = [
    pluginMember("good", "a".repeat(64)),
    pluginMember("bad", "b".repeat(64)),
  ];
  const artifactSetHash = await compositionArtifactSetHashV1(members, []);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-05T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-05T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    status: "active",
  });
}

describe("a Plugin that the worker refuses", () => {
  // ADR 0026: a Plugin whose report differs from its descriptor fails alone.
  // Escalating that to the generation would quarantine nine healthy Plugins
  // because a tenth mis-declared one tool.
  test("fails alone: the generation still verifies and its siblings still mount", async () => {
    const generation = await generationWithPlugins();
    const { signal } = new AbortController();
    const entrypoint: PluginWorkerEntrypoint = {
      health: () =>
        Promise.resolve({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: [
            {
              pluginId: "good",
              ok: true,
              tools: [
                {
                  name: "good_tool",
                  description: "good tool",
                  inputSchema: { type: "object" },
                  idempotent: true,
                },
              ],
              hooks: [],
              provides: [],
              consumes: [],
              triggers: [],
              views: [],
              cards: [],
            },
            {
              pluginId: "bad",
              ok: false,
              reason: 'plugin "bad" must export an "execute" function',
              tools: [],
              hooks: [],
              provides: [],
              consumes: [],
              triggers: [],
              views: [],
              cards: [],
            },
          ],
        }),
      hook: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "unchanged",
          failures: [],
        }),
      execute: () =>
        Promise.resolve({ schemaVersion: 1, content: "ok", isError: false }),
      receiveTrigger: () =>
        Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
      cardAction: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          reason: "no card handlers",
        }),
      view: () =>
        Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          reason: "no cards",
        }),
    };
    const loader: BotIsolateLoader = {
      get: () => ({ getEntrypoint: () => entrypoint }),
    };
    const mounted = await createShellCompositionHost({
      botId: "bot-1",
      sessionId: `${USER}:bot-1`,
      sessionEvents: [],
      admitEffect: () => Promise.resolve(true),
      isolate: {
        userId: USER,
        runId: "run-1",
        turnId: "run-1",
        loader,
        artifacts: {
          loadPackageArtifact: () =>
            Promise.resolve("export const tools = [];"),
        },
        capabilities: {} as BotCapabilitiesStub,
        bindingDigest: "c".repeat(64),
        compatibilityDate: "2026-01-01",
      },
    }).mount(generation, signal);
    try {
      await mounted.verify(signal);
      expect(
        mounted.pluginFailures.map((failure) => [
          failure.pluginId,
          failure.phase,
        ]),
      ).toEqual([["bad", "health"]]);
      const names = mounted.runtime.services.tools.registeredNames?.() ?? [];
      expect(names).toContain("good/good_tool");
      expect(names).not.toContain("bad/bad_tool");
    } finally {
      await mounted.dispose();
    }
  });
});

/**
 * One draft, one live decision, and a decision that says what it covers.
 *
 * `bindCardApprovalsV1` mints an Approval for every `ApprovalActions` on
 * every send, so without the binding a redraw of a surface whose decision is
 * still pending left two live Approvals over one draft, and an Approval
 * carried nothing that said which card it was given on.
 */
describe("the Approvals a Plugin's Card asks for", () => {
  const CARD_PLUGIN = "drafts";

  function cardMember(): CompositionMemberV1 {
    return {
      packageId: CARD_PLUGIN,
      version: "0.0.1",
      provenance: {
        kind: "user",
        packageId: CARD_PLUGIN,
        version: "0.0.1",
        userId: USER,
        authoredAt: "2026-09-05T00:00:00.000Z",
      },
      artifact: {
        contentHash: "d".repeat(64),
        size: 32,
        mediaType: "application/javascript",
        bundlerVersion: "1",
      },
      descriptor: decodePluginDescriptorV1({
        id: CARD_PLUGIN,
        displayName: CARD_PLUGIN,
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [],
        hooks: [],
        grants: [],
        cards: [
          {
            id: "draft",
            displayName: "Draft",
            description: "Asks the person to decide.",
            dataSchema: {
              type: "object",
              properties: { subject: { type: "string" } },
              required: ["subject"],
              additionalProperties: false,
            },
            actions: [],
          },
        ],
        contextKeys: ["user", "bot", "session"],
      }),
    };
  }

  async function cardGeneration(): Promise<CompositionGenerationV1> {
    const members = [cardMember()];
    const artifactSetHash = await compositionArtifactSetHashV1(members, []);
    return decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: `2026-09-05T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
      artifactSetHash,
      createdAt: "2026-09-05T00:00:00.000Z",
      origin: { kind: "bootstrap" },
      members,
      status: "active",
    });
  }

  function cardEntrypoint(options?: {
    /** What the drawn card says its decision covers, whatever the Bot sent. */
    covers?: Record<string, unknown>;
    /** A draw that asks for a decision and declares nothing it covers. */
    declaresNothing?: true;
    /** A draw that asks for a decision and says nothing about what it asks. */
    saysNothing?: true;
  }): PluginWorkerEntrypoint {
    return {
      health: () =>
        Promise.resolve({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: [
            {
              pluginId: CARD_PLUGIN,
              ok: true,
              tools: [],
              hooks: [],
              provides: [],
              consumes: [],
              triggers: [],
              views: [],
              cards: ["draft"],
            },
          ],
        }),
      hook: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "unchanged",
          failures: [],
        }),
      execute: () =>
        Promise.resolve({ schemaVersion: 1, content: "ok", isError: false }),
      receiveTrigger: () =>
        Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
      cardAction: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          reason: "no card handlers",
        }),
      view: () =>
        Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
      // Whatever the values are, the surface the Plugin draws asks for a
      // decision — which is exactly the redraw the binding has to hold. What
      // it says that decision covers is the Plugin's own word, as a real one's
      // is: by default the values it was handed, or a fixed draft when the
      // test is about a Plugin that redraws what it is holding.
      renderCard: (invocation: {
        surfaceId: string;
        data: Record<string, unknown>;
      }) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          ...(options?.declaresNothing
            ? {}
            : { covers: options?.covers ?? invocation.data }),
          ...(options?.saysNothing
            ? {}
            : {
                decision: {
                  action: "Send the draft",
                  risk: "medium" as const,
                },
              }),
          messages: [
            {
              version: "v1.0",
              createSurface: {
                surfaceId: invocation.surfaceId,
                components: [
                  { id: "root", component: "Column", children: ["actions"] },
                  {
                    id: "actions",
                    component: "ApprovalActions",
                    approvalId: "not-the-kernels",
                    approveLabel: "Send",
                    declineLabel: "Discard",
                  },
                ],
              },
            },
          ],
        }),
    } as unknown as PluginWorkerEntrypoint;
  }

  /** The Bot's storage, as the Durable Object's own card approval store. */
  function cardApprovalStorage() {
    const values = new Map<string, unknown>();
    return {
      values,
      store: createCardApprovalStoreV1({
        get: <T,>(key: string) => Promise.resolve(values.get(key) as T),
        put: (key: string, value: unknown) => {
          values.set(key, value);
          return Promise.resolve();
        },
      }),
    };
  }

  /** What the Turn that drew the card writes when it settles. */
  function recordPendingApproval(
    values: Map<string, unknown>,
    approvalId: string,
  ): void {
    values.set(approvalKeyV1(approvalId), {
      schemaVersion: 1,
      approvalId,
      runId: "run-1",
      sessionId: `${USER}:bot-1`,
      action: "Send the draft",
      risk: "medium",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      decision: "pending",
      decidedBy: "pending",
    });
  }

  async function mountCards(
    store: CardApprovalStoreV1,
    options?: Parameters<typeof cardEntrypoint>[0],
    // Which of this Bot's Sessions draws. One Bot holds many — every Routine
    // gets its own — while its card and Approval records are Bot-wide.
    sessionId: string = `${USER}:bot-1`,
  ) {
    const generation = await cardGeneration();
    const { signal } = new AbortController();
    const entrypoint = cardEntrypoint(options);
    const mounted = await createShellCompositionHost({
      botId: "bot-1",
      sessionId,
      sessionEvents: [],
      admitEffect: () => Promise.resolve(true),
      cardApprovals: store,
      isolate: {
        userId: USER,
        runId: "run-1",
        turnId: "run-1",
        loader: { get: () => ({ getEntrypoint: () => entrypoint }) },
        artifacts: {
          loadPackageArtifact: () =>
            Promise.resolve("export const tools = [];"),
        },
        capabilities: {} as BotCapabilitiesStub,
        bindingDigest: "e".repeat(64),
        compatibilityDate: "2026-01-01",
      },
    }).mount(generation, signal);
    await mounted.verify(signal);
    // A send is recorded against the Turn's open step, which is what the
    // loop opens before it dispatches a tool call.
    mounted.runtime.services.sessions
      .get(sessionId)
      ?.append({ type: "step/start", turn: 1, step: 1 });
    let effect = 0;
    const draw = async (
      input: Record<string, unknown>,
      // The effect the call is recorded under. Named by a test that replays
      // one tool call the way an interrupted Turn does.
      effectId?: string,
    ) => {
      effect += 1;
      // A Plugin's tools live in its own namespace, so the Bot reaches one
      // through the registry's dynamic call, exactly as the model does.
      const call = {
        id: `call-${effect}`,
        name: "call_dynamic_tool",
        input: {
          namespace: CARD_PLUGIN,
          toolName: `${CARD_PLUGIN}_draft`,
          arguments: input,
        },
      };
      const context = {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId,
        compositionGenerationId: generation.generationId,
        effectId: effectId ?? `effect-${effect}`,
        toolCall: call,
        turnType: "chat" as const,
        signal,
      };
      const prepared = await mounted.runtime.services.tools.prepare(
        call,
        context,
      );
      return mounted.runtime.services.tools.executePrepared(
        prepared as Extract<typeof prepared, { kind: "ready" }>,
        context,
      );
    };
    return { mounted, draw, signal, sessionId };
  }

  /** Every approval send the Turn's log carries, in order. */
  function approvalIdsOnLog(
    mounted: ShellMountedComposition,
    sessionId: string = `${USER}:bot-1`,
  ): string[] {
    const session = mounted.runtime.services.sessions.get(sessionId);
    return (session?.events ?? [])
      .filter(
        (event) =>
          event.type === "send/to-user" &&
          (event as { payload?: { type?: string } }).payload?.type ===
            "approval",
      )
      .map(
        (event) =>
          (event as unknown as { payload: { approvalId: string } }).payload
            .approvalId,
      );
  }

  /** Every card surface the Turn's log carries, in order. */
  function cardSurfaceIdsOnLog(
    mounted: ShellMountedComposition,
    sessionId: string = `${USER}:bot-1`,
  ): string[] {
    const session = mounted.runtime.services.sessions.get(sessionId);
    return (session?.events ?? [])
      .filter(
        (event) =>
          event.type === "send/to-user" &&
          (event as { payload?: { type?: string } }).payload?.type === "card",
      )
      .map(
        (event) =>
          (event as unknown as { payload: { surfaceId: string } }).payload
            .surfaceId,
      );
  }

  /** The approvalId the card in the conversation actually points at. */
  function cardApprovalId(mounted: ShellMountedComposition): string {
    const session = mounted.runtime.services.sessions.get(`${USER}:bot-1`);
    const cards = (session?.events ?? []).filter(
      (event) =>
        event.type === "send/to-user" &&
        (event as { payload?: { type?: string } }).payload?.type === "card",
    );
    const last = cards.at(-1) as unknown as {
      payload: {
        messages: {
          createSurface?: { components: { id: string; approvalId?: string }[] };
        }[];
      };
    };
    const actions = last.payload.messages[0]!.createSurface!.components.find(
      (component) => component.id === "actions",
    );
    return actions?.approvalId ?? "";
  }

  /** Every surface this Bot has recorded a binding for. */
  function bindingKeys(values: Map<string, unknown>): string[] {
    return [...values.keys()].filter((key) =>
      key.startsWith(CARD_APPROVAL_BINDING_PREFIX),
    );
  }

  /** The binding this surface's decision is recorded under, as stored. */
  function bindingFor(
    values: Map<string, unknown>,
    surfaceId: string,
  ): { digest: string; approvalIds: string[] } | undefined {
    return values.get(cardApprovalBindingKeyV1(CARD_PLUGIN, surfaceId)) as
      | { digest: string; approvalIds: string[] }
      | undefined;
  }

  test("a replayed card tool call asks for the one decision it already asked for", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store);
    try {
      // The same call, twice, under the one effect id: what an interrupted
      // Turn does on resume, because only a call whose journal entry already
      // holds a result is skipped.
      const surfaceId = `${cardSurfacePrefixV1(CARD_PLUGIN, "draft")}replayed`;
      const input = { data: { subject: "Hello" }, surfaceId };
      const first = await draw(input, "effect-replay");
      expect(first).toMatchObject({ isError: false, endsTurn: true });
      const again = await draw(input, "effect-replay");
      expect(again).toMatchObject({ isError: false, endsTurn: true });

      // One ask, one binding, and the button the person can press is the id
      // the binding names — not a second decision nobody was ever asked for.
      const asked = approvalIdsOnLog(mounted);
      expect(asked).toHaveLength(1);
      const binding = bindingFor(values, surfaceId);
      expect(binding?.approvalIds).toEqual(asked);
      expect(cardApprovalId(mounted)).toBe(asked[0]!);
    } finally {
      await mounted.dispose();
    }
  });

  test("two Sessions of one Bot drawing at the same step draw two cards", async () => {
    // Every Routine of a Bot has its own Session and every Session starts at
    // turn 1, so the same effect id is drawn twice on one Bot — while the card
    // and Approval records those draws land in are Bot-wide.
    const { store } = cardApprovalStorage();
    const chat = await mountCards(store, undefined, `${USER}:bot-1`);
    const routine = await mountCards(store, undefined, "routine:r-1");
    try {
      const input = { data: { subject: "Hello" } };
      const surfaceOf = (result: { content?: unknown }) =>
        /surface "([^"]+)"/.exec(String(result.content))![1]!;
      const first = surfaceOf(await chat.draw(input, "tool:1:1:0"));
      const second = surfaceOf(await routine.draw(input, "tool:1:1:0"));
      expect(second).not.toBe(first);

      const asked = approvalIdsOnLog(chat.mounted, chat.sessionId);
      const alsoAsked = approvalIdsOnLog(routine.mounted, routine.sessionId);
      expect(asked).toHaveLength(1);
      expect(alsoAsked).toHaveLength(1);
      expect(alsoAsked[0]).not.toBe(asked[0]);
    } finally {
      await chat.mounted.dispose();
      await routine.mounted.dispose();
    }
  });

  test("a replayed draw of an unnamed surface redraws the surface it minted", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store);
    try {
      // The Bot names no surface, so the kernel mints one. An interrupted Turn
      // re-runs the same call under the same effect id, and a second minted
      // surface would leave the card the person is looking at stranded with a
      // live-looking button while the Bot settled a card nobody can see.
      const input = { data: { subject: "Hello" } };
      const first = await draw(input, "effect-minted");
      const again = await draw(input, "effect-minted");
      const surfaceOf = (result: { content?: unknown }) =>
        /surface "([^"]+)"/.exec(String(result.content))![1]!;
      const surfaceId = surfaceOf(first);
      expect(surfaceOf(again)).toBe(surfaceId);
      expect(surfaceId.startsWith(cardSurfacePrefixV1(CARD_PLUGIN, "draft"))).toBe(
        true,
      );

      const asked = approvalIdsOnLog(mounted);
      expect(asked).toHaveLength(1);
      expect(cardSurfaceIdsOnLog(mounted)).toEqual([surfaceId]);
      expect(bindingKeys(values)).toEqual([
        cardApprovalBindingKeyV1(CARD_PLUGIN, surfaceId),
      ]);
      expect(bindingFor(values, surfaceId)?.approvalIds).toEqual(asked);
      expect(cardApprovalId(mounted)).toBe(asked[0]!);
    } finally {
      await mounted.dispose();
    }
  });

  test("a decision is bound to what the Plugin drew, not to what the Bot sent", async () => {
    const { values, store } = cardApprovalStorage();
    // A Plugin that redraws the draft it is holding and ignores the values
    // the model passed — which is what the email card does.
    const held = { subject: "The draft it is holding" };
    const { mounted, draw } = await mountCards(store, { covers: held });
    try {
      const first = await draw({ data: { subject: "Something else" } });
      const surfaceId = /surface "([^"]+)"/.exec(String(first.content))![1]!;
      expect(bindingFor(values, surfaceId)?.digest).toBe(
        await cardValuesDigestV1(held),
      );
    } finally {
      await mounted.dispose();
    }
  });

  test("a card asking for a decision it declares nothing about is refused", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store, {
      declaresNothing: true,
    });
    try {
      const drawn = await draw({ data: { subject: "Hello" } });
      expect(drawn.isError).toBe(true);
      expect(String(drawn.content)).toMatch(/without declaring the values/);
      // Nothing was recorded: no card, no decision, no binding.
      expect(approvalIdsOnLog(mounted)).toEqual([]);
      expect(bindingKeys(values)).toEqual([]);
      const session = mounted.runtime.services.sessions.get(`${USER}:bot-1`);
      expect(
        (session?.events ?? []).filter(
          (event) => event.type === "send/to-user",
        ),
      ).toEqual([]);
    } finally {
      await mounted.dispose();
    }
  });

  test("a card asking for a decision it says nothing about is refused", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store, { saysNothing: true });
    try {
      const drawn = await draw({ data: { subject: "Hello" } });
      expect(drawn.isError).toBe(true);
      expect(String(drawn.content)).toMatch(
        /without declaring what that decision asks/,
      );
      expect(approvalIdsOnLog(mounted)).toEqual([]);
      expect(bindingKeys(values)).toEqual([]);
    } finally {
      await mounted.dispose();
    }
  });

  // The model may choose any `approvalId` a `send_to_user` approval accepts,
  // and those records share one storage namespace with a Card's. So a Card's
  // id has to be one no accepted `send_to_user` could have spelled, and one
  // nobody outside this Bot could have computed.
  test("mints a decision id no send_to_user approval could have asked for", async () => {
    const first = cardApprovalStorage();
    const mountedFirst = await mountCards(first.store);
    let minted: string;
    try {
      await mountedFirst.draw({ data: { subject: "Hello" } }, "effect-1");
      minted = approvalIdsOnLog(mountedFirst.mounted)[0]!;
    } finally {
      await mountedFirst.mounted.dispose();
    }
    // Nothing a model sends may land on that id.
    expect(() =>
      decodeSendToUserPayloadV1({
        type: "approval",
        approvalId: minted,
        action: "Check the weather for you?",
        risk: "low",
      }),
    ).toThrow("that namespace is the kernel's");

    // And it is not a function of the effect: another Bot's storage draws the
    // same card under the same effect id and lands somewhere else entirely.
    const second = cardApprovalStorage();
    const mountedSecond = await mountCards(second.store);
    try {
      await mountedSecond.draw({ data: { subject: "Hello" } }, "effect-1");
      expect(approvalIdsOnLog(mountedSecond.mounted)[0]).not.toBe(minted);
    } finally {
      await mountedSecond.mounted.dispose();
    }
  });

  test("a redraw of the same values keeps the one decision already pending", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store);
    try {
      const first = await draw({ data: { subject: "Hello" } });
      expect(first).toMatchObject({ isError: false, endsTurn: true });
      const surfaceId = /surface "([^"]+)"/.exec(String(first.content))![1]!;
      const minted = approvalIdsOnLog(mounted);
      expect(minted).toHaveLength(1);
      expect(cardApprovalId(mounted)).toBe(minted[0]!);
      // The Turn settles, so the pending decision is now durable.
      recordPendingApproval(values, minted[0]!);

      const again = await draw({ data: { subject: "Hello" }, surfaceId });
      expect(again).toMatchObject({ isError: false });
      // One draft, one live decision: nothing new was asked for, and the
      // card the person is looking at still points at the decision they
      // were given.
      expect(approvalIdsOnLog(mounted)).toEqual(minted);
      expect(cardApprovalId(mounted)).toBe(minted[0]!);
    } finally {
      await mounted.dispose();
    }
  });

  test("a redraw with different values is refused while that decision is pending", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store);
    try {
      const first = await draw({ data: { subject: "Hello" } });
      const surfaceId = /surface "([^"]+)"/.exec(String(first.content))![1]!;
      const minted = approvalIdsOnLog(mounted);
      recordPendingApproval(values, minted[0]!);

      const changed = await draw({ data: { subject: "Something else" }, surfaceId });
      expect(changed.isError).toBe(true);
      expect(String(changed.content)).toMatch(/decision still pending/);
      // The card stands exactly as it was, and no second decision was asked.
      expect(approvalIdsOnLog(mounted)).toEqual(minted);
      expect(cardApprovalId(mounted)).toBe(minted[0]!);
    } finally {
      await mounted.dispose();
    }
  });

  test("a decided surface asks again, because nothing is pending on it", async () => {
    const { values, store } = cardApprovalStorage();
    const { mounted, draw } = await mountCards(store);
    try {
      const first = await draw({ data: { subject: "Hello" } });
      const surfaceId = /surface "([^"]+)"/.exec(String(first.content))![1]!;
      const minted = approvalIdsOnLog(mounted);
      recordPendingApproval(values, minted[0]!);
      const decided = values.get(approvalKeyV1(minted[0]!)) as {
        decision: string;
      };
      decided.decision = "denied";

      const again = await draw({ data: { subject: "Hello" }, surfaceId });
      expect(again).toMatchObject({ isError: false });
      const now = approvalIdsOnLog(mounted);
      expect(now).toHaveLength(2);
      expect(now[1]).not.toBe(minted[0]);
      expect(cardApprovalId(mounted)).toBe(now[1]!);
    } finally {
      await mounted.dispose();
    }
  });
});
