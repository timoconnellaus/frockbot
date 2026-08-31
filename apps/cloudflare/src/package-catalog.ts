/**
 * The `PACKAGE_CATALOG` bucket, as the two readers see it.
 *
 * The gateway serves documents (`/catalog/v1/*`), so it wants bytes and a hash
 * to put in an `etag`. The User Durable Object validates an install, so it
 * wants a decoded, hash-verified index and entry. Both come from here, which is
 * the only place in the app that names `R2Bucket` for the Catalog — the browser
 * never reaches the bucket, and `@frockbot/plugin-settings` never names a
 * Cloudflare type.
 *
 * Every read verifies before it returns: the index against the hash the pointer
 * published, and an entry against the index row that named it. A generation is
 * immutable, so a document that fails either check is a broken publish, not a
 * new version, and is refused rather than served.
 */
import {
  assertCatalogEntryMatchesIndexV1,
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
  CatalogDecodeError,
  decodeCatalogGenerationIdV1,
  decodeCatalogIdV1,
  decodeCatalogIndexDocumentV1,
  decodeCatalogPointerV1,
  parseCatalogEntryDocumentV1,
  MAX_CATALOG_DOCUMENT_BYTES_V1,
  type CatalogEntryV1,
  type CatalogIndexV1,
  type CatalogPinV1,
  type CatalogPointerV1,
} from "@frockbot/catalog-core";
import type { UserPackageCatalogHost } from "@frockbot/plugin-settings/user";

/** One Catalog object as the gateway serves it. */
export interface CatalogDocumentV1 {
  generation: string;
  hash: string;
  document: string;
}

export interface PackageCatalogStore extends UserPackageCatalogHost {
  /** The live pointer, or `undefined` when nothing has been published. */
  readPointer(): Promise<CatalogPointerV1 | undefined>;
  readIndexDocument(
    generation?: string,
  ): Promise<CatalogDocumentV1 | undefined>;
  readEntryDocument(
    catalogId: string,
    generation?: string,
  ): Promise<CatalogDocumentV1 | undefined>;
}

export class R2PackageCatalog implements PackageCatalogStore {
  constructor(private readonly bucket: R2Bucket) {}

  private async readDocument(key: string): Promise<string | undefined> {
    const object = await this.bucket.get(key);
    if (!object) return undefined;
    if (object.size > MAX_CATALOG_DOCUMENT_BYTES_V1) {
      throw new CatalogDecodeError(`catalog object "${key}" is too large`);
    }
    return object.text();
  }

  async readPointer(): Promise<CatalogPointerV1 | undefined> {
    const document = await this.readDocument(CATALOG_POINTER_KEY_V1);
    if (document === undefined) return undefined;
    return decodeCatalogPointerV1(JSON.parse(document) as unknown);
  }

  /**
   * The index for one generation. Without a generation the pointer decides,
   * and the pointer's `indexHash` is what the bytes are verified against; with
   * one, the bytes are hashed and the caller is told what they are, since a
   * generation other than the live one has no published hash to check.
   */
  async readIndexDocument(
    generation?: string,
  ): Promise<CatalogDocumentV1 | undefined> {
    if (generation === undefined) {
      const pointer = await this.readPointer();
      if (!pointer) return undefined;
      const document = await this.readDocument(
        catalogIndexKeyV1(pointer.generation),
      );
      if (document === undefined) {
        throw new CatalogDecodeError(
          `catalog generation "${pointer.generation}" has no index`,
        );
      }
      await decodeCatalogIndexDocumentV1(document, pointer.indexHash);
      return {
        generation: pointer.generation,
        hash: pointer.indexHash,
        document,
      };
    }
    const pinned = decodeCatalogGenerationIdV1(generation);
    const document = await this.readDocument(catalogIndexKeyV1(pinned));
    if (document === undefined) return undefined;
    const hash = await catalogContentHashV1(document);
    return { generation: pinned, hash, document };
  }

  async readEntryDocument(
    catalogId: string,
    generation?: string,
  ): Promise<CatalogDocumentV1 | undefined> {
    const index = await this.readIndexDocument(generation);
    if (!index) return undefined;
    const decodedIndex = await decodeCatalogIndexDocumentV1(
      index.document,
      index.hash,
    );
    const row = decodedIndex.entries.find(
      (entry) => entry.catalogId === decodeCatalogIdV1(catalogId),
    );
    if (!row) return undefined;
    const document = await this.readDocument(
      catalogEntryKeyV1(index.generation, row.catalogId),
    );
    if (document === undefined) {
      throw new CatalogDecodeError(
        `catalog entry "${row.catalogId}" is indexed but absent from generation "${index.generation}"`,
      );
    }
    assertCatalogEntryMatchesIndexV1(
      parseCatalogEntryDocumentV1(document),
      row,
    );
    return {
      generation: index.generation,
      hash: await catalogContentHashV1(document),
      document,
    };
  }

  async readCurrentIndex(): Promise<
    { pin: CatalogPinV1; index: CatalogIndexV1 } | undefined
  > {
    const document = await this.readIndexDocument();
    if (!document) return undefined;
    return {
      pin: { generation: document.generation, indexHash: document.hash },
      index: await decodeCatalogIndexDocumentV1(
        document.document,
        document.hash,
      ),
    };
  }

  async readEntry(
    generation: string,
    catalogId: string,
  ): Promise<CatalogEntryV1 | undefined> {
    const document = await this.readEntryDocument(catalogId, generation);
    return document === undefined
      ? undefined
      : parseCatalogEntryDocumentV1(document.document);
  }
}
