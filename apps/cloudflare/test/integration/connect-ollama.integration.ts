// Connecting an Ollama Cloud account, from the Connections surface.
//
// This was a browser spec until the client became Flutter Web. Nothing it
// claimed was ever about pixels: the card's "Ready · model list up to date" and
// "Not working" lines are `settings-frame.ts` rendering `connection.state` and
// `connection.modelCatalog.state` from the projection, and the model chooser's
// entries are that same catalog. So the claims live where they are decided —
// the route the Package contributes, and the User Durable Object's call out to
// the provider.
//
// Incident 4: pressing Connect answered "Failed to fetch" — the route existed
// on the backend Contribution and the client never reached it. That crossing is
// `connections.integration.ts`'s first case; here it is a precondition.
//
// Incident 5: a key that a catalog read accepts is not a key that can run
// inference. The Package validates with `POST /api/chat`, and the fake server
// reproduces the asymmetry measured against ollama.com: `/api/tags` and
// `/api/show` answer any key, `/api/chat` authenticates. The second test would
// fail outright if the Package went back to validating with a catalog read.
import { describe, expect, it } from "vitest";
import type { ConnectionView } from "@frockbot/core/configuration";
import {
  asUser,
  enableCustomModels,
  expectOkJson,
  freshUserId,
  OLLAMA_BAD_API_KEY,
  OLLAMA_GOOD_API_KEY,
  postAsUser,
  PROVISIONED_MODEL,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** The label a person types into the connect form. */
const CONNECTION_LABEL = "Local Ollama";

/** The one model the configured endpoint's catalog serves. */
const ENDPOINT_MODEL_ID = "glm-5.3-flash:cloud";

async function installProvider(userId: string): Promise<void> {
  const enabled = await enableCustomModels(userId, "custom-models");
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-provider",
      expectedRevision: enabled,
      packageId: PROVISIONED_MODEL.packageId,
      version: "0.0.1",
    }),
  );
}

/** Press Connect: the command the connect form posts, with a key. */
async function connect(
  userId: string,
  commandId: string,
  apiKey: string,
): Promise<string> {
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId,
      packageId: PROVISIONED_MODEL.packageId,
      connectionTypeId: PROVISIONED_MODEL.connectionTypeId,
      label: CONNECTION_LABEL,
      apiKey,
    }),
  )) as { connectionId: string };
  return receipt.connectionId;
}

interface SettingsViewV1 {
  revision: number;
  connections: ConnectionView[];
}

async function readSettings(userId: string): Promise<SettingsViewV1> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as SettingsViewV1;
}

function connectionIn(
  settings: SettingsViewV1,
  connectionId: string,
): ConnectionView {
  const connection = settings.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  );
  expect(connection).toBeDefined();
  return connection!;
}

describe("connecting an Ollama Cloud account", () => {
  it("a good key reaches ready and lists the endpoint's models", async () => {
    const userId = freshUserId("connect-ollama-good");
    await installProvider(userId);

    const connectionId = await connect(
      userId,
      "connect-good",
      OLLAMA_GOOD_API_KEY,
    );

    const settings = await readSettings(userId);
    const connection = connectionIn(settings, connectionId);
    // "Ready · model list up to date", and the label the form was given.
    expect(connection.state).toBe("ready");
    expect(connection.modelCatalog?.state).toBe("fresh");
    expect(connection.displayName).toBe(CONNECTION_LABEL);

    // The catalog the Connection resolved is the one the configured endpoint
    // serves — not a hard-coded list — and it is what the model choosers
    // offer, because the chooser reads this projection and nothing else.
    expect(
      connection.modelCatalog?.models.map((model) => model.providerModelId),
    ).toEqual([ENDPOINT_MODEL_ID]);

    // And an offered entry is one the account can actually be set to, which is
    // what pressing it in the chooser does.
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/set-account-model",
        commandId: "choose-model",
        expectedRevision: settings.revision,
        model: { connectionId, providerModelId: ENDPOINT_MODEL_ID },
      }),
    );
    // `?view=2` is the projection that carries the account choice; the legacy
    // browser shape drops the field.
    expect(
      await expectOkJson(await asUser(userId, "/api/settings?view=2")),
    ).toMatchObject({
      accountModel: { connectionId, providerModelId: ENDPOINT_MODEL_ID },
    });
  });

  it("a key the endpoint refuses for inference never reaches ready", async () => {
    const userId = freshUserId("connect-ollama-bad");
    await installProvider(userId);

    const connectionId = await connect(
      userId,
      "connect-bad",
      OLLAMA_BAD_API_KEY,
    );

    // The Connection itself carries the reason, in the words the surface
    // prints; the state is the one that renders as "Not working".
    const connection = connectionIn(await readSettings(userId), connectionId);
    expect(connection.failure ?? "").toContain(
      "Ollama Cloud rejected the key for inference",
    );
    expect(connection.state).not.toBe("ready");
    expect(connection.state).toBe("failed");
    // No "Ready · …" line is reachable: a catalog read that answers any key
    // must not leave a usable model list behind either.
    expect(connection.modelCatalog?.state ?? "absent").not.toBe("fresh");
  });
});
