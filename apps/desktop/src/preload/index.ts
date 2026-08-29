import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAuthEventV1,
  DesktopAuthRequestV1,
  DesktopAuthUserV1,
  DesktopApiRequest,
  DesktopApiResponse,
} from "../main/desktop-api.js";
import {
  decodeDesktopAuthAcknowledgement,
  decodeDesktopAuthEvent,
  decodeDesktopAuthRequest,
  decodeDesktopAuthUserResponse,
  decodeDesktopApiResponse,
  decodeExternalAuthorizationAcknowledgement,
} from "../main/desktop-api.js";

const AUTH_CHANNEL = "frockbot:auth";
const AUTH_EVENT_CHANNEL = "frockbot:auth-event";

function invokeAuth(request: DesktopAuthRequestV1): Promise<unknown> {
  return ipcRenderer.invoke(AUTH_CHANNEL, decodeDesktopAuthRequest(request));
}

function onAuthEvent(
  callback: (event: DesktopAuthEventV1) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
    callback(decodeDesktopAuthEvent(value));
  };
  ipcRenderer.on(AUTH_EVENT_CHANNEL, listener);
  return () => ipcRenderer.removeListener(AUTH_EVENT_CHANNEL, listener);
}

contextBridge.exposeInMainWorld("getUser", () =>
  invokeAuth({ schemaVersion: 1, type: "auth/get-user" })
    .then(decodeDesktopAuthUserResponse)
    .then((response) => response.user),
);
contextBridge.exposeInMainWorld(
  "requestAuth",
  (options?: { provider?: string }) =>
    invokeAuth({
      schemaVersion: 1,
      type: "auth/request",
      ...(options?.provider === undefined
        ? {}
        : { provider: options.provider }),
    })
      .then(decodeDesktopAuthAcknowledgement)
      .then(() => undefined),
);
contextBridge.exposeInMainWorld("signOut", () =>
  invokeAuth({ schemaVersion: 1, type: "auth/sign-out" })
    .then(decodeDesktopAuthAcknowledgement)
    .then(() => undefined),
);
contextBridge.exposeInMainWorld(
  "onAuthenticated",
  (callback: (user: DesktopAuthUserV1) => unknown) =>
    onAuthEvent((event) => {
      if (event.type === "auth/authenticated" && event.user) {
        callback(event.user);
      }
    }),
);
contextBridge.exposeInMainWorld(
  "onUserUpdated",
  (callback: (user: DesktopAuthUserV1 | null) => unknown) =>
    onAuthEvent((event) => {
      if (event.type === "auth/user-updated") callback(event.user);
    }),
);
contextBridge.exposeInMainWorld(
  "onAuthError",
  (callback: (context: { message: string }) => unknown) =>
    onAuthEvent((event) => {
      if (event.type === "auth/error") callback({ message: event.message });
    }),
);

contextBridge.exposeInMainWorld("frockbotDesktop", {
  request: (request: DesktopApiRequest): Promise<DesktopApiResponse> =>
    ipcRenderer.invoke("frockbot:api", request).then(decodeDesktopApiResponse),
  openExternalAuthorization: (
    url: string,
    nativeReturnNonce?: string,
  ): Promise<void> =>
    ipcRenderer
      .invoke("frockbot:open-external-authorization", {
        schemaVersion: 1,
        url,
        nativeReturnNonce,
      })
      .then(decodeExternalAuthorizationAcknowledgement)
      .then(() => undefined),
});
