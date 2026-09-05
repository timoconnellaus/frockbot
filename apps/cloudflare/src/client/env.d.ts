/// <reference types="vite/client" />

interface DesktopAuthUser {
  id: string;
  name: string;
  email: string;
}

interface DesktopApiRequest {
  schemaVersion: 1;
  path: string;
  method: "GET" | "POST";
  body?: string;
}

interface DesktopApiResponse {
  schemaVersion: 1;
  status: number;
  contentType: string | null;
  body: string;
  /**
   * The application that answered, as the deployment header named it. Without
   * it the desktop shell cannot see a release land behind an open window.
   */
  deployment?: string;
}

interface Window {
  frockbotDesktop?: {
    request(request: DesktopApiRequest): Promise<DesktopApiResponse>;
    openExternalAuthorization(
      url: string,
      nativeReturnNonce?: string,
    ): Promise<void>;
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
