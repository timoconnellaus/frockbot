import { setupRenderer } from "@better-auth/electron/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApiRequest,
  DesktopApiResponse,
} from "../main/auth-client.js";

setupRenderer();

contextBridge.exposeInMainWorld("frockbotDesktop", {
  request: (request: DesktopApiRequest): Promise<DesktopApiResponse> =>
    ipcRenderer.invoke("frockbot:api", request) as Promise<DesktopApiResponse>,
});
