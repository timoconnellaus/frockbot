// The two template surfaces, projected as the `ViewDocument`s the host
// renders — the same convention as `app/routines/routines-document.ts`, both
// reached with `?as=document`.
//
// They are two documents rather than one because they are two surfaces: what
// this Bot packs up is per-Bot, and what this account has unpacked is not.
// Neither carries a revision the way `SettingsFrame` does, so each derives one
// from its own bytes and no command fences on it — a share and an import are
// each their own durable record.
//
// Which Bot a pack is of is never in the document. It is the Bot the host is
// showing, and the host names it when it turns the press into a command, the
// same way the Routines host names the Bot its own actions belong to.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type {
  TemplateImportListViewV1,
  TemplateImportRecordV1,
  TemplateShareListViewV1,
} from "./shared.js";
import type {
  TemplateShareRecordV1,
  TemplateVisibilityV1,
} from "@frockbot/core/template";
import { agoV1 } from "@frockbot/app/shell/moment";

export const TEMPLATE_ACTION_KINDS_V1 = [
  "pack-template",
  "set-visibility",
  "revoke-share",
  "plan-import",
  "apply-import",
] as const;

export type TemplateActionKindV1 = (typeof TEMPLATE_ACTION_KINDS_V1)[number];

/** The one field the import form carries: the link that was shared. */
export const TEMPLATE_LINK_FIELD_V1 = "template.link";

/**
 * The per-share visibility field: one `select` per share, named by the share's
 * position rather than its id, which carries a user id and is not bounded to
 * what an identifier may be.
 */
export function templateVisibilityFieldV1(index: number): string {
  return `template.v.${index}`;
}

const KIND: ActionValueSchema = {
  type: "string",
  enum: [...TEMPLATE_ACTION_KINDS_V1],
};
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 200 };
const VISIBILITY: ActionValueSchema = {
  type: "string",
  enum: ["private", "link", "public"],
};

/**
 * Who may read a share.
 *
 * The label is what fits in a closed dropdown; the sentence beneath the field
 * is where the difference between the three is actually explained, because a
 * chooser that has to be read at width is not a chooser.
 */
const VISIBILITY_WORDS: Record<TemplateVisibilityV1, string> = {
  private: "Private",
  link: "Anyone with the link",
  public: "Public",
};
const VISIBILITY_HINT =
  "Private keeps the recipe staged and shared with nobody. A link is unlisted but readable by whoever holds it. Public is readable by anyone, and listable.";

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

function revision(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function shareNode(
  share: TemplateShareRecordV1,
  index: number,
  now: string,
): ViewNode {
  const revoked = share.revokedAt !== undefined;
  return {
    type: "group",
    orientation: "column",
    title: share.botId,
    children: [
      status(
        revoked
          ? `Revoked ${agoV1(share.revokedAt!, now)} · packed ${agoV1(share.createdAt, now)}`
          : `Packed ${agoV1(share.createdAt, now)} · ${share.hash.slice(0, 12)}`,
      ),
      ...(revoked
        ? [status("This link no longer reads. Pack the Bot again to share it.")]
        : [
            {
              type: "field" as const,
              field: {
                id: templateVisibilityFieldV1(index),
                label: "Who can read it",
                kind: "select" as const,
                value: share.visibility,
                editable: true,
                hint: VISIBILITY_HINT,
                choices: (
                  ["private", "link", "public"] as TemplateVisibilityV1[]
                ).map((visibility) => ({
                  label: VISIBILITY_WORDS[visibility],
                  value: visibility,
                })),
              },
            },
            // The link is only a link once it is readable, so a private share
            // shows none rather than one that answers 404.
            ...(share.visibility === "private"
              ? []
              : [status(`/templates/v1/${share.shareId}`)]),
            {
              type: "group" as const,
              orientation: "row" as const,
              children: [
                {
                  type: "action" as const,
                  actionId: "set-visibility",
                  label: "Save",
                  // Every share's select is declared on the one action, so a
                  // press carries all of them. `field` is which of those the
                  // host is to read: without it the host would have to know
                  // how a field id is spelled to find its own share's answer.
                  input: {
                    kind: "set-visibility",
                    shareId: share.shareId,
                    field: templateVisibilityFieldV1(index),
                  },
                },
                {
                  type: "action" as const,
                  actionId: "revoke-share",
                  label: "Revoke",
                  style: "danger" as const,
                  input: { kind: "revoke-share", shareId: share.shareId },
                },
              ],
            },
          ]),
    ],
  };
}

/** This account's template shares, as a `ViewDocument`. */
export function templateSharesDocumentV1(
  view: TemplateShareListViewV1,
  now = new Date().toISOString(),
): ViewDocument {
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "bot-templates",
    revision: revision(
      JSON.stringify(
        view.shares.map((share) => [
          share.shareId,
          share.hash,
          share.visibility,
          share.revokedAt ?? "",
        ]),
      ),
    ),
    root: {
      type: "group",
      orientation: "column",
      children: [
        {
          type: "text",
          text: "Packing a Bot copies its profile, its Skills, its Routines and the plugins it needs. Its Memory, its credentials, its connected accounts and its Computer files stay yours.",
        },
        {
          type: "action",
          actionId: "pack-template",
          label: "Pack this Bot",
          style: "primary",
          input: { kind: "pack-template" },
        },
        ...(view.shares.length === 0
          ? [status("Nothing has been packed yet.")]
          : view.shares.map((share, index) => shareNode(share, index, now))),
      ],
    },
    actions: [
      {
        // No `botId`: which Bot is packed is the one the host is showing, and
        // a document that named it could be pressed against another.
        id: "pack-template",
        schema: {
          type: "object",
          properties: { kind: KIND },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      {
        // Every share's select is declared here, so a press carries the value
        // of its own share's field and of no other.
        id: "set-visibility",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            shareId: IDENTIFIER,
            field: { type: "string", maxLength: 128 },
            ...Object.fromEntries(
              view.shares.map((_, index) => [
                templateVisibilityFieldV1(index),
                VISIBILITY,
              ]),
            ),
          },
          required: ["kind", "shareId", "field"],
          additionalProperties: false,
        },
      },
      {
        id: "revoke-share",
        schema: {
          type: "object",
          properties: { kind: KIND, shareId: IDENTIFIER },
          required: ["kind", "shareId"],
          additionalProperties: false,
        },
      },
    ],
  });
}

/** What a planned import would create, in its four groups. */
function importNode(record: TemplateImportRecordV1): ViewNode {
  const willInstall = record.packages.filter(
    (entry) => entry.status === "will-install",
  );
  const installed = record.packages.filter(
    (entry) => entry.status === "already-installed",
  );
  const missing = record.packages.filter((entry) => entry.status === "missing");
  const routines = record.routines.map(
    (routine) =>
      `${routine.slug}${routine.disabled ? " — created paused, with no webhook key" : ""}`,
  );
  return {
    type: "group",
    orientation: "column",
    title: record.botName,
    children: [
      status(
        record.status === "planned"
          ? "Nothing has been created yet."
          : `Import ${record.status}.`,
      ),
      {
        type: "text",
        text: [
          `Will create the Bot “${record.botName}”.`,
          record.skills.length > 0
            ? `${record.skills.length} Skill${record.skills.length === 1 ? "" : "s"}: ${record.skills.join(", ")}`
            : "No Skills.",
          routines.length > 0
            ? `Routines: ${routines.join("; ")}`
            : "No Routines.",
          willInstall.length > 0
            ? `Will install: ${willInstall.map((entry) => `${entry.displayName} (${entry.version})`).join(", ")}`
            : "",
          installed.length > 0
            ? `Already installed: ${installed.map((entry) => entry.displayName).join(", ")}`
            : "",
          missing.length > 0
            ? `Not available here, so skipped: ${missing.map((entry) => entry.displayName).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000),
      },
      ...(record.failure
        ? [
            status(
              `${record.failure} Everything before it is already in place; confirming again retries from there.`,
            ),
          ]
        : []),
      // An applied import has nothing left to press: the Bot exists, and the
      // record is the receipt for it.
      ...(record.status === "applied"
        ? [status("Done. The Bot is in your list.")]
        : [
            {
              type: "action" as const,
              actionId: "apply-import",
              label:
                record.status === "failed"
                  ? "Retry the import"
                  : "Create the Bot",
              style: "primary" as const,
              input: { kind: "apply-import", importId: record.importId },
            },
          ]),
    ],
  };
}

/** This account's template imports, as a `ViewDocument`. */
export function templateImportsDocumentV1(
  view: TemplateImportListViewV1,
): ViewDocument {
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "bot-template-imports",
    revision: revision(
      JSON.stringify(
        view.imports.map((record) => [
          record.importId,
          record.status,
          record.updatedAt,
        ]),
      ),
    ),
    root: {
      type: "group",
      orientation: "column",
      children: [
        {
          type: "text",
          text: "Paste a template link to see what it would create. Nothing is made until you say so, and an import never brings a credential or a connected account with it.",
        },
        {
          type: "field",
          field: {
            id: TEMPLATE_LINK_FIELD_V1,
            label: "Template link",
            kind: "text",
            value: null,
            editable: true,
            maxLength: 500,
            hint: "The whole link, or just the share id at the end of it.",
          },
        },
        {
          type: "action",
          actionId: "plan-import",
          label: "Review the template",
          style: "primary",
          input: { kind: "plan-import" },
        },
        ...(view.imports.length === 0
          ? [status("No template has been imported here yet.")]
          : view.imports.map(importNode)),
      ],
    },
    actions: [
      {
        // The share id is what the person typed, so it travels as the field's
        // value rather than as something the document already knew.
        id: "plan-import",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            [TEMPLATE_LINK_FIELD_V1]: { type: "string", maxLength: 500 },
          },
          required: ["kind", TEMPLATE_LINK_FIELD_V1],
          additionalProperties: false,
        },
      },
      {
        id: "apply-import",
        schema: {
          type: "object",
          properties: { kind: KIND, importId: IDENTIFIER },
          required: ["kind", "importId"],
          additionalProperties: false,
        },
      },
    ],
  });
}
