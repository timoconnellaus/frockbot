/** Versioned, deliberately tiny postMessage seam for sandboxed Package pages. */
export const PACKAGE_IFRAME_BRIDGE_VERSION = 1 as const;

export type PackageIframeHostMessageV1 =
  | {
      schemaVersion: 1;
      type: "init";
      themeTokens: Record<string, string>;
      packageId: string;
      botId: string;
      slot: string;
    }
  | {
      schemaVersion: 1;
      type: "state";
      name: string;
      value: unknown;
    };

export type PackageIframePageMessageV1 =
  | {
      schemaVersion: 1;
      type: "callTool";
      name: string;
      input: unknown;
    }
  | {
      schemaVersion: 1;
      type: "resize";
      height: number;
    };

export interface PackageIframeContributionViewV1 {
  packageId: string;
  displayName: string;
  provenance: "Bot-authored" | "User-installed";
  artifact: {
    contentHash: string;
    size: number;
    mediaType: "text/html";
    bundlerVersion: string;
  };
  mounts: Array<{ slot: string; order?: number }>;
  declaredTools: string[];
}

export interface PackageIframeCompositionV1 {
  schemaVersion: 1;
  botId: string;
  generationId: string;
  contributions: PackageIframeContributionViewV1[];
}

export interface PackageIframeCatalogV1 extends PackageIframeCompositionV1 {
  /** Separate, anonymous serving origin; artifact paths are appended by the host. */
  artifactOrigin: string;
}

export interface PackageIframeToolCommandV1 {
  schemaVersion: 1;
  commandId: string;
  generationId: string;
  packageId: string;
  name: string;
  input: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function json(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} has too many entries`);
    for (const entry of value) json(entry, label, depth + 1);
    return;
  }
  const object = record(value, label);
  if (Object.keys(object).length > 256)
    throw new Error(`${label} has too many fields`);
  for (const entry of Object.values(object)) json(entry, label, depth + 1);
}

function boundedJsonWire(value: unknown, label: string): void {
  let wire: string | undefined;
  try {
    wire = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must contain only acyclic JSON`);
  }
  if (wire === undefined) throw new Error(`${label} must contain JSON`);
  if (new TextEncoder().encode(wire).byteLength > 64 * 1024) {
    throw new Error(`${label} exceeds the wire byte limit`);
  }
}

/** Exact host-side decoder; unknown message types and fields fail closed. */
export function decodePackageIframePageMessageV1(
  input: unknown,
): PackageIframePageMessageV1 {
  const value = record(input, "Package iframe message");
  boundedJsonWire(input, "Package iframe message");
  if (value.schemaVersion !== 1)
    throw new Error("Package iframe schemaVersion is unsupported");
  if (value.type === "callTool") {
    exact(
      value,
      ["schemaVersion", "type", "name", "input"],
      "Package iframe callTool",
    );
    const name = boundedString(value.name, "Package iframe callTool.name", 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
      throw new Error("Package iframe tool name is invalid");
    json(value.input, "Package iframe callTool.input");
    return {
      schemaVersion: 1,
      type: "callTool",
      name,
      input: structuredClone(value.input),
    };
  }
  if (value.type === "resize") {
    exact(value, ["schemaVersion", "type", "height"], "Package iframe resize");
    if (typeof value.height !== "number" || !Number.isFinite(value.height)) {
      throw new Error("Package iframe resize.height must be finite");
    }
    return { schemaVersion: 1, type: "resize", height: value.height };
  }
  throw new Error("Package iframe message type is invalid");
}

export function decodePackageIframeToolCommandV1(
  input: unknown,
): PackageIframeToolCommandV1 {
  const value = record(input, "Package iframe tool command");
  boundedJsonWire(input, "Package iframe tool command");
  exact(
    value,
    [
      "schemaVersion",
      "commandId",
      "generationId",
      "packageId",
      "name",
      "input",
    ],
    "Package iframe tool command",
  );
  if (value.schemaVersion !== 1)
    throw new Error("Package iframe tool command version is unsupported");
  const name = boundedString(
    value.name,
    "Package iframe tool command.name",
    64,
  );
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
    throw new Error("Package iframe tool command name is invalid");
  json(value.input, "Package iframe tool command.input");
  return {
    schemaVersion: 1,
    commandId: boundedString(
      value.commandId,
      "Package iframe tool command.commandId",
    ),
    generationId: boundedString(
      value.generationId,
      "Package iframe tool command.generationId",
    ),
    packageId: boundedString(
      value.packageId,
      "Package iframe tool command.packageId",
      64,
    ),
    name,
    input: structuredClone(value.input),
  };
}

export function packageIframeToolAllowedV1(
  contribution: Pick<PackageIframeContributionViewV1, "declaredTools">,
  name: string,
): boolean {
  return contribution.declaredTools.includes(name);
}

export function decodePackageIframeCatalogV1(
  input: unknown,
): PackageIframeCatalogV1 {
  const value = record(input, "Package iframe catalog");
  exact(
    value,
    [
      "schemaVersion",
      "botId",
      "generationId",
      "artifactOrigin",
      "contributions",
    ],
    "Package iframe catalog",
  );
  if (value.schemaVersion !== 1)
    throw new Error("Package iframe catalog version is unsupported");
  const artifactOrigin = boundedString(
    value.artifactOrigin,
    "Package iframe artifactOrigin",
    2_048,
  );
  const origin = new URL(artifactOrigin);
  if (
    origin.origin !== artifactOrigin ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new Error("Package iframe artifactOrigin is invalid");
  }
  if (!Array.isArray(value.contributions) || value.contributions.length > 64) {
    throw new Error("Package iframe contributions must be a bounded array");
  }
  const contributions = value.contributions.map((candidate, index) => {
    const label = `Package iframe contributions[${index}]`;
    const contribution = record(candidate, label);
    exact(
      contribution,
      [
        "packageId",
        "displayName",
        "provenance",
        "artifact",
        "mounts",
        "declaredTools",
      ],
      label,
    );
    const artifact = record(contribution.artifact, `${label}.artifact`);
    exact(
      artifact,
      ["contentHash", "size", "mediaType", "bundlerVersion"],
      `${label}.artifact`,
    );
    if (
      typeof artifact.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(artifact.contentHash)
    ) {
      throw new Error(`${label}.artifact.contentHash is invalid`);
    }
    if (
      !Number.isSafeInteger(artifact.size) ||
      (artifact.size as number) < 0 ||
      (artifact.size as number) > 256 * 1024 ||
      artifact.mediaType !== "text/html"
    ) {
      throw new Error(`${label}.artifact metadata is invalid`);
    }
    if (
      !Array.isArray(contribution.mounts) ||
      contribution.mounts.length === 0 ||
      contribution.mounts.length > 64
    ) {
      throw new Error(`${label}.mounts must be a non-empty bounded array`);
    }
    const mounts = contribution.mounts.map((candidateMount, mountIndex) => {
      const mount = record(candidateMount, `${label}.mounts[${mountIndex}]`);
      const hasOrder = mount.order !== undefined;
      exact(
        mount,
        hasOrder ? ["slot", "order"] : ["slot"],
        `${label}.mounts[${mountIndex}]`,
      );
      if (
        hasOrder &&
        (typeof mount.order !== "number" || !Number.isFinite(mount.order))
      ) {
        throw new Error(`${label}.mounts[${mountIndex}].order is invalid`);
      }
      return {
        slot: boundedString(
          mount.slot,
          `${label}.mounts[${mountIndex}].slot`,
          160,
        ),
        ...(hasOrder ? { order: mount.order as number } : {}),
      };
    });
    if (
      !Array.isArray(contribution.declaredTools) ||
      contribution.declaredTools.length > 64
    ) {
      throw new Error(`${label}.declaredTools must be a bounded array`);
    }
    const declaredTools = contribution.declaredTools.map((tool, toolIndex) =>
      boundedString(tool, `${label}.declaredTools[${toolIndex}]`, 64),
    );
    for (const mount of mounts) {
      const prefix = "frockbot.tool-result:";
      if (mount.slot === "frockbot.bot-settings-sections") continue;
      if (
        !mount.slot.startsWith(prefix) ||
        !declaredTools.includes(mount.slot.slice(prefix.length))
      ) {
        throw new Error(`${label}.mounts contains an unsafe slot`);
      }
    }
    if (
      contribution.provenance !== "Bot-authored" &&
      contribution.provenance !== "User-installed"
    ) {
      throw new Error(`${label}.provenance is invalid`);
    }
    return {
      packageId: boundedString(
        contribution.packageId,
        `${label}.packageId`,
        64,
      ),
      displayName: boundedString(
        contribution.displayName,
        `${label}.displayName`,
        128,
      ),
      provenance: contribution.provenance as "Bot-authored" | "User-installed",
      artifact: {
        contentHash: artifact.contentHash,
        size: artifact.size as number,
        mediaType: "text/html" as const,
        bundlerVersion: boundedString(
          artifact.bundlerVersion,
          `${label}.artifact.bundlerVersion`,
          128,
        ),
      },
      mounts,
      declaredTools,
    };
  });
  if (
    new Set(contributions.map((contribution) => contribution.packageId))
      .size !== contributions.length
  ) {
    throw new Error("Package iframe catalog contains duplicate Packages");
  }
  return {
    schemaVersion: 1,
    botId: boundedString(value.botId, "Package iframe botId"),
    generationId: boundedString(
      value.generationId,
      "Package iframe generationId",
    ),
    artifactOrigin,
    contributions,
  };
}

/** TypeScript contract shown by package_inspect_self. */
export const PACKAGE_IFRAME_BRIDGE_DTS_V1 = `
interface FrockBotIframeBridgeV1 {
  readonly ready: Promise<{ themeTokens: Record<string, string>; packageId: string; botId: string; slot: string }>;
  callTool(name: string, input: unknown): void;
  subscribe(name: string, listener: (value: unknown) => void): () => void;
  resize(height?: number): void;
}
declare global { interface Window { frockbot: FrockBotIframeBridgeV1 } }
// Messages are schemaVersion: 1. Results arrive on state name tool:<name>.
`;

/** Tiny inline helper authored pages may paste verbatim. */
export const PACKAGE_IFRAME_HELPER_JS_V1 = `(()=>{const V=1,L=new Map(),obj=v=>v&&typeof v==='object'&&!Array.isArray(v),exact=(v,ks)=>obj(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.prototype.hasOwnProperty.call(v,k)),str=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n,json=(v,d=0)=>d<=16&&(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||Array.isArray(v)&&v.length<=256&&v.every(x=>json(x,d+1))||obj(v)&&Object.keys(v).length<=256&&Object.values(v).every(x=>json(x,d+1))),wire=v=>{try{return new TextEncoder().encode(JSON.stringify(v)).byteLength<=65536}catch{return false}};let ok,fail;const ready=new Promise((r,j)=>{ok=r;fail=j});addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.schemaVersion!==V||!wire(m))return;if(m.type==='init'&&exact(m,['schemaVersion','type','themeTokens','packageId','botId','slot'])&&obj(m.themeTokens)&&Object.keys(m.themeTokens).length<=64&&Object.values(m.themeTokens).every(v=>typeof v==='string')&&str(m.packageId,64)&&str(m.botId,256)&&str(m.slot,160)){for(const [k,v] of Object.entries(m.themeTokens))document.documentElement.style.setProperty('--frockbot-'+k,v);ok({themeTokens:m.themeTokens,packageId:m.packageId,botId:m.botId,slot:m.slot});return}if(m.type==='state'&&exact(m,['schemaVersion','type','name','value'])&&str(m.name,256)&&json(m.value))for(const fn of L.get(m.name)||[])fn(m.value)});window.frockbot={ready,callTool(name,input){parent.postMessage({schemaVersion:V,type:'callTool',name,input},'*')},subscribe(name,fn){const s=L.get(name)||new Set();s.add(fn);L.set(name,s);return()=>s.delete(fn)},resize(height=document.documentElement.scrollHeight){parent.postMessage({schemaVersion:V,type:'resize',height},'*')}};setTimeout(()=>fail(new Error('FrockBot iframe init timed out')),10000)})();`;
