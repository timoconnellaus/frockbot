// A stand-in for the `send_email` binding, as an auxiliary Worker with an RPC
// entrypoint.
//
// Why a stand-in: miniflare's own `send_email` simulator writes each message
// to a temporary file and a log line, which a test cannot read back. This one
// takes the same structured message — `SendEmail.send(EmailMessageBuilder)`,
// the form `app/email/sender.ts` uses — answers with a `messageId` the way the
// platform does, and keeps every message it was handed for the suite to read
// through a second binding onto the same entrypoint.

import type { AuxiliaryWorkerOptionsV1 } from "./frock-ai-fake.ts";

/** The service name both bindings point at. */
export const EMAIL_FAKE_NAME = "email-fake";
/** The RPC entrypoint `SEND_EMAIL` and `EMAIL_PROBE` are wired to. */
export const EMAIL_FAKE_ENTRYPOINT = "EmailFake";

/** One message as the fake received it: the builder's own fields. */
export interface FakeSentEmailV1 {
  from: { email: string; name: string };
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  messageId: string;
}

// Authored as a module string because miniflare's auxiliary Workers take
// JavaScript, not a TypeScript path.
const SCRIPT = `
import { WorkerEntrypoint } from "cloudflare:workers";

let sent = [];

export class ${EMAIL_FAKE_ENTRYPOINT} extends WorkerEntrypoint {
  send(message) {
    const messageId = "<fake-" + (sent.length + 1) + "@email-fake.test>";
    sent.push({ ...structuredClone(message), messageId });
    return { messageId };
  }

  // Not part of the binding: the suite's window onto what was sent.
  sent() {
    return sent;
  }
}

export default {
  fetch() {
    return new Response("email-fake speaks RPC only", { status: 404 });
  },
};
`;

/** The auxiliary Worker definition, for `miniflare.workers`. */
export function createEmailFakeWorker(
  compatibilityDate: string,
): AuxiliaryWorkerOptionsV1 {
  return {
    name: EMAIL_FAKE_NAME,
    modules: true,
    script: SCRIPT,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
  };
}

/** The service designator both `SEND_EMAIL` and the suite's probe use. */
export const EMAIL_FAKE_SERVICE = {
  name: EMAIL_FAKE_NAME,
  entrypoint: EMAIL_FAKE_ENTRYPOINT,
} as const;
