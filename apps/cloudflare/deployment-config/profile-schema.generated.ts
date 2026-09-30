import type { FromSchema } from "json-schema-to-ts";

export const DEPLOYMENT_PROFILE_SCHEMA_V1 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://frockbot.com/schemas/deployment-profile-v1.json",
  title: "FrockBot deployment profile",
  description:
    "Who a deployment is: the Cloudflare account, the Worker names, the hostnames, the auth and payments Packages and the resources that carry identity. `frockbot-deployment-config` (`bun run deployment:config` in the FrockBot repository) reads one of these and writes the deployable wrangler configs from the tracked ones, which hold bindings and migrations and no identity at all.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "accountId", "prefix", "authPackage"],
  properties: {
    schemaVersion: {
      const: 1,
    },
    name: {
      description:
        "The profile's own name. Must match the file name, and names the directory under `.deployment/`.",
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
    },
    accountId: {
      description:
        "The Cloudflare account every Worker in this deployment belongs to.",
      type: "string",
      pattern: "^[0-9a-f]{32}$",
    },
    region: {
      description:
        "Where a fresh deployment's R2 buckets and Vectorize index are created. The installer passes it; no wrangler config carries it, so changing it never moves an existing resource.",
      type: "string",
      enum: ["wnam", "enam", "weur", "eeur", "apac", "oc"],
    },
    prefix: {
      description:
        "What every unnamed Worker and resource below is named from.",
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
    },
    workers: {
      description:
        "One entry per deployable. An entry that is absent is not generated and not deployed, which is how a profile leaves out the hosted-only marketing site and admin portal.",
      type: "object",
      additionalProperties: false,
      properties: {
        app: {
          $ref: "#/$defs/worker",
        },
        computerHost: {
          $ref: "#/$defs/worker",
        },
        appletBuild: {
          $ref: "#/$defs/worker",
        },
        marketing: {
          $ref: "#/$defs/worker",
        },
        adminPortal: {
          $ref: "#/$defs/worker",
        },
      },
    },
    images: {
      description:
        "Where the two container Workers get their image. Absent is `dockerfile`: wrangler builds it on the deploying machine, which needs Docker. `registry` pulls the image `release.yml` published for one tag, which is what an installer with no Docker deploys.",
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: {
          enum: ["dockerfile", "registry"],
        },
        registry: {
          description:
            "The registry and namespace the images were published under, without the image name. It must be one Cloudflare Containers pull from: the managed registry, Docker Hub, Amazon ECR or Google Artifact Registry (see the README).",
          type: "string",
          pattern: "^[a-z0-9][a-z0-9.-]*(:[0-9]+)?(/[a-z0-9][a-z0-9._-]*)*$",
        },
        tag: {
          description:
            "The image tag, which is the release version the deployment is running.",
          type: "string",
          pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$",
        },
      },
      allOf: [
        {
          if: {
            properties: {
              source: {
                const: "registry",
              },
            },
            required: ["source"],
          },
          then: {
            properties: {
              registry: true,
              tag: true,
            },
            required: ["registry", "tag"],
          },
        },
      ],
    },
    authPackage: {
      description:
        "Which sign-in Package this deployment builds: one of the two `@frockbot/cloudflare` ships, or a path, relative to this profile file, to a chooser module a white-label wrote — a module exporting `AUTH_PACKAGE_V1: AuthPackageBuildV1` and the `AuthPackageEnvironmentV1` type, as `apps/cloudflare/src/auth-package.ts` does (ADR 0038 §3). Written as a wrangler `alias` for `#auth-package` unless it is `better-auth`, which the tracked source already resolves.",
      anyOf: [
        {
          enum: ["better-auth", "access"],
        },
        {
          type: "string",
          pattern: "^\\.{1,2}/\\S+\\.(ts|mts|js|mjs)$",
        },
      ],
    },
    authEnvironment: {
      description:
        "What a white-label's own auth Package reads off `env`, which this repository cannot know: `secrets` are required by the production-secrets check and carried by the deploy's secrets file, and `vars` are written into the app Worker's `vars`. Together they must name exactly the settings the chooser's `AUTH_PACKAGE_V1.required` lists. Only for an auth Package named by path.",
      type: "object",
      additionalProperties: false,
      properties: {
        secrets: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "why"],
            properties: {
              name: {
                $ref: "#/$defs/envName",
              },
              why: {
                type: "string",
                minLength: 1,
              },
            },
          },
        },
        vars: {
          type: "object",
          propertyNames: {
            $ref: "#/$defs/envName",
          },
          additionalProperties: {
            type: "string",
          },
        },
      },
    },
    payments: {
      description:
        "Which payments Package this deployment builds: `stripe`, which the tracked source resolves; `none`, a deployment that does not bill; or a path, relative to this profile file, to a chooser module a white-label wrote — a module exporting `PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1` and the `PaymentsPackageEnvironmentV1` type, as `apps/cloudflare/src/payments.ts` does (ADR 0038 §1). Written as a wrangler `alias` for `#payments` unless it is `stripe`. Absent, `stripe`.",
      anyOf: [
        {
          enum: ["stripe", "none"],
        },
        {
          type: "string",
          pattern: "^\\.{1,2}/\\S+\\.(ts|mts|js|mjs)$",
        },
      ],
    },
    paymentsEnvironment: {
      description:
        "What a white-label's own payments Package reads off `env`, which this repository cannot know: `secrets` are required by the production-secrets check and carried by the deploy's secrets file, and `vars` are written into the app Worker's `vars`. Together they must name exactly the settings the chooser's `PAYMENTS_PACKAGE_V1.required` lists. Only for a payments Package named by path.",
      type: "object",
      additionalProperties: false,
      properties: {
        secrets: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "why"],
            properties: {
              name: {
                $ref: "#/$defs/envName",
              },
              why: {
                type: "string",
                minLength: 1,
              },
            },
          },
        },
        vars: {
          type: "object",
          propertyNames: {
            $ref: "#/$defs/envName",
          },
          additionalProperties: {
            type: "string",
          },
        },
      },
    },
    brand: {
      description:
        "The brand module this deployment builds, relative to this profile file: a TypeScript module exporting `BRAND_V1: BrandV1` (`core/contracts/brand.ts`). Written as a wrangler `alias` for `#brand`. Absent, the Worker resolves `#brand` to FrockBot's own, `apps/cloudflare/src/brand.ts`.",
      type: "string",
      pattern: "^\\S+\\.ts$",
    },
    webClient: {
      description:
        "The directory the app Worker's static assets are uploaded from, relative to this profile file: the web client `build-flutter-web.ts` staged for this deployment's own application. Absent, the package's own `dist/web`, which is where FrockBot's build stages FrockBot's client.",
      type: "string",
      minLength: 1,
    },
    access: {
      description:
        "The Cloudflare Access application the `access` Package verifies against. Written as the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars.",
      type: "object",
      additionalProperties: false,
      required: ["teamDomain", "aud"],
      properties: {
        teamDomain: {
          $ref: "#/$defs/hostname",
        },
        aud: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
      },
    },
    adminEmails: {
      description:
        "The deployment's admins: they bypass admission, and a debug Turn may act as one of them. The debug surface itself is gated on `DEBUG_TOKEN`. Only a verified email counts. The installer sets it as the Worker secret `FROCKBOT_ADMIN_EMAILS`; no generated config carries it, which is why the hosted profile leaves it to the repository secret it already has.",
      type: "array",
      minItems: 1,
      items: {
        $ref: "#/$defs/email",
      },
    },
    adminUserIds: {
      description:
        "Admins by User id, beside `adminEmails`, for a deployment whose people have no verified email: an id here is an admin exactly as a verified email on `adminEmails` is. The installer sets it as the Worker secret `FROCKBOT_ADMIN_USER_IDS`; no generated config carries it.",
      type: "array",
      minItems: 1,
      items: {
        type: "string",
        pattern: "^[^,\\s]+$",
      },
    },
    d1DatabaseId: {
      description:
        "The `AUTH_DB` database. Required by the `better-auth` Package unless the deploy supplies it with `--d1-database-id`, which is how a disposable stage names a database it creates in the same job.",
      type: "string",
      pattern: "^[0-9a-fA-F-]{36}$",
    },
    aiGateway: {
      description:
        "The AI Gateway that serves the platform model. Absent, the Worker takes the `AI` binding and Auto resolves to a concrete Workers AI model.",
      type: "object",
      additionalProperties: false,
      required: ["accountId"],
      properties: {
        accountId: {
          description:
            "The account owning the Gateway. Present with the `FROCK_AI_GATEWAY_TOKEN` secret, requests take the compat HTTP transport — the only one that accepts a dynamic route.",
          type: "string",
          pattern: "^[0-9a-f]{32}$",
        },
        id: {
          type: "string",
          pattern: "^[A-Za-z0-9-]+$",
        },
        autoRoute: {
          type: "string",
          pattern: "^[A-Za-z0-9-]+$",
        },
      },
    },
    nativeAuth: {
      description:
        "The native returns this deployment serves: `android`, the released Mac and iPhone apps (`macos`, `ios`), and the FrockBot Dev builds (`macos-dev`, `ios-dev`), each named only where such a build signs in. Nothing is implied by another entry. Absent, the deployment offers no native sign-in at all.",
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "string",
        enum: ["android", "macos", "macos-dev", "ios", "ios-dev"],
      },
    },
    nativeApps: {
      description:
        "The signed native apps this deployment's App Links and Universal Links name, in `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`. Written as the `NATIVE_APPS` var. Absent, the deployment serves neither file.",
      type: "object",
      additionalProperties: false,
      properties: {
        android: {
          description:
            "Each Android app by package name, with the SHA-256 fingerprints of the certificates that sign it.",
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["packageName", "sha256CertFingerprints"],
            properties: {
              packageName: {
                type: "string",
                pattern: "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$",
              },
              sha256CertFingerprints: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: {
                  type: "string",
                  pattern: "^[0-9A-F]{2}(:[0-9A-F]{2}){31}$",
                },
              },
            },
          },
        },
        apple: {
          description:
            "The Apple app ids (`<team id>.<bundle id>`) the association names for the released Mac and iPhone returns.",
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[A-Z0-9]{10}\\.[A-Za-z0-9.-]+$",
          },
        },
      },
    },
    email: {
      description:
        "Email to and from Bots, both directions on one domain. Each Bot's address is `<bot-slug>.<username>@<domain>`. The domain becomes the app Worker's `EMAIL_DOMAIN` var, which the `email()` handler receives mail for, and the app Worker gains a `send_email` binding named `SEND_EMAIL`, through which each Bot sends from its own address on that domain and no other. Absent, no Bot has an address, every message is refused and nothing is sent. The domain's Email Routing catch-all and its onboarding for Email Sending are set up in Cloudflare by hand: see `apps/cloudflare/deployment-config/README.md`.",
      type: "object",
      additionalProperties: false,
      required: ["domain"],
      properties: {
        domain: {
          $ref: "#/$defs/hostname",
        },
      },
    },
    voice: {
      description:
        "The voice call's provider. `provider` becomes the app Worker's `VOICE_PROVIDER` var: `gemini-live` (Gemini Live on `GEMINI_API_KEY`) or `openai-realtime` (OpenAI Realtime on `OPENAI_API_KEY`). Absent, calls run on Gemini Live. Dictation is OpenAI either way.",
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: {
        provider: {
          enum: ["gemini-live", "openai-realtime"],
        },
      },
    },
    resources: {
      description:
        "Names that carry identity. Each is derived from `prefix` when absent.",
      type: "object",
      additionalProperties: false,
      properties: {
        applicationArtifactsBucket: {
          $ref: "#/$defs/resourceName",
        },
        memoryFilesBucket: {
          $ref: "#/$defs/resourceName",
        },
        memoryIndex: {
          $ref: "#/$defs/resourceName",
        },
        authDatabaseName: {
          $ref: "#/$defs/resourceName",
        },
        analyticsDataset: {
          $ref: "#/$defs/resourceName",
        },
      },
    },
  },
  allOf: [
    {
      if: {
        properties: {
          authPackage: {
            const: "access",
          },
        },
        required: ["authPackage"],
      },
      then: {
        properties: {
          access: true,
        },
        required: ["access"],
      },
    },
    {
      if: {
        properties: {
          authPackage: {
            enum: ["better-auth", "access"],
          },
        },
        required: ["authPackage"],
      },
      then: {
        properties: {
          authEnvironment: false,
        },
      },
      else: {
        properties: {
          authEnvironment: true,
        },
        required: ["authEnvironment"],
      },
    },
    {
      if: {
        properties: {
          payments: {
            not: {
              enum: ["stripe", "none"],
            },
          },
        },
        required: ["payments"],
      },
      then: {
        properties: {
          paymentsEnvironment: true,
        },
        required: ["paymentsEnvironment"],
      },
      else: {
        properties: {
          paymentsEnvironment: false,
        },
      },
    },
  ],
  $defs: {
    worker: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          $ref: "#/$defs/resourceName",
        },
        hostnames: {
          description:
            "Custom domains this Worker answers on. Absent, the Worker takes its `workers.dev` hostname, which is what a deployment with no zone has.",
          type: "array",
          minItems: 1,
          items: {
            $ref: "#/$defs/hostname",
          },
        },
      },
    },
    hostname: {
      type: "string",
      pattern:
        "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
    },
    email: {
      type: "string",
      pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    },
    resourceName: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
      maxLength: 63,
    },
    envName: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9_]*$",
    },
  },
} as const;

export type DeploymentProfileV1 = FromSchema<
  typeof DEPLOYMENT_PROFILE_SCHEMA_V1,
  { parseIfThenElseKeywords: true }
>;
