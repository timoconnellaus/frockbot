/// <reference types="vite/client" />

interface DesktopAuthUser {
  id: string;
  name: string;
  email: string;
}

interface DesktopApiRequest {
  path: string;
  method: "GET" | "POST";
  body?: string;
}

interface DesktopApiResponse {
  status: number;
  contentType: string | null;
  body: string;
}

interface Window {
  frockbotDesktop?: {
    request(request: DesktopApiRequest): Promise<DesktopApiResponse>;
  };
  getUser(): Promise<DesktopAuthUser | null>;
  requestAuth(options?: { provider?: string }): Promise<void>;
  onAuthenticated(callback: (user: DesktopAuthUser) => unknown): () => void;
  onUserUpdated(
    callback: (user: DesktopAuthUser | null) => unknown,
  ): () => void;
  onAuthError(callback: (context: { message?: string }) => unknown): () => void;
  signOut(): Promise<void>;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<
    Record<string, never>,
    Record<string, never>,
    unknown
  >;
  export default component;
}
