// The object store this package writes through, declared structurally.
//
// It is deliberately not `R2Bucket`. "Electron, Cloudflare, provider SDK, and
// Computer implementation types remain inside their adapters" — so the store
// consumes the four operations and the two conditional headers it actually
// needs, an adapter in the Cloudflare app supplies them over R2, and a Bun
// test supplies them over a Map. The two behave the same because this file,
// not R2, is the contract.
//
// Conditional semantics are the whole point of the interface. ADR 0013 names
// "object storage conditional writes (`If-Match` on the object's ETag)" as the
// mechanism by which a write that has not seen the current generation loses
// rather than overwrites, so `put` must be able to fail a precondition and say
// so as a value.

/** An object's metadata, without its bytes. */
export interface ObjectHeadV1 {
  key: string;
  /** The entity tag an `If-Match` write is conditioned on. */
  etag: string;
  size: number;
  /** When the store accepted these bytes; orders an unrecorded object. */
  uploaded: Date;
  /** Small opaque strings stored beside the bytes. */
  customMetadata?: Record<string, string>;
}

/** An object with its bytes. */
export interface ObjectBodyV1 extends ObjectHeadV1 {
  bytes(): Promise<Uint8Array>;
}

/**
 * The two conditions this store uses, and no others.
 *
 * `etagMatches` is `If-Match`: replace exactly the bytes the writer has seen.
 * `etagDoesNotMatch: "*"` is `If-None-Match: *`: create only if absent, which
 * is what `expectedGenerationId: null` asserts.
 */
export interface ObjectConditionsV1 {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

export interface ObjectPutOptionsV1 {
  onlyIf?: ObjectConditionsV1;
  customMetadata?: Record<string, string>;
  contentType?: string;
}

export interface ObjectListRequestV1 {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ObjectListPageV1 {
  objects: ObjectHeadV1[];
  truncated: boolean;
  cursor?: string;
}

/**
 * The minimal object store. Every method may reject; the store above turns a
 * rejection into the declared `unavailable` variant rather than letting it
 * escape, because object storage being briefly unreachable is an ordinary
 * answer, not a failed Turn.
 */
export interface ObjectBucketV1 {
  get(key: string): Promise<ObjectBodyV1 | null>;
  head(key: string): Promise<ObjectHeadV1 | null>;
  /** Answers `null` when a precondition in `options.onlyIf` failed. */
  put(
    key: string,
    bytes: Uint8Array,
    options?: ObjectPutOptionsV1,
  ): Promise<ObjectHeadV1 | null>;
  delete(key: string): Promise<void>;
  list(request: ObjectListRequestV1): Promise<ObjectListPageV1>;
}
