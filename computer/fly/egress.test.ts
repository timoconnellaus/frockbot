import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EGRESS_ENSURE_SCRIPT,
  EGRESS_PORT,
  egressEnsureScript,
  EGRESS_PROXY_SCRIPT,
  EGRESS_ROOT,
  EGRESS_RUNTIME_ROOT,
  egressProxySource,
  egressShellPreludeV1,
} from "../linux-runtime/egress.js";
import {
  COMPUTER_RUNTIME_FILES,
  PROVISION_PHASES,
  RUNTIME_ROOT,
  TERMINAL_PACKAGES,
} from "./runtime.js";

describe("the Sprite's connected-account proxy", () => {
  test("lives under the runtime root and is installed by the runtime phase", () => {
    expect(EGRESS_RUNTIME_ROOT).toBe(RUNTIME_ROOT);
    const paths = COMPUTER_RUNTIME_FILES.map((file) => file.path);
    expect(paths).toContain(EGRESS_PROXY_SCRIPT);
    expect(paths).toContain(EGRESS_ENSURE_SCRIPT);
    const packages = PROVISION_PHASES.find(
      (phase) => phase.name === "packages",
    )!.body;
    for (const name of TERMINAL_PACKAGES) expect(packages).toContain(name);
  });

  test("a command with no connected account signs in for Jev alone and sets no GitHub placeholder", () => {
    const prelude = egressShellPreludeV1("payload.signature", {
      accounts: false,
    });
    expect(prelude).toContain("http://frockbot-jev:payload.signature@");
    expect(prelude).not.toContain("GH_TOKEN");
  });

  test("a command's prelude points every client at the proxy only when it is up", () => {
    const prelude = egressShellPreludeV1("payload.signature");
    expect(prelude.split("\n")[0]).toBe(
      `if '${EGRESS_ENSURE_SCRIPT}' >/dev/null 2>&1; then`,
    );
    expect(prelude).toContain(
      `HTTPS_PROXY='http://frockbot:payload.signature@127.0.0.1:${EGRESS_PORT}'`,
    );
    expect(prelude).toContain(`SSL_CERT_FILE='${EGRESS_ROOT}/bundle.pem'`);
    expect(prelude).toContain("NODE_USE_ENV_PROXY=1");
    expect(prelude).toContain('GH_TOKEN="${GH_TOKEN:-');
  });
});

describe("the proxy, run", () => {
  const dir = mkdtempSync(join(tmpdir(), "frockbot-egress-"));
  const seen: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    bearer: string;
  }[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const forwarded = (await request.json()) as {
        method: string;
        url: string;
        headers: Record<string, string>;
        bodyBase64?: string;
      };
      seen.push({
        method: forwarded.method,
        url: forwarded.url,
        headers: forwarded.headers,
        body: forwarded.bodyBase64 ? atob(forwarded.bodyBase64) : "",
        bearer: request.headers.get("authorization") ?? "",
      });
      return Response.json({
        status: 201,
        headers: { "content-type": "application/json", link: "<next>" },
        bodyBase64: btoa('{"number":7}'),
      });
    },
  });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(
    join(dir, "proxy.mjs"),
    egressProxySource
      .replace(JSON.stringify(EGRESS_ROOT), JSON.stringify(join(dir, "state")))
      .replace(`const PORT = ${EGRESS_PORT};`, `const PORT = ${port};`),
  );
  const proxy = Bun.spawn(["node", join(dir, "proxy.mjs")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const payload = btoa(
    JSON.stringify({
      v: 1,
      o: "user-1:bot-1",
      n: "nonce",
      x: Date.now() + 60_000,
      u: `http://127.0.0.1:${endpoint.port}/api/computer/egress`,
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${payload}.signature`;

  afterAll(() => {
    proxy.kill();
    void endpoint.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function curl(args: string[], proxyUrl: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const listening = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      }).then(
        (socket) => {
          socket.end();
          return true;
        },
        () => false,
      );
      if (listening) break;
      await Bun.sleep(100);
    }
    const child = Bun.spawn(["curl", "-sS", "-i", ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        CURL_CA_BUNDLE: join(dir, "state", "bundle.pem"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    return new Response(child.stdout).text();
  }

  test("sends a connected app's request to the Worker under the token, without the CLI's credential", async () => {
    const out = await curl(
      [
        "-X",
        "POST",
        "https://api.github.com/repos/o/r/issues?per_page=5",
        "-H",
        "authorization: token frockbot-connected-account",
        "-H",
        "content-type: application/json",
        "-d",
        '{"title":"hi"}',
      ],
      `http://frockbot:${token}@127.0.0.1:${port}`,
    );
    expect(out).toContain("HTTP/1.1 201 Created");
    expect(out).toContain("link: <next>");
    expect(out).toContain('{"number":7}');
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues?per_page=5",
      body: '{"title":"hi"}',
      bearer: `Bearer ${token}`,
    });
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
  }, 20_000);

  test("intercepts any app's generic address, which resolves nowhere else", async () => {
    const out = await curl(
      ["https://notion.connected.internal/v1/users/me?x=1"],
      `http://frockbot:${token}@127.0.0.1:${port}`,
    );
    expect(out).toContain("HTTP/1.1 201 Created");
    expect(seen.at(-1)).toMatchObject({
      method: "GET",
      url: "https://notion.connected.internal/v1/users/me?x=1",
    });
  }, 20_000);

  test("a command with no connected account reaches Jev, and every other host untouched", async () => {
    const jev = await curl(
      [
        "-X",
        "POST",
        "https://jev.internal/v1/system-one",
        "-d",
        '{"state":{},"questions":{}}',
      ],
      `http://frockbot-jev:${token}@127.0.0.1:${port}`,
    );
    expect(jev).toContain("HTTP/1.1 201 Created");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "https://jev.internal/v1/system-one",
    });
    const before = seen.length;
    // Tunnelled to the real host rather than answered here: whatever the
    // network makes of it, the Worker never sees it.
    await curl(
      ["--max-time", "5", "https://api.github.com/user"],
      `http://frockbot-jev:${token}@127.0.0.1:${port}`,
    );
    expect(seen).toHaveLength(before);
  }, 30_000);

  test("answers a connected app's host without a token by saying where accounts are available", async () => {
    const before = seen.length;
    const out = await curl(
      ["https://api.github.com/user"],
      `http://127.0.0.1:${port}`,
    );
    expect(out).toContain("407");
    expect(out).toContain("computer_exec");
    expect(seen).toHaveLength(before);
  }, 20_000);
});

// The script runs on the Computer, a Linux machine; a Mac has no flock or setsid.
const linuxTools = ["flock", "setsid"].every((tool) => Bun.which(tool));

describe("the ensure script", () => {
  test.skipIf(!linuxTools)(
    "starts the proxy once, and replaces it when its script is newer",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "frockbot-ensure-"));
      const state = join(dir, "state");
      const script = join(dir, "proxy.mjs");
      const ensure = join(dir, "ensure.sh");
      const port = 20_000 + Math.floor(Math.random() * 20_000);
      const retarget = (text: string) =>
        // The script's path first: the state directory's path is its prefix.
        text
          .replaceAll(EGRESS_PROXY_SCRIPT, script)
          .replaceAll(EGRESS_ROOT, state)
          .replaceAll(String(EGRESS_PORT), String(port));
      writeFileSync(script, retarget(egressProxySource));
      writeFileSync(ensure, retarget(egressEnsureScript), { mode: 0o755 });
      const run = async () => {
        const child = Bun.spawn(["bash", ensure], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return child.exited;
      };
      const pid = () => readFileSync(join(state, "proxy.pid"), "utf8").trim();
      try {
        expect(await run()).toBe(0);
        const first = pid();
        expect(await run()).toBe(0);
        expect(pid()).toBe(first);
        // An update installing the script again, after the proxy started.
        await Bun.sleep(1_100);
        utimesSync(script, new Date(), new Date());
        expect(await run()).toBe(0);
        expect(pid()).not.toBe(first);
      } finally {
        try {
          process.kill(Number(pid()));
        } catch {
          // Already gone.
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
