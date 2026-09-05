import { defineGrant } from "../base";
import type { GrantContext } from "../base";

/** One server-owned credential attached to an HTTP service request. */
export interface HttpCredential {
  header: string;
  value: string;
}

/** One service name the HTTP grant may reach. */
export interface HttpService {
  origin: string;
  credential?: HttpCredential;
}

/** The base-owned service allow-list used by the HTTP grant. */
export type HttpServices = Readonly<Record<string, HttpService>>;

/** Structured request options accepted across a host boundary. */
export interface HttpRequestOptions {
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | ArrayBuffer;
}

/** Structured HTTP response returned across a host boundary. */
export interface HttpGrantResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

/** Input to `ai.text`. */
export interface AiTextInput {
  prompt: string;
  system?: string;
}

/** The value returned by `files.get`. */
export interface FileValue {
  body: ArrayBuffer;
  contentType?: string;
}

/** Operations sent through the storage grant's action dispatch. */
export type StorageOperation =
  | { method: "get"; args: [key: unknown] }
  | { method: "set"; args: [key: unknown, value: unknown] }
  | { method: "delete"; args: [key: unknown] }
  | { method: "list"; args: [prefix?: unknown] };

/** Operations sent through the schedule grant's action dispatch. */
export type ScheduleOperation =
  | { method: "at"; args: [when: unknown, handler: unknown] }
  | { method: "every"; args: [ms: unknown, handler: unknown] }
  | { method: "cancel"; args: [] };

/** Operations sent through the HTTP grant's action dispatch. */
export interface HttpOperation {
  method: "fetch";
  args: [service: unknown, path: unknown, init?: unknown];
}

/** Operations sent through the files grant's action dispatch. */
export type FilesOperation =
  | { method: "put"; args: [key: unknown, body: unknown, options?: unknown] }
  | { method: "get"; args: [key: unknown] }
  | { method: "delete"; args: [key: unknown] }
  | { method: "list"; args: [prefix?: unknown] };

const wire = <T>(method: string, args: Array<unknown>): T =>
  ({ method, args }) as T;

/** Persistent structured-clone-safe key-value storage. */
export const storageStub = defineGrant({
  name: "storage",
  declarations: `declare const storage: {
  get<T=unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T=unknown>(prefix?: string): Promise<Record<string, T>>
}`,
  methods: {
    get<T = unknown>(key: string, _context: GrantContext): T | undefined {
      return wire("get", [key]);
    },
    set(key: string, value: unknown, _context: GrantContext): void {
      return wire("set", [key, value]);
    },
    delete(key: string, _context: GrantContext): boolean {
      return wire("delete", [key]);
    },
    list<T = unknown>(
      prefix: string | undefined,
      _context: GrantContext,
    ): Record<string, T> {
      return wire("list", [prefix ?? ""]);
    },
  },
});

/** A single durable alarm that calls a named source export. */
export const scheduleStub = defineGrant({
  name: "schedule",
  declarations: `declare const schedule: {
  every(ms: number, handler: string): Promise<void>
  at(when: number | Date, handler: string): Promise<void>
  cancel(): Promise<void>
}`,
  methods: {
    every(ms: number, handler: string, _context: GrantContext): void {
      return wire("every", [ms, handler]);
    },
    at(when: number | Date, handler: string, _context: GrantContext): void {
      return wire("at", [when, handler]);
    },
    cancel(_context: GrantContext): void {
      return wire("cancel", []);
    },
  },
});

/** HTTP access through base-named services and server-owned credentials. */
export const httpStub = defineGrant({
  name: "http",
  declarations: `interface HttpGrantResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
}
declare const http: {
  fetch(service: string, path: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | ArrayBuffer
  }): Promise<HttpGrantResponse>
}`,
  methods: {
    fetch(
      service: string,
      path: string,
      init: HttpRequestOptions | undefined,
      _context: GrantContext,
    ): HttpGrantResponse {
      return wire("fetch", [service, path, init]);
    },
  },
});

/** Text generation through the host's own model provider. */
export const aiStub = defineGrant({
  name: "ai",
  declarations: `declare const ai: {
  text(input: { prompt: string; system?: string }): Promise<string>
}`,
  methods: {
    text(input: AiTextInput, _context: GrantContext): string {
      return wire("text", [input]);
    },
  },
});

/** Object storage scoped to the calling plugin entry. */
export const filesStub = defineGrant({
  name: "files",
  declarations: `interface Blob {
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
}
declare const files: {
  put(key: string, body: Blob | string | ArrayBuffer, options?: { contentType?: string }): Promise<void>
  get(key: string): Promise<{ body: ArrayBuffer; contentType?: string } | undefined>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<Array<string>>
}`,
  methods: {
    put(
      key: string,
      body: Blob | string | ArrayBuffer,
      options: { contentType?: string } | undefined,
      _context: GrantContext,
    ): void {
      return wire("put", [key, body, options]);
    },
    get(key: string, _context: GrantContext): FileValue | undefined {
      return wire("get", [key]);
    },
    delete(key: string, _context: GrantContext): void {
      return wire("delete", [key]);
    },
    list(prefix: string | undefined, _context: GrantContext): Array<string> {
      return wire("list", [prefix ?? ""]);
    },
  },
});
