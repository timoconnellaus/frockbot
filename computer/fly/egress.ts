// The Sprite half of credentialed egress (`computer/egress.ts`): a small
// HTTPS proxy on loopback that a `computer_exec` shell is pointed at.
//
// It terminates TLS only for the connected-app hosts the Worker attaches an
// account to, with a certificate from a CA the Sprite makes for itself and
// trusts through the usual environment variables, and posts each request it
// reads to the Worker under the exec call's token. Every other destination is
// a plain tunnel: the proxy never reads it and never sees a credential,
// because none exists on the Sprite.
//
// The proxy is started on demand by the prelude each exec carries and stays
// up; a Sprite that cannot start it runs the command with no proxy at all, so
// a broken proxy costs connected accounts and nothing else.

import { COMPUTER_EGRESS_HOSTS_V1 } from "../egress.js";
import { shellQuote } from "./shell.js";

/**
 * `RUNTIME_ROOT` from `runtime.ts`, restated because `runtime.ts` installs
 * these files and importing it back would be a cycle; `egress.test.ts` holds
 * the two to each other.
 */
export const EGRESS_RUNTIME_ROOT = "/home/box/.frockbot";

export const EGRESS_PORT = 18089;
/** Where the proxy keeps its CA, leaf certificates, bundle and log. */
export const EGRESS_ROOT = `${EGRESS_RUNTIME_ROOT}/egress`;
export const EGRESS_PROXY_SCRIPT = `${EGRESS_RUNTIME_ROOT}/egress-proxy.mjs`;
export const EGRESS_ENSURE_SCRIPT = `${EGRESS_RUNTIME_ROOT}/egress-ensure.sh`;
/** The system roots plus the Sprite's own CA: what every client is told to trust. */
export const EGRESS_BUNDLE = `${EGRESS_ROOT}/bundle.pem`;
export const EGRESS_CA = `${EGRESS_ROOT}/ca.pem`;
/**
 * The token `gh` is given so it tries at all. The proxy drops every
 * `authorization` header before a request leaves the Sprite.
 */
export const EGRESS_PLACEHOLDER_TOKEN = "frockbot-connected-account";
const EGRESS_REQUEST_MAX_BYTES = 1_000_000;

export const egressProxySource = `// Installed by FrockBot. Loopback HTTPS proxy for connected accounts.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const PORT = ${EGRESS_PORT};
const DIR = ${JSON.stringify(EGRESS_ROOT)};
const HOSTS = new Set(${JSON.stringify(COMPUTER_EGRESS_HOSTS_V1)});
const MAX_BODY = ${EGRESS_REQUEST_MAX_BYTES};
const TIMEOUT_MS = 110000;
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const DROP = new Set(["authorization", "proxy-authorization", "proxy-connection", "connection", "keep-alive", "transfer-encoding", "te", "upgrade", "host", "content-length", "accept-encoding"]);
const DROP_BACK = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "content-encoding"]);

function openssl(args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function ensureCa() {
  fs.mkdirSync(DIR + "/certs", { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DIR + "/ca.pem") || !fs.existsSync(DIR + "/ca.key")) {
    openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", DIR + "/ca.key.tmp", "-out", DIR + "/ca.pem.tmp", "-days", "3650",
      "-subj", "/CN=FrockBot Computer egress",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    fs.renameSync(DIR + "/ca.key.tmp", DIR + "/ca.key");
    fs.renameSync(DIR + "/ca.pem.tmp", DIR + "/ca.pem");
    fs.rmSync(DIR + "/certs", { recursive: true, force: true });
    fs.mkdirSync(DIR + "/certs", { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(DIR + "/leaf.key")) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", DIR + "/leaf.key.tmp"]);
    fs.renameSync(DIR + "/leaf.key.tmp", DIR + "/leaf.key");
  }
  const system = fs.existsSync(SYSTEM_BUNDLE) ? fs.readFileSync(SYSTEM_BUNDLE, "utf8") : "";
  fs.writeFileSync(DIR + "/bundle.pem.tmp", system + "\\n" + fs.readFileSync(DIR + "/ca.pem", "utf8"));
  fs.renameSync(DIR + "/bundle.pem.tmp", DIR + "/bundle.pem");
}

const contexts = new Map();
function contextFor(host) {
  const cached = contexts.get(host);
  if (cached) return cached;
  const cert = DIR + "/certs/" + host + ".pem";
  if (!fs.existsSync(cert)) {
    const csr = DIR + "/certs/" + host + ".csr";
    const ext = DIR + "/certs/" + host + ".ext";
    fs.writeFileSync(ext, "subjectAltName=DNS:" + host + "\\nextendedKeyUsage=serverAuth\\nbasicConstraints=CA:FALSE\\nkeyUsage=critical,digitalSignature\\n");
    openssl(["req", "-new", "-key", DIR + "/leaf.key", "-subj", "/CN=" + host, "-out", csr]);
    openssl(["x509", "-req", "-in", csr, "-CA", DIR + "/ca.pem", "-CAkey", DIR + "/ca.key",
      "-set_serial", "0x" + randomBytes(12).toString("hex"), "-days", "397",
      "-extfile", ext, "-out", cert + ".tmp"]);
    fs.renameSync(cert + ".tmp", cert);
  }
  const context = tls.createSecureContext({ key: fs.readFileSync(DIR + "/leaf.key"), cert: fs.readFileSync(cert) });
  contexts.set(host, context);
  return context;
}

function proxyToken(header) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : undefined;
}

function endpointOf(token) {
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    const url = new URL(value.u);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function reply(res, status, message) {
  const body = Buffer.from(JSON.stringify({ message }));
  res.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forward(req, res) {
  const token = req.socket.frockbotToken;
  const host = req.socket.frockbotHost;
  const endpoint = token ? endpointOf(token) : undefined;
  if (!endpoint) {
    reply(res, 407, "This API is reached through the person's connected account, which is only available to commands run by computer_exec.");
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    reply(res, 413, "The request body is too large to send through a connected account.");
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP.has(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  let answer;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        method: req.method,
        url: "https://" + host + req.url,
        headers,
        ...(body.length ? { bodyBase64: body.toString("base64") } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) {
      reply(res, 407, "This command's access to connected accounts has expired. Run it again with computer_exec.");
      return;
    }
    if (!response.ok) {
      reply(res, 502, "FrockBot could not send this request (" + response.status + ").");
      return;
    }
    answer = await response.json();
  } catch {
    reply(res, 502, "FrockBot could not be reached to send this request. Its outcome is unknown; do not repeat a change without checking.");
    return;
  }
  const bytes = Buffer.from(typeof answer.bodyBase64 === "string" ? answer.bodyBase64 : "", "base64");
  const back = {};
  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    if (typeof value === "string" && !DROP_BACK.has(name.toLowerCase())) back[name] = value;
  }
  back["content-length"] = bytes.length;
  res.writeHead(Number.isInteger(answer.status) ? answer.status : 502, back);
  res.end(req.method === "HEAD" ? undefined : bytes);
}

const inner = http.createServer((req, res) => {
  forward(req, res).catch(() => {
    if (!res.headersSent) reply(res, 502, "The connected-account proxy failed.");
    else res.destroy();
  });
});

function tunnel(host, port, socket, head) {
  const upstream = net.connect(port, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

const server = http.createServer((req, res) => {
  reply(res, 405, "Only HTTPS through CONNECT is proxied here.");
});
server.on("connect", (req, socket, head) => {
  socket.on("error", () => {});
  const match = /^([A-Za-z0-9.-]+):(\\d{1,5})$/.exec(req.url ?? "");
  if (!match) {
    socket.end("HTTP/1.1 400 Bad Request\\r\\n\\r\\n");
    return;
  }
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!HOSTS.has(host) || port !== 443) {
    tunnel(host, port, socket, head);
    return;
  }
  let context;
  try {
    context = contextFor(host);
  } catch (error) {
    console.error("certificate for " + host + " failed", error);
    socket.end("HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n");
    return;
  }
  socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
  if (head && head.length) socket.unshift(head);
  const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
  secure.on("error", () => socket.destroy());
  secure.frockbotToken = proxyToken(req.headers["proxy-authorization"]);
  secure.frockbotHost = host;
  inner.emit("connection", secure);
});

ensureCa();
server.listen(PORT, "127.0.0.1", () => {
  // Written once listening: the ensure script restarts a proxy whose script is
  // newer than this file, so an update's new host list takes effect.
  fs.writeFileSync(DIR + "/proxy.pid", String(process.pid));
});
`;

export const egressEnsureScript = `#!/usr/bin/env bash
# Installed by FrockBot. Starts the connected-account proxy if it is not up;
# exits 0 only when it is listening and its CA bundle exists.
DIR=${shellQuote(EGRESS_ROOT)}
SCRIPT=${shellQuote(EGRESS_PROXY_SCRIPT)}
listening() { (exec 3<>/dev/tcp/127.0.0.1/${EGRESS_PORT}) 2>/dev/null; }
current() { [ -f "$DIR/proxy.pid" ] && ! [ "$SCRIPT" -nt "$DIR/proxy.pid" ]; }
if listening && current && [ -s ${shellQuote(EGRESS_BUNDLE)} ]; then exit 0; fi
mkdir -p "$DIR" && chmod 700 "$DIR" || exit 1
# The proxy is started with this lock's descriptor closed, so it never holds
# it. (A proxy from before that change holds \`start.lock\`, hence the name.)
exec 9>"$DIR/ensure.lock"
flock -w 10 9 || exit 1
# A proxy started from an older script keeps its old host list: replace it.
if listening && ! current; then
  if [ -f "$DIR/proxy.pid" ]; then kill "$(cat "$DIR/proxy.pid")" 2>/dev/null; else pkill -f "$SCRIPT" 2>/dev/null; fi
  for _ in $(seq 1 30); do listening || break; sleep 0.1; done
  rm -f "$DIR/proxy.pid"
fi
if ! listening; then
  if [ -r /etc/profile.d/languages_paths ]; then
    PATH="$(tr '\\n' ':' < /etc/profile.d/languages_paths)$PATH"
    export PATH
  fi
  if [ -f "$DIR/proxy.log" ] && [ "$(stat -c %s "$DIR/proxy.log")" -gt 1000000 ]; then : > "$DIR/proxy.log"; fi
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \\
    setsid nohup node "$SCRIPT" >>"$DIR/proxy.log" 2>&1 </dev/null 9>&- &
  for _ in $(seq 1 60); do listening && [ -f "$DIR/proxy.pid" ] && break; sleep 0.1; done
fi
listening && current && [ -s ${shellQuote(EGRESS_BUNDLE)} ]
`;

/**
 * The lines a `computer_exec` command is prefixed with to reach connected
 * accounts: start the proxy, then point every client at it and at the CA it
 * signs with. The token is the exec call's own and expires with it.
 */
export function flyEgressShellPreludeV1(token: string): string {
  const proxy = `http://frockbot:${token}@127.0.0.1:${EGRESS_PORT}`;
  return [
    `if ${shellQuote(EGRESS_ENSURE_SCRIPT)} >/dev/null 2>&1; then`,
    `  export HTTPS_PROXY=${shellQuote(proxy)} https_proxy=${shellQuote(proxy)}`,
    `  export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1`,
    `  export SSL_CERT_FILE=${shellQuote(EGRESS_BUNDLE)} REQUESTS_CA_BUNDLE=${shellQuote(EGRESS_BUNDLE)} CURL_CA_BUNDLE=${shellQuote(EGRESS_BUNDLE)} GIT_SSL_CAINFO=${shellQuote(EGRESS_BUNDLE)}`,
    `  export NODE_EXTRA_CA_CERTS=${shellQuote(EGRESS_CA)} NODE_USE_ENV_PROXY=1`,
    `  export GH_TOKEN="\${GH_TOKEN:-${EGRESS_PLACEHOLDER_TOKEN}}"`,
    `fi`,
  ].join("\n");
}
