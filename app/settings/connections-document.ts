// The `ConnectionsFrame` a settings route already produces, projected as the
// `ViewDocument` the host renders — the same read-one-write-the-other shape as
// `settings-document.ts`, reached the same way, with `?as=document`.
//
// Two conventions carry the frame's extra meaning through a vocabulary that
// has no room for it:
//
// - Every action declares a `kind` in its input, from the closed vocabulary
//   below. An action id is opaque to the renderer, and the Connection command
//   an action means is not derivable from the label a person reads.
// - A connect form's field ids are `c<provider>.label`, `c<provider>.key` and
//   `c<provider>.s.<setting>`. The provider index disambiguates two Packages
//   that named a setting the same thing, and the middle segment says which
//   part of the create command the value is.
//
// The key itself is a `secret` field, which the document seeds as null and the
// host never reads back: the value exists only between a person typing it and
// the action input that carries it to the credential route.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ConnectionsFrame,
  type SettingField,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";

/** What a Connectors action means, read back by the host that dispatches it. */
export const CONNECTION_ACTION_KINDS_V1 = [
  "connect-api-key",
  "authorize",
  "enable-connection",
  "set-enabled",
  "disconnect",
  "revoke",
  "refresh-models",
] as const;

export type ConnectionActionKindV1 =
  (typeof CONNECTION_ACTION_KINDS_V1)[number];

/** The schema's cap on declared actions. */
const ACTION_LIMIT = 32;
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const KIND: ActionValueSchema = {
  type: "string",
  enum: [...CONNECTION_ACTION_KINDS_V1],
};

type Action = ViewDocument["actions"][number];
type Account = ConnectionsFrame["accounts"][number];
type Provider = ConnectionsFrame["providers"][number];

function text(value: string, style?: "heading" | "status" | "label"): ViewNode {
  return { type: "text", text: value, ...(style ? { style } : {}) };
}

function column(title: string | undefined, children: ViewNode[]): ViewNode {
  return {
    type: "group",
    orientation: "column",
    ...(title ? { title } : {}),
    children,
  };
}

function press(
  actionId: string,
  label: string,
  input: Record<string, string | boolean>,
  style?: "primary" | "danger",
): ViewNode {
  return {
    type: "action",
    actionId,
    label: label.slice(0, 100),
    ...(style ? { style } : {}),
    input,
  };
}

/** The actions every account row shares. One schema, many declared inputs. */
function accountActions(): Action[] {
  return [
    {
      id: "set-enabled",
      schema: {
        type: "object",
        properties: {
          kind: KIND,
          connectionId: IDENTIFIER,
          enabled: { type: "boolean" },
        },
        required: ["kind", "connectionId", "enabled"],
        additionalProperties: false,
      },
    },
    {
      id: "disconnect",
      schema: {
        type: "object",
        properties: { kind: KIND, connectionId: IDENTIFIER },
        required: ["kind", "connectionId"],
        additionalProperties: false,
      },
    },
    {
      id: "revoke",
      schema: {
        type: "object",
        properties: {
          kind: KIND,
          connectionId: IDENTIFIER,
          packageId: IDENTIFIER,
        },
        required: ["kind", "connectionId", "packageId"],
        additionalProperties: false,
      },
    },
    {
      id: "refresh-models",
      schema: {
        type: "object",
        properties: { kind: KIND, connectionId: IDENTIFIER },
        required: ["kind", "connectionId"],
        additionalProperties: false,
      },
    },
    {
      id: "authorize",
      schema: {
        type: "object",
        properties: {
          kind: KIND,
          packageId: IDENTIFIER,
          connectionTypeId: IDENTIFIER,
        },
        required: ["kind", "packageId", "connectionTypeId"],
        additionalProperties: false,
      },
    },
    {
      id: "enable-connection",
      schema: {
        type: "object",
        properties: {
          kind: KIND,
          packageId: IDENTIFIER,
          connectionTypeId: IDENTIFIER,
          label: { type: "string", maxLength: 200 },
        },
        required: ["kind", "packageId", "connectionTypeId", "label"],
        additionalProperties: false,
      },
    },
  ];
}

function accountNode(account: Account): ViewNode {
  const controls: ViewNode[] = [];
  // An ambient account is the platform's own — nobody authorized it and
  // nothing a person presses should be able to take the default model away.
  // It says what it is and offers nothing.
  if (account.authorization === "ambient-native") {
    return column(undefined, [
      text(account.label, "label"),
      ...(account.detail ? [text(account.detail, "status")] : []),
      text("Included with FrockBot", "status"),
    ]);
  }
  if (
    account.kind === "model" &&
    account.authorization === "api-key" &&
    account.state === "ready"
  ) {
    controls.push(
      press("refresh-models", "Refresh models", {
        kind: "refresh-models",
        connectionId: account.id,
      }),
    );
  }
  if (account.state === "ready" || account.state === "disabled") {
    controls.push(
      press("set-enabled", account.state === "ready" ? "Turn off" : "Turn on", {
        kind: "set-enabled",
        connectionId: account.id,
        enabled: account.state !== "ready",
      }),
    );
  }
  if (account.state !== "revoking") {
    controls.push(
      account.authorization === "api-key"
        ? press(
            "disconnect",
            "Disconnect",
            { kind: "disconnect", connectionId: account.id },
            "danger",
          )
        : press(
            "revoke",
            "Revoke",
            {
              kind: "revoke",
              connectionId: account.id,
              packageId: account.packageId,
            },
            "danger",
          ),
    );
  }
  return column(undefined, [
    text(account.label, "label"),
    ...(account.detail ? [text(account.detail, "status")] : []),
    ...(account.failure ? [text(account.failure)] : []),
    {
      type: "group",
      orientation: "column",
      title: "Manage connection",
      collapsed: true,
      children: [
        text(
          "Turning off or disconnecting makes this connection unavailable to every Bot using it. Choose another default model first if needed.",
          "status",
        ),
        { type: "group", orientation: "row", children: controls },
      ],
    },
  ]);
}

function secretField(id: string, label: string): SettingField {
  // Seeded null, not empty: a required key then refuses by name before the
  // action is dispatched, rather than being sent as a blank credential.
  return {
    id,
    label,
    kind: "secret",
    value: null,
    editable: true,
    required: true,
  };
}

/**
 * One provider, its accounts, and the way to add another.
 *
 * The connect form is part of the document rather than a host dialog, so the
 * fields a Connection Type declares beside its credential — an endpoint root,
 * say — travel with it and are answered in the same place as the key.
 */
function providerNode(
  provider: Provider,
  index: number,
  accounts: readonly Account[],
): { node: ViewNode; actions: Action[] } {
  const actions: Action[] = [];
  const children: ViewNode[] = [
    text(
      provider.connected === 0
        ? "No account connected"
        : provider.connected === 1
          ? "1 account connected"
          : `${provider.connected} accounts connected`,
      "status",
    ),
    ...accounts.map(accountNode),
  ];

  if (provider.mayConnect && provider.authorization === "api-key") {
    const id = `connect-${index}`;
    const label = `c${index}.label`;
    const key = `c${index}.key`;
    const settings = (provider.settings ?? []).map((setting) => ({
      ...setting,
      id: `c${index}.s.${setting.id}`,
    }));
    const form: ViewNode[] = [
      {
        type: "field",
        field: {
          id: label,
          label: "Account name",
          kind: "text",
          value: provider.displayName,
          editable: true,
          required: true,
          maxLength: 120,
        },
      },
      { type: "field", field: secretField(key, "API key") },
      ...(settings.length
        ? [
            {
              type: "group" as const,
              orientation: "column" as const,
              title: "Advanced — custom server",
              collapsed: true,
              children: settings.map((field): ViewNode => ({
                type: "field",
                field,
              })),
            },
          ]
        : []),
      text(
        "Your API provider may bill you for usage. The key stays on the server and is never shown to your Bots.",
        "status",
      ),
      press(
        id,
        provider.connected === 0 ? "Connect account" : "Add another account",
        {
          kind: "connect-api-key",
          packageId: provider.packageId,
          connectionTypeId: provider.connectionTypeId,
        },
        "primary",
      ),
    ];
    children.push({
      type: "group",
      orientation: "column",
      title:
        provider.connected === 0 ? "Connect account" : "Add another account",
      collapsed: true,
      children: form,
    });
    actions.push({
      id,
      schema: {
        type: "object",
        properties: {
          kind: KIND,
          packageId: IDENTIFIER,
          connectionTypeId: IDENTIFIER,
          [label]: { type: "string", maxLength: 120 },
          [key]: { type: "string", maxLength: 8000 },
          ...Object.fromEntries(
            settings.map((setting) => [
              setting.id,
              { type: "string", maxLength: 2000 } as ActionValueSchema,
            ]),
          ),
        },
        required: ["kind", "packageId", "connectionTypeId", label, key],
        additionalProperties: false,
      },
    });
  } else if (provider.mayConnect && provider.authorization === "grant") {
    children.push(
      press(
        "authorize",
        provider.connected === 0 ? "Connect" : "Add another account",
        {
          kind: "authorize",
          packageId: provider.packageId,
          connectionTypeId: provider.connectionTypeId,
        },
        "primary",
      ),
    );
  } else if (provider.authorization === "none" && provider.connected === 0) {
    children.push(
      press(
        "enable-connection",
        "Turn on for every Bot",
        {
          kind: "enable-connection",
          packageId: provider.packageId,
          connectionTypeId: provider.connectionTypeId,
          label: provider.displayName,
        },
        "primary",
      ),
    );
  }
  return { node: column(provider.displayName, children), actions };
}

function section(
  title: string,
  kind: "model" | "connector",
  frame: ConnectionsFrame,
  budget: number,
): { node: ViewNode | undefined; actions: Action[] } {
  const providers = frame.providers.filter(
    (provider) => provider.kind === kind,
  );
  if (providers.length === 0) return { node: undefined, actions: [] };
  const actions: Action[] = [];
  const children: ViewNode[] = [];
  let complete = true;
  for (const [index, provider] of providers.entries()) {
    const projected = providerNode(
      provider,
      index,
      frame.accounts.filter(
        (account) =>
          account.packageId === provider.packageId &&
          account.kind === provider.kind,
      ),
    );
    if (actions.length + projected.actions.length > budget) {
      complete = false;
      break;
    }
    actions.push(...projected.actions);
    children.push(projected.node);
  }
  if (!complete) {
    children.push(
      text(
        "The rest of these providers need a newer app. Everything above is still yours to change.",
        "status",
      ),
    );
  }
  return { node: column(title, children), actions };
}

/**
 * A `ConnectionsFrame` as a `ViewDocument`.
 *
 * One document per home: a model provider's accounts are read from Models and
 * a connector Package's from Connected apps, so `kind` decides both which
 * providers the frame carries and which single section the document draws.
 */
export function connectionsDocumentV1(
  frame: ConnectionsFrame,
  kind: "model" | "connector" = "connector",
  packageId?: string,
): ViewDocument {
  frame = {
    ...frame,
    providers: frame.providers.filter(
      (provider) =>
        provider.kind === kind &&
        (!packageId || provider.packageId === packageId),
    ),
  };
  const shared = accountActions();
  const offered = section(
    kind === "model" ? "Your providers" : "Connected apps",
    kind,
    frame,
    ACTION_LIMIT - shared.length,
  );
  const children: ViewNode[] = [];
  if (kind === "model" && frame.modelInUse) {
    children.push(column("Model in use", [text(frame.modelInUse, "status")]));
  }
  if (offered.node) {
    children.push(offered.node);
  } else {
    children.push(
      text(
        kind === "model"
          ? "Connect a provider from Models to use its models here."
          : "No connected apps yet. Available services will appear here. Connections you authorize are available to all your Bots.",
      ),
    );
  }
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: kind === "model" ? "model-accounts" : "connections",
    revision: frame.revision,
    root: { type: "group", orientation: "column", children },
    actions: [...shared, ...offered.actions],
  });
}
