import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Server from "@cordisjs/plugin-server";
import WebUI from "@cordisjs/plugin-webui";
import type { AgentEvent } from "@frockbot/protocol";
import { Context, type Plugin } from "cordis";
import {
  app,
  BrowserWindow,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import WebSocket from "ws";

app.on("window-all-closed", () => undefined);

type WorkerEvent =
  { type: "ready" } | { type: "pong"; value: string } | { type: "disposed" };

interface SmokeResult {
  hostLifecycle: { setups: number; cleanups: number };
  serverClosed: boolean;
  authRejected: boolean;
  originRejected: boolean;
  socketOriginRejected: boolean;
  cspApplied: boolean;
  utilityRoundTrip: boolean;
  utilityDisposed: boolean;
  agentRuntime: {
    ready: boolean;
    text: string;
    echo: string;
    toolLifecycle: boolean;
    crashRecovered: boolean;
    disposed: boolean;
  };
  webuiConnected: boolean;
  renderer: { title: string; mounted: boolean; nodeGlobal: string };
  electronNode: string;
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function eventually<T>(
  readValue: () => T | undefined,
  label: string,
): Promise<T> {
  return withTimeout(
    new Promise((resolve) => {
      const check = () => {
        const value = readValue();
        if (value !== undefined) {
          resolve(value);
          return;
        }
        setTimeout(check, 10);
      };
      check();
    }),
    label,
  );
}

function createWorkerInbox<T extends { type: string }>(child: UtilityProcess) {
  const events: T[] = [];
  const consumed = new Set<T>();
  child.on("message", (message) => {
    events.push(message as T);
  });
  return {
    events,
    wait<K extends T["type"]>(type: K): Promise<Extract<T, { type: K }>> {
      return eventually(() => {
        const event = events.find(
          (candidate) => candidate.type === type && !consumed.has(candidate),
        );
        if (!event) return undefined;
        consumed.add(event);
        return event as Extract<T, { type: K }>;
      }, `worker event ${type}`);
    },
  };
}

async function serverIsClosed(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

function rejectsForeignSocket(url: string, cookie: string): Promise<boolean> {
  return withTimeout(
    new Promise((resolve) => {
      const socket = new WebSocket(url, {
        origin: "https://example.invalid",
        headers: { cookie },
      });
      socket.once("open", () => {
        socket.close();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
      socket.once("unexpected-response", (_request, response) => {
        response.destroy();
        resolve(true);
      });
    }),
    "foreign WebSocket rejection",
  );
}

async function runSmoke(): Promise<SmokeResult> {
  await app.whenReady();

  const root = new Context();
  let window: BrowserWindow | undefined;
  let child: UtilityProcess | undefined;
  let agentChild: UtilityProcess | undefined;
  let setups = 0;
  let cleanups = 0;
  let result: Omit<SmokeResult, "hostLifecycle" | "serverClosed"> | undefined;
  let baseUrl = "";
  const credential = randomUUID();

  const lifecyclePlugin: Plugin.Function = () => {
    setups += 1;
    return () => {
      cleanups += 1;
    };
  };

  try {
    await root.plugin(lifecyclePlugin);
    await root.plugin(Server, { host: "127.0.0.1", port: 0, maxPort: 0 });
    baseUrl = root.server.baseUrl;

    const admissionPlugin: Plugin.Function = (ctx) => {
      const hasCredential = (cookies: string | null) =>
        (cookies ?? "")
          .split(/;\s*/)
          .includes(`frockbot_session=${credential}`);
      const httpAdmission = ctx.server.use(async (request, response, next) => {
        response.headers.set(
          "content-security-policy",
          "default-src 'self'; script-src 'self' 'sha256-Vy96PtZRI7fYqJ2gNVKETLELTSMNWTVyT22r0v1TlLQ='; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:",
        );
        const origin = request.headers.get("origin");
        if (origin && origin !== baseUrl) {
          response.status = 403;
          return;
        }
        if (!hasCredential(request.headers.get("cookie"))) {
          response.status = 401;
          return;
        }
        await next();
      });
      const socketAdmission = ctx.on("server/route-check", (request) => {
        if (request.path !== "/api") return;
        if (request.headers.get("origin") !== baseUrl) return true;
        if (!hasCredential(request.headers.get("cookie"))) return true;
      });
      return [httpAdmission, socketAdmission];
    };
    admissionPlugin.inject = ["server"];
    await root.plugin(admissionPlugin);

    await root.plugin(WebUI, {
      uiPath: "",
      apiPath: "/api",
      selfUrl: "",
      devMode: false,
      open: false,
    });

    const unauthenticated = await fetch(baseUrl);
    const cookie = `frockbot_session=${credential}`;
    const wrongOrigin = await fetch(baseUrl, {
      headers: { cookie, origin: "https://example.invalid" },
    });
    const shellResponse = await fetch(baseUrl, { headers: { cookie } });
    if (!shellResponse.ok || !(await shellResponse.text()).includes("Cordis")) {
      throw new Error("Cordis WebUI shell was not served");
    }
    const authRejected = unauthenticated.status === 401;
    const originRejected = wrongOrigin.status === 403;
    const socketOriginRejected = await rejectsForeignSocket(
      `${baseUrl.replace(/^http/, "ws")}/api`,
      cookie,
    );
    const cspApplied = shellResponse.headers.has("content-security-policy");
    if (
      !authRejected ||
      !originRejected ||
      !socketOriginRejected ||
      !cspApplied
    ) {
      throw new Error("Cordis WebUI admission checks failed");
    }

    child = utilityProcess.fork(join(import.meta.dirname, "worker.mjs"), [], {
      serviceName: "FrockBot Cordis POC",
      stdio: "pipe",
    });
    const workerInbox = createWorkerInbox<WorkerEvent>(child);
    await workerInbox.wait("ready");
    child.postMessage({ type: "ping", value: "cordis" });
    const pong = await workerInbox.wait("pong");
    const utilityRoundTrip = pong.type === "pong" && pong.value === "cordis";

    const rendererErrors: string[] = [];
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error") rendererErrors.push(details.message);
    });
    await window.webContents.session.cookies.set({
      url: baseUrl,
      name: "frockbot_session",
      value: credential,
      httpOnly: true,
      sameSite: "strict",
    });
    await window.loadURL(baseUrl);

    await eventually(
      () => (Object.keys(root.webui.clients).length > 0 ? true : undefined),
      "WebUI websocket connection",
    );
    const renderer = (await window.webContents.executeJavaScript(`({
      title: document.title,
      mounted: Boolean(document.querySelector('#app')?.children.length),
      nodeGlobal: typeof process,
    })`)) as SmokeResult["renderer"];
    if (rendererErrors.length > 0) {
      throw new Error(
        `Cordis WebUI renderer errors: ${rendererErrors.join("; ")}`,
      );
    }
    if (!renderer.mounted || renderer.nodeGlobal !== "undefined") {
      throw new Error("Cordis WebUI did not mount in a sandboxed renderer");
    }

    window.close();
    window = undefined;

    const exited = once(child, "exit");
    child.postMessage({ type: "shutdown" });
    await workerInbox.wait("disposed");
    await withTimeout(
      exited.then(() => undefined),
      "utility process exit",
    );
    child = undefined;

    agentChild = utilityProcess.fork(
      join(
        import.meta.dirname,
        "../../desktop/resources/cordis-agent/index.mjs",
      ),
      [],
      { serviceName: "FrockBot custom agent runtime", stdio: "pipe" },
    );
    const agentInbox = createWorkerInbox<AgentEvent>(agentChild);
    const ready = await agentInbox.wait("worker-ready");

    agentChild.postMessage({ type: "prompt", runId: "plain", text: "smoke" });
    await agentInbox.wait("run-started");
    await agentInbox.wait("settled");
    const text = agentInbox.events
      .flatMap((event) =>
        event.type === "text-delta" && event.runId === "plain"
          ? [event.text]
          : [],
      )
      .join("");

    agentChild.postMessage({
      type: "prompt",
      runId: "echo",
      text: "/echo tools",
    });
    await agentInbox.wait("run-started");
    await agentInbox.wait("settled");
    const echo = agentInbox.events
      .flatMap((event) =>
        event.type === "text-delta" && event.runId === "echo"
          ? [event.text]
          : [],
      )
      .join("");
    const toolLifecycle =
      agentInbox.events.some(
        (event) => event.type === "tool-start" && event.runId === "echo",
      ) &&
      agentInbox.events.some(
        (event) => event.type === "tool-end" && event.runId === "echo",
      );

    const crashed = once(agentChild, "exit");
    agentChild.kill();
    await withTimeout(
      crashed.then(() => undefined),
      "custom agent runtime crash",
    );

    agentChild = utilityProcess.fork(
      join(
        import.meta.dirname,
        "../../desktop/resources/cordis-agent/index.mjs",
      ),
      [],
      { serviceName: "FrockBot restarted agent runtime", stdio: "pipe" },
    );
    const restartedInbox = createWorkerInbox<AgentEvent>(agentChild);
    await restartedInbox.wait("worker-ready");
    agentChild.postMessage({
      type: "prompt",
      runId: "restart",
      text: "recovered",
    });
    await restartedInbox.wait("run-started");
    await restartedInbox.wait("settled");
    const restartedText = restartedInbox.events
      .flatMap((event) =>
        event.type === "text-delta" && event.runId === "restart"
          ? [event.text]
          : [],
      )
      .join("");
    const crashRecovered = restartedText === "Cordis runtime: recovered";

    const agentExited = once(agentChild, "exit");
    agentChild.postMessage({ type: "shutdown" });
    await withTimeout(
      agentExited.then(() => undefined),
      "restarted agent runtime exit",
    );
    agentChild = undefined;

    result = {
      authRejected,
      originRejected,
      socketOriginRejected,
      cspApplied,
      utilityRoundTrip,
      utilityDisposed: true,
      agentRuntime: {
        ready: ready.model?.provider === "foundation",
        text,
        echo,
        toolLifecycle,
        crashRecovered,
        disposed: true,
      },
      webuiConnected: true,
      renderer,
      electronNode: process.versions.node,
    };
  } finally {
    window?.destroy();
    child?.kill();
    agentChild?.kill();
    await root.fiber.dispose();
  }

  if (!result) throw new Error("Cordis smoke did not produce a result");
  return {
    ...result,
    hostLifecycle: { setups, cleanups },
    serverClosed: await serverIsClosed(baseUrl),
  };
}

const resultPath = join(import.meta.dirname, "smoke-result.json");
void runSmoke().then(
  (result) => {
    const output = `${JSON.stringify(result)}\n`;
    writeFileSync(resultPath, output);
    process.stdout.write(output);
    app.exit(0);
  },
  (error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeFileSync(resultPath, `${JSON.stringify({ error: message })}\n`);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  },
);
