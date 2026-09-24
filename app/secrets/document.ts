// The User's saved secrets, as the `ViewDocument` Settings renders — the same
// convention as `app/machine/machines-document.ts`, reached with
// `GET /api/secrets?as=document`.
//
// One command: delete a secret. What the document shows is what a Bot may know
// about each one — its name, the site it is for, whether it is a payment
// detail and when it was saved — and never its value, which nothing but the
// credential store holds.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { agoV1 } from "@frockbot/app/shell/moment";
import type { SecretListViewV1, SecretViewV1 } from "./shared.js";

export const SECRET_ACTION_KINDS_V1 = ["delete-secret"] as const;

const KIND: ActionValueSchema = {
  type: "string",
  enum: [...SECRET_ACTION_KINDS_V1],
};
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 64 };

/** A revision derived from what the document says — FNV-1a over its text. */
export function secretsRevisionV1(view: SecretListViewV1): number {
  const text = JSON.stringify(
    view.secrets.map((secret) => [
      secret.secretId,
      secret.label,
      secret.payment,
      secret.origin ?? "",
      secret.createdAt,
    ]),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

function secretNode(secret: SecretViewV1, now: string): ViewNode {
  const kind = secret.payment ? "Payment detail" : "Secret";
  const where = secret.origin
    ? `Used on ${secret.origin}`
    : "No site — each use asks you";
  return {
    type: "group",
    orientation: "column",
    title: secret.label.slice(0, 200),
    children: [
      status(`${kind} · ${where} · Saved ${agoV1(secret.createdAt, now)}`),
      {
        type: "action",
        actionId: "delete-secret",
        label: "Delete",
        style: "danger",
        input: { kind: "delete-secret", secretId: secret.secretId },
      },
    ],
  };
}

/** A `SecretListViewV1` as a `ViewDocument`. */
export function secretsDocumentV1(
  view: SecretListViewV1,
  now = new Date().toISOString(),
): ViewDocument {
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "secrets",
    revision: secretsRevisionV1(view),
    root: {
      type: "group",
      orientation: "column",
      children: [
        {
          type: "text",
          text: "Passwords, card numbers and other secrets you typed on a Bot’s card. They are kept in your account, not in any conversation. A Bot never sees one: it can only have it typed into a web page — without asking on the site it was saved for, and only with your approval anywhere else or when it is a payment detail.",
        },
        ...(view.secrets.length === 0
          ? [status("You have no saved secrets.")]
          : view.secrets.map((secret) => secretNode(secret, now))),
      ],
    },
    actions: [
      {
        id: "delete-secret",
        schema: {
          type: "object",
          properties: { kind: KIND, secretId: IDENTIFIER },
          required: ["kind", "secretId"],
          additionalProperties: false,
        },
      },
    ],
  });
}
