import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Input,
  KIT_CSS,
  List,
  ListItem,
  Select,
  Stack,
  Text,
  Textarea,
  Toolbar,
} from "../src/kit/index.js";
import { lintCssText } from "../src/lint/index.js";

describe("the kit renders", () => {
  it("every component, with its semantic hooks intact", () => {
    const markup = renderToStaticMarkup(
      <Stack root gap="large">
        <Toolbar end={<Button variant="primary">Add</Button>}>
          <Text size="title">Todos</Text>
        </Toolbar>
        <Card title="New">
          <Input label="Title" value="milk" onValueChange={() => {}} />
          <Textarea label="Note" value="" onValueChange={() => {}} />
          <Select
            label="Priority"
            options={[{ value: "1", label: "High" }]}
            onValueChange={() => {}}
          />
        </Card>
        <List>
          <ListItem
            start={<Checkbox checked onChange={() => {}} ariaLabel="Done" />}
            end={<Badge tone="accent">2</Badge>}
            onClick={() => {}}
          >
            <Text>milk</Text>
          </ListItem>
        </List>
        <EmptyState title="Nothing yet" description="Add a todo." />
        <Dialog
          open
          title="Confirm"
          onClose={() => {}}
          actions={<Button>OK</Button>}
        >
          <Text tone="muted">Sure?</Text>
        </Dialog>
      </Stack>,
    );

    for (const hook of [
      "fb-root",
      "fb-stack",
      "fb-toolbar",
      "fb-button",
      "fb-card",
      "fb-control",
      "fb-checkbox",
      "fb-list",
      "fb-list-item",
      "fb-badge",
      "fb-empty",
      "fb-dialog",
      "fb-text",
    ]) {
      expect(markup).toContain(hook);
    }
    expect(markup).toContain('data-variant="primary"');
    expect(markup).toContain('aria-modal="true"');
  });

  it("renders nothing for a closed Dialog", () => {
    expect(
      renderToStaticMarkup(<Dialog open={false} onClose={() => {}} />),
    ).toBe("");
  });
});

describe("the kit's stylesheet", () => {
  it("resolves every colour through a --frockbot-* token", () => {
    // The kit is held to the rule it enforces on Applets, by the same scanner.
    expect(lintCssText(KIT_CSS, "kit.css")).toEqual([]);
  });

  it("names exactly the nine tokens the host re-emits", () => {
    const used = new Set(
      [...KIT_CSS.matchAll(/var\(--frockbot-([a-z-]+)/g)].map(
        (match) => match[1]!,
      ),
    );
    expect([...used].sort()).toEqual([
      "accent-surface",
      "accent-text",
      "border",
      "radius-card",
      "surface",
      "surface-raised",
      "surface-subtle",
      "text",
      "text-muted",
    ]);
  });
});
