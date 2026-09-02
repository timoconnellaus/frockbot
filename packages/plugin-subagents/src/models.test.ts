import { describe, expect, test } from "bun:test";
import {
  renderAvailableSubagentModelsPromptV1,
  resolveSubagentModelV1,
  subagentModelCatalogV1,
  subagentModelSlugV1,
} from "./models.js";
import type { TaskModelBindingV1 } from "./records.js";

function assignment(
  packageId: string,
  providerModelId: string,
  assignmentId = `asg-${providerModelId}`,
): TaskModelBindingV1 {
  return {
    assignmentId,
    packageId,
    capabilityId: `${packageId}-models`,
    connectionId: `conn-${assignmentId}`,
    provider: packageId,
    providerModelId,
  };
}

const DEFAULT = assignment("provider-ollama-cloud", "glm-5.3-flash:cloud");
const SECOND = assignment("provider-foundation", "sand-automation");

describe("the slug", () => {
  test("is the Package and the provider model, and nothing else", () => {
    expect(subagentModelSlugV1(DEFAULT)).toBe(
      "provider-ollama-cloud/glm-5.3-flash:cloud",
    );
  });
});

describe("the catalog one Turn is offered", () => {
  test("is built from the Bot's model bindings, default first", () => {
    const catalog = subagentModelCatalogV1({
      bindings: [SECOND, DEFAULT],
      defaultBinding: DEFAULT,
      turnType: "chat",
    });
    expect(catalog.map((option) => option.slug)).toEqual([
      "provider-ollama-cloud/glm-5.3-flash:cloud",
      "provider-foundation/sand-automation",
    ]);
    expect(catalog[0]?.isDefault).toBe(true);
    expect(catalog[1]?.isDefault).toBe(false);
  });

  test("keeps one entry per slug when two bindings name one model", () => {
    const twin = assignment(
      "provider-ollama-cloud",
      "glm-5.3-flash:cloud",
      "asg-twin",
    );
    expect(
      subagentModelCatalogV1({
        bindings: [DEFAULT, twin],
        defaultBinding: DEFAULT,
        turnType: "chat",
      }),
    ).toHaveLength(1);
  });

  test("renders exactly one slug on an automation turn — the Bot's own binding", () => {
    for (const turnType of ["automation", "subagent"] as const) {
      const catalog = subagentModelCatalogV1({
        bindings: [SECOND, DEFAULT],
        defaultBinding: DEFAULT,
        turnType,
      });
      expect(catalog.map((option) => option.slug)).toEqual([
        "provider-ollama-cloud/glm-5.3-flash:cloud",
      ]);
    }
  });

  test("is empty for a Bot with no configured model", () => {
    expect(subagentModelCatalogV1({ bindings: [], turnType: "chat" })).toEqual(
      [],
    );
  });
});

describe("resolving a `Task` model against the catalog", () => {
  const catalog = subagentModelCatalogV1({
    bindings: [SECOND, DEFAULT],
    defaultBinding: DEFAULT,
    turnType: "chat",
  });

  test("an omitted model inherits the parent's binding", () => {
    const resolved = resolveSubagentModelV1(catalog, undefined);
    expect(resolved).toMatchObject({
      status: "resolved",
      model: { slug: "provider-ollama-cloud/glm-5.3-flash:cloud" },
    });
  });

  test("a named slug resolves to the binding that carries it", () => {
    const resolved = resolveSubagentModelV1(
      catalog,
      "provider-foundation/sand-automation",
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      model: { binding: { assignmentId: SECOND.assignmentId } },
    });
  });

  test("a slug the Turn was not offered is refused, with the list it was", () => {
    const resolved = resolveSubagentModelV1(catalog, "anthropic/opus");
    expect(resolved).toMatchObject({ status: "refused" });
    expect(resolved.status === "refused" && resolved.reason).toContain(
      "provider-ollama-cloud/glm-5.3-flash:cloud",
    );
  });

  test("an automation turn refuses the second slug it was not shown", () => {
    const narrowed = subagentModelCatalogV1({
      bindings: [SECOND, DEFAULT],
      defaultBinding: DEFAULT,
      turnType: "automation",
    });
    expect(
      resolveSubagentModelV1(narrowed, "provider-foundation/sand-automation"),
    ).toMatchObject({ status: "refused" });
  });

  test("a Bot with no configured model is refused rather than defaulted", () => {
    expect(resolveSubagentModelV1([], undefined)).toMatchObject({
      status: "refused",
    });
    expect(resolveSubagentModelV1([], "anything/at-all")).toMatchObject({
      status: "refused",
    });
  });
});

describe("<available_subagent_models>", () => {
  test("renders one element per slug and marks the default", () => {
    const rendered = renderAvailableSubagentModelsPromptV1(
      subagentModelCatalogV1({
        bindings: [SECOND, DEFAULT],
        defaultBinding: DEFAULT,
        turnType: "chat",
      }),
    );
    expect(rendered).toContain("<available_subagent_models>");
    expect(rendered).toContain(
      '<model slug="provider-ollama-cloud/glm-5.3-flash:cloud" provider="provider-ollama-cloud" default="true" />',
    );
    expect(rendered).toContain(
      '<model slug="provider-foundation/sand-automation" provider="provider-foundation" />',
    );
  });

  test("renders exactly one model line on an automation turn", () => {
    const rendered = renderAvailableSubagentModelsPromptV1(
      subagentModelCatalogV1({
        bindings: [SECOND, DEFAULT],
        defaultBinding: DEFAULT,
        turnType: "automation",
      }),
    );
    expect(
      rendered.split("\n").filter((line) => line.includes("<model ")),
    ).toHaveLength(1);
  });

  test("renders nothing at all for an empty catalog", () => {
    expect(renderAvailableSubagentModelsPromptV1([])).toBe("");
  });
});
