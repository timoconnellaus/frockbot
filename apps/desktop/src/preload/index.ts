import { setupRenderer } from "@better-auth/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApiRequest,
  DesktopApiResponse,
} from "../main/desktop-api.js";
import { decodeDesktopApiResponse } from "../main/desktop-api.js";

setupRenderer();

contextBridge.exposeInMainWorld("frockbotDesktop", {
  request: (request: DesktopApiRequest): Promise<DesktopApiResponse> =>
    ipcRenderer.invoke("frockbot:api", request).then(decodeDesktopApiResponse),
  openExternalAuthorization: (
    url: string,
    nativeReturnNonce?: string,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "frockbot:open-external-authorization",
      url,
      nativeReturnNonce,
    ) as Promise<void>,
});
