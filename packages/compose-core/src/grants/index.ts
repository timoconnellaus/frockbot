/** Standard named grants and the in-process reference implementations. */

export {
  aiStub,
  filesStub,
  httpStub,
  scheduleStub,
  storageStub,
} from "./definitions";
export { createInProcessGrants } from "./in-process";
export type {
  AiTextInput,
  FilesOperation,
  FileValue,
  HttpCredential,
  HttpGrantResponse,
  HttpOperation,
  HttpRequestOptions,
  HttpService,
  HttpServices,
  ScheduleOperation,
  StorageOperation,
} from "./definitions";
export type { InProcessGrantsOptions } from "./in-process";
