/**
 * Stands in for a plugin authored in a different package: it is consumed with
 * value imports only, and no global type augmentation (H3).
 */
import { createContextKey, createEvent, createPlugin } from "../../src/index";
import { validator } from "./validator";

export interface Mailer {
  send: (to: string) => Promise<"sent">;
}

export const mailerKey = createContextKey<Mailer>("mailer");
export const mailSentEvent = createEvent<{ to: string }>("mail.sent");

const mailerOptions = validator<{ from?: string }, { from: string }>(
  (value) => ({ value: { from: value.from ?? "noreply@example.test" } }),
);

export const mailerPlugin = createPlugin({
  name: "mailer",
  provides: [mailerKey],
  validator: mailerOptions,
  setup(instance, options) {
    instance.provide(mailerKey, {
      send: (to: string) => {
        instance.emit(mailSentEvent, { to: `${to} from ${options.from}` });
        return Promise.resolve("sent" as const);
      },
    });
  },
});
