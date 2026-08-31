/**
 * The refusal every configuration seam raises when an inbound value is not
 * what its contract declares.
 *
 * It lives in its own module so a decoder that is *not* the main configuration
 * codec — `./package-settings.ts`, which validates a value against the schema
 * its Package declared — can raise the same refusal without importing the
 * module that re-exports it.
 *
 * The name is load-bearing: it crosses the Durable Object RPC boundary, where
 * the class does not, and the gateway maps it to 400 by name.
 */
export class ConfigurationDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationDecodeError";
  }
}
