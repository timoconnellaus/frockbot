// Seed through the production command surface, never by writing DO storage.
const origin = "http://127.0.0.1:8787";
async function request(path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-frockbot-user-id": "development",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Local dev server: HTTP ${response.status}`);
  return response.json();
}
const directory = await request("/api/bots");
if (!Array.isArray(directory.bots) || !Number.isInteger(directory.revision)) {
  throw new Error("Invalid local Bot directory");
}
if (directory.bots.length === 0) {
  const receipt = await request("/api/bots", {
    schemaVersion: 1,
    type: "bot/create",
    commandId: "phone-dev-bootstrap-v1",
    expectedRevision: directory.revision,
    botId: "phone-dev",
    name: "Dev Bot",
  });
  if (receipt.status !== "applied") throw new Error("Could not create Dev Bot");
}
export {};
