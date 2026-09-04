import {
  createClient,
  createContextKey,
  createInProcessHost,
  createPlugin,
  createStub,
  stubDeclarations,
} from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import {
  composerPrompt,
  createComposerTools,
  jsonSchemaValidator,
} from "../src";
import type { AnyComposerTool, ComposerResult } from "../src";
import type { SourceChecker } from "@frockbot/compose-core";

const tool = (
  tools: ReadonlyArray<AnyComposerTool>,
  name: string,
): AnyComposerTool => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`test: missing tool ${name}`);
  return found;
};

const run = async (
  tools: ReadonlyArray<AnyComposerTool>,
  name: string,
  args: unknown,
): Promise<ComposerResult> => await tool(tools, name).execute(args);

const markerChecker: SourceChecker = {
  check({ source }) {
    const line = source.split("\n").findIndex((part) => part.includes("NOPE"));
    return line === -1
      ? { code: source }
      : {
          diagnostics: [
            { message: "Cannot find name 'NOPE'.", line: line + 1, column: 3 },
          ],
        };
  },
};

describe("the framework-neutral composer definitions", () => {
  it("refuses every mutation of a protected id, including using it for a catalog addition", async () => {
    const fixed = createPlugin({
      name: "fixed",
      validator: jsonSchemaValidator<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      setup() {},
    });
    const client = createClient({ plugins: [{ id: "fixed", plugin: fixed }] });
    await client.settled();
    const tools = createComposerTools({
      client,
      catalog: { fixed },
      protected: ["fixed", "reserved"],
    });

    const results = await Promise.all([
      run(tools, "disable_plugin", { id: "fixed" }),
      run(tools, "configure_plugin", { id: "fixed", options: {} }),
      run(tools, "remove_plugin", { id: "fixed" }),
      run(tools, "add_from_catalog", {
        id: "reserved",
        name: "fixed",
        options: {},
      }),
    ]);

    expect(results.map((result) => result.ok)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(results.every((result) => result.error?.includes("protected"))).toBe(
      true,
    );
    expect(client.pluginList.state.map((entry) => entry.id)).toEqual(["fixed"]);
    await client.destroy();
  });

  it("lists status, protection, current options and described schemas", async () => {
    const banner = createPlugin({
      name: "banner",
      validator: jsonSchemaValidator<{ text: string }>({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      }),
      setup() {},
    });
    const missingKey = createContextKey("missing");
    const pending = createPlugin({
      name: "pending",
      deps: [missingKey],
      setup() {},
    });
    const client = createClient({
      plugins: [
        { id: "banner", plugin: banner, options: { text: "hello" } },
        { id: "pending", plugin: pending },
      ],
    });
    await client.settled();
    const result = await run(
      createComposerTools({
        client,
        catalog: { banner },
        protected: ["banner"],
      }),
      "list_plugins",
      {},
    );

    expect(result.entries[0]).toMatchObject({
      id: "banner",
      protected: true,
      options: { text: "hello" },
      optionsSchema: { type: "object" },
    });
    expect(result.catalogOptions?.banner).toEqual(
      result.entries[0]?.optionsSchema,
    );
    expect(result.entries[1]).toMatchObject({
      id: "pending",
      status: "pending",
    });
    await client.destroy();
  });

  it("adds, configures, disables, enables and removes catalog entries", async () => {
    const banner = createPlugin({
      name: "banner",
      validator: jsonSchemaValidator<{ text: string }>({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      }),
      setup() {},
    });
    const client = createClient();
    const tools = createComposerTools({ client, catalog: { banner } });

    expect(
      await run(tools, "add_from_catalog", {
        id: "notice",
        name: "banner",
        options: { text: "one" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await run(tools, "configure_plugin", {
        id: "notice",
        options: { text: "two" },
      }),
    ).toMatchObject({ ok: true });
    expect(await run(tools, "disable_plugin", { id: "notice" })).toMatchObject({
      ok: true,
    });
    expect(await run(tools, "enable_plugin", { id: "notice" })).toMatchObject({
      ok: true,
    });
    expect(await run(tools, "remove_plugin", { id: "notice" })).toMatchObject({
      ok: true,
      entries: [{ id: "notice", status: "removed" }],
    });
    await client.destroy();
  });

  it("refuses options for plugins without validators", async () => {
    const plain = createPlugin({ name: "plain", setup() {} });
    const client = createClient({ plugins: [{ id: "plain", plugin: plain }] });
    await client.settled();
    const tools = createComposerTools({ client, catalog: { plain } });

    expect(
      await run(tools, "configure_plugin", {
        id: "plain",
        options: { surprise: true },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await run(tools, "add_from_catalog", {
        id: "another",
        name: "plain",
        options: {},
      }),
    ).toMatchObject({ ok: false });
    await client.destroy();
  });

  it("checks, writes, reads, gates rewrites and removes one source entry", async () => {
    const client = createClient({
      checker: markerChecker,
      hosts: {
        "in-process": createInProcessHost({ grants: {} }),
      },
    });
    const tools = createComposerTools({
      client,
      host: "in-process",
    });
    const first =
      "export default function () {}\nexport const answer = () => 1";

    expect(
      await run(tools, "write_plugin", {
        id: "written",
        source: "export default function () { NOPE }",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ line: 1 }] });
    expect(
      await run(tools, "write_plugin", { id: "written", source: first }),
    ).toMatchObject({ ok: true });
    expect(
      await run(tools, "rewrite_plugin", {
        id: "written",
        source: first.replace("1", "2"),
      }),
    ).toMatchObject({ ok: false });
    expect(await run(tools, "read_plugin", { id: "written" })).toMatchObject({
      ok: true,
      source: first,
    });
    expect(
      await run(tools, "rewrite_plugin", {
        id: "written",
        source: first.replace("1", "2"),
      }),
    ).toMatchObject({ ok: true });
    expect(await client.callSource("written", "answer")).toBe(2);
    expect(await run(tools, "remove_plugin", { id: "written" })).toMatchObject({
      ok: true,
    });
    await client.destroy();
  });

  it("describes live protected ids and catalog names in the prompt", () => {
    const text = composerPrompt({
      protected: ["loop"],
      catalog: { plain: createPlugin({ name: "plain", setup() {} }) },
    });
    expect(text).toContain("Protected entries: loop.");
    expect(text).toContain("The catalog offers: plain.");
    expect(text).toContain("next turn");
  });

  it("checks source against exactly the granted stubs and publishes those declarations", async () => {
    const granted = createStub({
      name: "granted",
      declarations: "declare const granted: () => Promise<string>",
      handler: () => "yes",
    });
    const withheld = createStub({
      name: "withheld",
      declarations: "declare const withheld: () => Promise<string>",
      handler: () => "no",
    });
    const checks: Array<{
      grants: ReadonlyArray<{ name: string; declarations: string }>;
      declarations: string;
    }> = [];
    const declarationCalls: Array<
      ReadonlyArray<{ name: string; declarations: string }>
    > = [];
    const checker: SourceChecker = {
      declarations(grants) {
        declarationCalls.push(grants);
        return `checked:\n${grants
          .map((grant) => grant.declarations)
          .join("\n")}`;
      },
      check(input) {
        checks.push({
          grants: input.grants,
          declarations: input.declarations,
        });
        return { code: input.source };
      },
    };
    const client = createClient({
      checker,
      hosts: { "in-process": createInProcessHost({ grants: {} }) },
    });
    const tools = createComposerTools({ client, stubs: [granted] });

    const listed = await run(tools, "list_plugins", {});
    const written = await run(tools, "write_plugin", {
      id: "written",
      source: "export default function () {}",
    });
    const read = await run(tools, "read_plugin", { id: "written" });

    const expected = [
      { name: granted.name, declarations: granted.declarations },
    ];
    expect(declarationCalls).toEqual([expected, expected]);
    expect(checks).toHaveLength(2);
    expect(checks).toEqual(
      checks.map(() => ({
        grants: expected,
        declarations: stubDeclarations([granted]),
      })),
    );
    expect(listed.declarations).toContain(granted.declarations);
    expect(listed.declarations).not.toContain(withheld.declarations);
    expect(written.ok).toBe(true);
    expect(read.declarations).toBe(listed.declarations);
    await client.destroy();
  });
});
