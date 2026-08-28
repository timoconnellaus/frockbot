import { setupRenderer } from "@better-auth/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApiRequest,
  DesktopApiResponse,
} from "../main/desktop-api.js";

setupRenderer();

contextBridge.exposeInMainWorld("frockbotDesktop", {
  request: (request: DesktopApiRequest): Promise<DesktopApiResponse> =>
    ipcRenderer.invoke("frockbot:api", request) as Promise<DesktopApiResponse>,
  openExternalAuthorization: (url: string): Promise<void> =>
    ipcRenderer.invoke(
      "frockbot:open-external-authorization",
      url,
    ) as Promise<void>,
});
