import { fileURLToPath } from "node:url";

interface AppIconHost {
  readonly isPackaged: boolean;
  readonly dock?: {
    setIcon(icon: string): void;
  };
}

export function setDevelopmentAppIcon(
  app: AppIconHost,
  platform: NodeJS.Platform = process.platform,
  moduleUrl: string = import.meta.url,
): string | undefined {
  if (app.isPackaged || platform !== "darwin" || !app.dock) return undefined;

  const icon = fileURLToPath(
    new URL("../../resources/icons/512x512.png", moduleUrl),
  );
  app.dock.setIcon(icon);
  return icon;
}
