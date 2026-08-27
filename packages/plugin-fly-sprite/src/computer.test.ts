/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@frockbot/agent-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createFlySpriteAgentPlugin } from "./agent.ts";
import {
  type BrowserAction,
  FlySpriteComputer,
  type SpriteHandle,
  type SpriteServiceStream,
  type SpritesClientHandle,
} from "./computer.ts";

class FakeStream implements SpriteServiceStream {
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { type: "started" };
  }
}

class FakeSprite implements SpriteHandle {
  name = "frockbot-test";
  url = "https://frockbot-test-123.sprites.app/";
  commands: Array<{ file: string; args: string[] }> = [];
  service?: { name: string; httpPort?: number };
  auth?: string;
  leaseOwner?: string;
  leaseFresh = true;

  execFileHTTP(
    file: string,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ file, args });
    if (file === "cat")
      return Promise.resolve({ stdout: "secret-pass\n", stderr: "" });
    const shell = args.at(-1) ?? "";
    const claimedOwner = /printf '%s\\n' '([^']+)'/.exec(shell)?.[1];
    if (claimedOwner) {
      if (this.leaseOwner === claimedOwner) {
        this.leaseFresh = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (this.leaseOwner && this.leaseFresh) {
        return Promise.reject(new Error("human control is active"));
      }
      this.leaseOwner = claimedOwner;
      this.leaseFresh = true;
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    const comparedOwner = /\[ "\$owner" = '([^']+)' \]/.exec(shell)?.[1];
    if (shell.includes("touch /home/sprite/.frockbot/human-control")) {
      return comparedOwner === this.leaseOwner
        ? Promise.resolve({ stdout: "", stderr: "" })
        : Promise.reject(new Error("lease owner changed"));
    }
    if (shell.includes("then rm -f /home/sprite/.frockbot/human-control")) {
      if (comparedOwner === this.leaseOwner) this.leaseOwner = undefined;
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (
      shell.includes("The user is controlling the computer") &&
      this.leaseOwner &&
      this.leaseFresh &&
      comparedOwner !== this.leaseOwner
    ) {
      return Promise.reject(new Error("The user is controlling the computer"));
    }
    if (
      shell.includes("The user is controlling the computer") &&
      this.leaseOwner &&
      !this.leaseFresh
    ) {
      this.leaseOwner = undefined;
    }
    if (shell.includes("echo tool-output")) {
      return Promise.resolve({ stdout: "tool-output\n", stderr: "" });
    }
    if (shell.includes("browser.mjs")) {
      return Promise.resolve({
        stdout: JSON.stringify({
          url: "https://example.com",
          snapshot: "- heading",
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }

  createService(
    name: string,
    config: { httpPort?: number },
  ): Promise<SpriteServiceStream> {
    this.service = { name, httpPort: config.httpPort };
    return Promise.resolve(new FakeStream());
  }

  updateURLSettings(settings: { auth: string }): Promise<void> {
    this.auth = settings.auth;
    return Promise.resolve();
  }
}

class FakeClient implements SpritesClientHandle {
  readonly sprite = new FakeSprite();

  listAllSprites(): Promise<SpriteHandle[]> {
    return Promise.resolve([this.sprite]);
  }

  createSprite(): Promise<SpriteHandle> {
    throw new Error("existing Sprite should be reused");
  }

  getSprite(): Promise<SpriteHandle> {
    return Promise.resolve(this.sprite);
  }
}

class StubComputer extends FlySpriteComputer {
  runs: string[] = [];
  browserActions: BrowserAction[] = [];

  constructor() {
    super({ client: new FakeClient(), spriteName: "frockbot-test" });
  }

  override run(command: string): Promise<string> {
    this.runs.push(command);
    return Promise.resolve("ran");
  }

  override browser(action: BrowserAction): Promise<string> {
    this.browserActions.push(action);
    return Promise.resolve("snapshot");
  }
}

describe("Fly Sprite computer", () => {
  test("provisions a persistent noVNC service and returns an authenticated viewer", async () => {
    const client = new FakeClient();
    const computer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });

    const connection = await computer.ensure();

    expect(client.sprite.service).toEqual({
      name: "frockbot-desktop",
      httpPort: 6080,
    });
    expect(client.sprite.auth).toBe("public");
    expect(connection.viewerUrl).toContain("/vnc.html#");
    expect(connection.viewerUrl).toContain("password=secret-pass");
    expect(client.sprite.commands[0]?.args.join(" ")).toContain("apt-get");
  });

  test("blocks new agent provisioning and tools while human control is active", async () => {
    const client = new FakeClient();
    const host = new FlySpriteComputer({ client, spriteName: "frockbot-test" });
    await host.ensure();
    await host.takeControl();

    const agent = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
      respectHumanControl: true,
    });
    await expect(
      agent.run("echo tool-output", new AbortController().signal),
    ).rejects.toThrow("user is controlling");
    await expect(
      agent.browser(
        { action: "navigate", url: "https://example.com" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("user is controlling");

    await host.releaseControl();
    expect(
      await agent.run("echo tool-output", new AbortController().signal),
    ).toContain("tool-output");
  });

  test("blocks a second desktop from provisioning during active control", async () => {
    const client = new FakeClient();
    const owner = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
      respectHumanControl: true,
    });
    await owner.ensure();
    await owner.takeControl();

    const other = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
      respectHumanControl: true,
    });
    await expect(other.ensure()).rejects.toThrow("user is controlling");
  });

  test("lets a replacement desktop atomically acquire an expired lease", async () => {
    const client = new FakeClient();
    const owner = new FlySpriteComputer({ client, spriteName: "frockbot-test" });
    const replacement = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    await owner.ensure();
    await owner.takeControl();
    client.sprite.leaseFresh = false;

    await replacement.takeControl();

    expect(client.sprite.leaseOwner).toBeDefined();
    await expect(owner.refreshControl()).rejects.toThrow("lease owner changed");
  });

  test("does not let another desktop owner release an active lease", async () => {
    const client = new FakeClient();
    const owner = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const other = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    await owner.ensure();
    await owner.takeControl();

    await other.releaseControl();

    const agent = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
      respectHumanControl: true,
    });
    await expect(
      agent.run("echo tool-output", new AbortController().signal),
    ).rejects.toThrow("user is controlling");
  });

  test("registers executable computer tools", async () => {
    const computer = new StubComputer();
    const harness = await createPluginHarness([ToolRegistry]);
    await harness.mount(createFlySpriteAgentPlugin(computer));

    const exec = await harness.root.tools.prepare(
      { id: "exec", name: "computer_exec", input: { command: "pwd" } },
      { sessionId: "test", signal: new AbortController().signal },
    );
    expect(exec.kind).toBe("ready");
    if (exec.kind === "ready") {
      expect(
        await harness.root.tools.executePrepared(exec, {
          sessionId: "test",
          signal: new AbortController().signal,
        }),
      ).toEqual({ content: "ran", isError: false });
    }
    expect(computer.runs).toEqual(["pwd"]);
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-fly-sprite",
      contributionKinds: ["runtime", "client", "desktop"],
    });
  });
});
