// Generated from client-wire.schema.json. Do not edit.
export type Identifier = string;
export type BotId = string;
export type Digest = string;
export type Instant = string;
export type HttpsUrl = string;
export type NativeReturnUri = HttpsUrl | "frockbot-dev://native/return/android";
export type AuthorizationUrl = HttpsUrl | string;
export type Json =
  | null
  | boolean
  | number
  | string
  | Array<Json>
  | {
      [key: string]: Json;
    };
export type CatalogRef = { id: Identifier; digest: Digest };
export type ClientHello = {
  schemaVersion: 1;
  protocolVersion: number;
  nativeVersion: string;
  catalogs: Array<CatalogRef>;
};
export type CompatibilityView = {
  schemaVersion: 1;
  protocolMin: number;
  protocolMax: number;
  minimumNativeVersion: string;
  catalogs: Array<CatalogRef>;
};
export type UpdateRequired = {
  schemaVersion: 1;
  status: "update-required";
  message: "Update the app to continue using FrockBot.";
};
export type AuthIdentity = {
  schemaVersion: 1;
  userId: Identifier;
  isAdmin: boolean;
};
export type AuthStartCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
  returnUri: NativeReturnUri;
};
export type AuthStartView = {
  schemaVersion: 1;
  authorizationUrl: AuthorizationUrl;
  expiresAt: Instant;
};
export type AuthExchangeCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  code: string;
  codeVerifier: string;
  state: string;
  returnUri: NativeReturnUri;
};
export type AuthSessionView = {
  schemaVersion: 1;
  sessionId: Identifier;
  userId: Identifier;
  expiresAt: Instant;
  sessionToken: string;
};
export type SessionRevokeCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  action: "sign-out";
  sessionId: Identifier;
};
export type SheepRecipe = {
  schemaVersion: 1;
  background: string;
  upper: string;
  middle: string;
  lower: string;
};
export type BotRegistration = {
  schemaVersion: 1;
  botId: BotId;
  registeredAt: Instant;
  initialName: string;
  initialDescription?: string;
  sheep: SheepRecipe;
  createdBy?: BotWriter;
};
export type BotDirectory = {
  schemaVersion: 1;
  revision: number;
  bots: Array<BotRegistration>;
};
export type BotLifecycle = {
  schemaVersion: 1;
  botId: BotId;
  status: "active" | "archived" | "deleted";
  revision: number;
};
export type BotLifecycleCommand = {
  schemaVersion: 1;
  type: "bot/archive" | "bot/restore" | "bot/delete";
  commandId: Identifier;
  botId: BotId;
};
export type BotCreateCommand = {
  schemaVersion: 1;
  type: "bot/create";
  commandId: Identifier;
  expectedRevision: number;
  botId: BotId;
  name: string;
  description?: string;
  sheep?: SheepRecipe;
};
export type BotLifecycleReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  botId: BotId;
  status: "pending" | "applied" | "rejected";
  lifecycle: BotLifecycle;
  failure?: string;
};
export type SheepIdentity = {
  schemaVersion: 1;
  botId: BotId;
  revision: number;
  sheep: SheepRecipe;
};
export type BotSheepCommand = {
  schemaVersion: 1;
  type: "bot/update-sheep";
  commandId: Identifier;
  expectedRevision: number;
  botId: BotId;
  sheep: SheepRecipe;
};
export type FlockReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  status: "applied" | "rejected";
  revision: number;
  failure?: string;
};
export type SkillRef = {
  schemaVersion: 1;
  source: "bot" | "user" | "managed";
  slug: string;
};
export type TurnCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  text: string;
  skills?: Array<SkillRef>;
  supersedes?: { runId?: Identifier };
};
export type StopCommand = {
  schemaVersion: 1;
  action: "stop";
  commandId: Identifier;
  runId: Identifier;
};
export type RunFenceCommand = { schemaVersion: 1; action: "fence-admission" };
export type ReconcileCommand = { schemaVersion: 1; action: "resume" };
export type DurableReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  owner: { kind: "user" | "bot" | "applet"; id: Identifier };
  status: "accepted" | "applied" | "refused";
  recordedAt: Instant;
  runId?: Identifier;
  reason?: string;
};
export type TurnRefusal = {
  schemaVersion: 1;
  status: "refused";
  reason: "busy" | "fenced" | "duplicate";
  error: string;
};
export type RunCursor = string;
export type Page =
  { truncated: false } | { truncated: true; nextCursor: RunCursor };
export type ConversationQuery = { schemaVersion: 1; before?: RunCursor };
export type SendPayload =
  | { type: "text"; text: string }
  | { type: "attachment"; url: string; name?: string; mediaType?: string }
  | {
      type: "widget";
      widget: {
        prompt: string;
        helpText?: string;
        options: Array<string>;
        allowCustom?: boolean;
        dismissOnMoveOn?: boolean;
      };
    }
  | { type: "secret-request"; prompt: string; secretName: string }
  | { type: "agent-card"; agentId: string; title: string; body?: string }
  | {
      type: "approval";
      approvalId: Identifier;
      action: string;
      rationale?: string;
      risk: "low" | "medium" | "high";
      expiresInSeconds?: number;
    };
export type RunEvent =
  | { type: "send/to-user"; payload: SendPayload }
  | {
      type: "tool/call";
      call: {
        id: string;
        name: string;
        input?: { namespace: string; toolName: string; argumentsJson?: string };
      };
    }
  | {
      type: "tool/result";
      callId: string;
      content: string;
      isError: boolean;
      attachments?: Array<{
        kind: "image";
        mediaType: "image/png" | "image/jpeg" | "image/webp";
        contentHash: Digest;
        bytes: number;
        path: string;
      }>;
    }
  | { type: "run/events-truncated"; omittedInteractions: number }
  | { type: "wake/parent"; message: string }
  | {
      type: "computer/sync";
      status: "degraded" | "unavailable" | "refused" | "skipped";
      message: string;
    }
  | {
      type: "task/dispatched";
      taskId: string;
      taskType: string;
      description: string;
      model: string;
      background: boolean;
    };
export type RunOutcome =
  | { type: "completed"; text: string }
  | {
      type: "failed" | "cancelled" | "superseded";
      message: string;
      text?: string;
    };
export type Run =
  | {
      schemaVersion: 1 | 2 | 3;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      status: "running";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      queued?: true;
      partialText?: string;
      via?: { kind: "bot"; name: string; botId: BotId };
    }
  | {
      schemaVersion: 1 | 2 | 3;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      status: "completed";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      outcome: { type: "completed"; text: string };
      via?: { kind: "bot"; name: string; botId: BotId };
    }
  | {
      schemaVersion: 1 | 2 | 3;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      status: "failed";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      outcome: { type: "failed"; message: string; text?: string };
      via?: { kind: "bot"; name: string; botId: BotId };
    }
  | {
      schemaVersion: 1 | 2 | 3;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      status: "cancelled";
      events: Array<RunEvent>;
      stopRequestedAt: Instant;
      outcome: { type: "cancelled"; message: string; text?: string };
      via?: { kind: "bot"; name: string; botId: BotId };
    }
  | {
      schemaVersion: 1 | 2 | 3;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      status: "superseded";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      outcome: { type: "superseded"; message: string; text?: string };
      via?: { kind: "bot"; name: string; botId: BotId };
    };
export type Announcement =
  | {
      type: "bot/renamed";
      announcementId: string;
      at: Instant;
      from: string;
      to: string;
      namedBy: "user" | "bot";
    }
  | {
      type: "conversation/compacted";
      announcementId: string;
      at: Instant;
      throughTurn: number;
    };
export type ConversationProjection = {
  schemaVersion: 1;
  runs: Array<Run>;
  page: Page;
  announcements?: Array<Announcement>;
};
export type StopReceipt = {
  schemaVersion: 1;
  status: "accepted";
  commandId: Identifier;
  runId: Identifier;
  run: Run;
};
export type ObserverCursor = string;
export type StateFrame =
  | {
      schemaVersion: 1;
      type: "state/event";
      cursor: ObserverCursor;
      topic: "computer" | "runs";
    }
  | {
      schemaVersion: 1;
      type: "state/reset";
      cursor: ObserverCursor;
      reason: "initial" | "gap" | "cursor-ahead";
    }
  | { schemaVersion: 1; type: "state/ready"; cursor: ObserverCursor };
export type ObserverState = {
  schemaVersion: 1;
  botId: BotId;
  cursor: ObserverCursor;
  status: "connecting" | "open" | "fallback" | "hidden";
};
export type Notification = {
  notificationId: string;
  runId: Identifier;
  createdAt: Instant;
  title: string;
  body: string;
  urgency?: "normal" | "critical";
};
export type NotificationList = {
  schemaVersion: 1;
  notifications: Array<Notification>;
};
export type NotificationAck = {
  schemaVersion: 1;
  action: "acknowledge";
  notificationId: string;
};
export type Acknowledgement = { schemaVersion: 1; status: "acknowledged" };
export type UnreadView = {
  schemaVersion: 1;
  botId: BotId;
  count: number;
  capped: boolean;
  unread: boolean;
  manuallyUnread: boolean;
  lastActivityCursor?: RunCursor;
  lastActivityAt?: Instant;
  lastViewedAt?: Instant;
  lastMessage?: {
    schemaVersion: 1;
    text: string;
    at: Instant;
    role: "assistant" | "user";
  };
  working?: boolean;
  unreadFromMessageId?: string;
};
export type MarkReadCommand =
  | {
      schemaVersion: 1;
      type: "bot/mark-read";
      commandId: Identifier;
      botId: BotId;
      upToCursor: RunCursor;
    }
  | {
      schemaVersion: 1;
      type: "bot/mark-unread";
      commandId: Identifier;
      botId: BotId;
      fromMessageId?: string;
    };
export type SettingField = {
  id: Identifier;
  label: string;
  kind: "text" | "boolean" | "number" | "select" | "secret";
  value: Json;
  options?: Array<string>;
  editable: boolean;
  hint?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  required?: boolean;
  choices?: Array<SettingChoice>;
  choiceSource?: "account-models";
  isSet?: boolean;
  canReset?: boolean;
};
export type SettingsFrame = {
  schemaVersion: 1;
  home: "models" | "connections" | "application" | "bot";
  revision: number;
  ownerId: Identifier;
  title: string;
  sections: Array<{
    id: string;
    packageId?: Identifier;
    label: string;
    fields: Array<SettingField>;
    credentialStatus?: "not-required" | "missing" | "connected" | "revoked";
    failure?: string;
    actions?: Array<{
      kind: "choose-provider" | "manage-provider";
      label: string;
      packageId: Identifier;
    }>;
  }>;
};
export type AppletViewerToken = {
  token: string;
  expiresAt: Instant;
  socketUrl: string;
};
export type ImmutableArtifact = {
  contentHash: Digest;
  size: number;
  mediaType: "application/json";
};
export type WebArtifact = {
  contentHash: Digest;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
};
export type ActionValueSchema =
  | { type: "string"; maxLength: number }
  | { type: "boolean" }
  | { type: "number"; minimum: number; maximum: number }
  | { type: "string"; enum: Array<string> };
export type ActionSchema = {
  type: "object";
  properties: {
    [key: string]: ActionValueSchema;
  };
  required: Array<Identifier>;
  additionalProperties: false;
};
export type ViewNode =
  | {
      type: "text";
      text: string;
      style?: "body" | "heading" | "label" | "status";
    }
  | {
      type: "group";
      orientation: "row" | "column";
      title?: string;
      collapsed?: boolean;
      children: Array<ViewNode>;
    }
  | { type: "field"; field: SettingField }
  | {
      type: "action";
      actionId: Identifier;
      label: string;
      style?: "primary" | "secondary" | "danger";
      input?: {
        [key: string]: Json;
      };
    }
  | {
      type: "list";
      empty?: string;
      rows: Array<{
        id: Identifier;
        node: ViewNode;
        actionId?: Identifier;
        selected?: boolean;
      }>;
    }
  | {
      type: "embed";
      kind: "image" | "frame";
      source: string;
      label: string;
      aspectRatio?: number;
    };
export type ViewDocument = {
  schemaVersion: 1;
  surfaceId: Identifier;
  revision: number;
  root: ViewNode;
  actions: Array<{ id: Identifier; schema: ActionSchema }>;
};
export type SurfaceUnavailable = {
  schemaVersion: 1;
  surfaceId: Identifier;
  reason:
    | "unsupported-protocol"
    | "unsupported-catalog"
    | "invalid-document"
    | "stale-revision"
    | "revoked"
    | "disabled"
    | "limit-exceeded";
  message: string;
};
export type UnreadDirectory = { schemaVersion: 1; unread: Array<UnreadView> };
export type RunLookup =
  | { schemaVersion: 1; state: "not-admitted" }
  | { schemaVersion: 1; state: "running" | "terminal"; run: Run };
export type BotIdentity = {
  schemaVersion: 1;
  botId: BotId;
  name: string;
  namedBy: "user" | "bot";
  hiddenFromSidebar: boolean;
  label?: string;
  title?: string;
  pinnedAt?: Instant;
};
export type BotWriter = {
  kind: "bot";
  botId: BotId;
  sessionId: string;
  turnId: Identifier;
};
export type TurnResponse = {
  schemaVersion: 1;
  runId: Identifier;
  text: string;
  events: Array<RunEvent>;
  notification?: Notification;
};
export type AppletSummary = {
  appletId: string;
  displayName: string;
  status: "draft" | "published" | "deleted";
  currentGenerationId?: GenerationId;
  tools: Array<string>;
  createdAt: Instant;
};
export type AppletDirectory = {
  schemaVersion: 1;
  applets: Array<AppletSummary>;
};
export type SettingsChangeCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  expectedRevision: number;
  sectionId: string;
  values: {
    [key: string]: Json;
  };
  unset?: Array<Identifier>;
  ownerId: Identifier;
};
export type SettingsReceipt =
  | {
      schemaVersion: 1;
      commandId: Identifier;
      revision: number;
      status: "pending" | "applied";
    }
  | {
      schemaVersion: 1;
      commandId: Identifier;
      revision: number;
      status: "rejected";
      failure: string;
    };
export type SettingsHandoffCommand = {
  schemaVersion: 1;
  home: "models" | "connections";
};
export type GenerationId = string;
export type SettingChoice = { label: string; value: Json };
export type SettingsOptionsQuery = {
  schemaVersion: 1;
  source: "account-models";
  revision: number;
  query: string;
  cursor?: number;
};
export type SettingsOptionsPage = {
  schemaVersion: 1;
  source: "account-models";
  ownerId: Identifier;
  revision: number;
  items: Array<SettingChoice>;
  nextCursor?: number;
};
export type ConnectionsFrame = {
  schemaVersion: 1;
  ownerId: Identifier;
  revision: number;
  accounts: Array<{
    id: Identifier;
    label: string;
    service: string;
    state:
      | "authorizing"
      | "ready"
      | "disabled"
      | "revoking"
      | "reconciliation-required"
      | "failed";
    packageId: Identifier;
    kind: "model" | "connector";
    authorization: "none" | "api-key" | "ambient-native" | "grant";
    detail?: string;
    failure?: string;
  }>;
  providers: Array<{
    packageId: Identifier;
    connectionTypeId: Identifier;
    displayName: string;
    kind: "model" | "connector";
    authorization: "none" | "api-key" | "ambient-native" | "grant";
    connected: number;
    mayConnect: boolean;
    settings?: Array<SettingField>;
  }>;
  modelInUse?: string;
};
export type PluginsFrame = {
  schemaVersion: 1;
  ownerId: Identifier;
  revision: number;
  plugins: Array<{
    packageId: Identifier;
    version: string;
    displayName: string;
    summary: string;
    state: "not-installed" | "installed" | "disabled" | "failed";
    home: "models" | "connections" | "user-settings" | "none";
    failure?: string;
  }>;
};
export type NotificationDirectory = {
  schemaVersion: 1;
  notifications: Array<{
    notificationId: string;
    runId: Identifier;
    createdAt: Instant;
    title: string;
    body: string;
    urgency?: "normal" | "critical";
    schemaVersion: 1;
    botId: BotId;
  }>;
};
export type MarkReadReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  status: "applied";
  unread: UnreadView;
};
export type BotLifecycleDirectory = {
  schemaVersion: 1;
  lifecycles: Array<BotLifecycle>;
};
export type AuditPage = {
  schemaVersion: 1;
  entries: Array<{
    schemaVersion: 1;
    botId: BotId;
    runId: string;
    occurrenceId: string;
    turn: number;
    step: number;
    ordinal: number;
    effectId: string;
    at: Instant;
    kind: "shell" | "browser" | "mcp" | "file" | "process";
    target: string;
    toolName: string;
    argumentDigest: Digest;
    preview: string;
    outcome: "ok" | "error" | "refused" | "interrupted" | "unknown";
    exitCode?: number;
    durationMs?: number;
    bytesOut?: number;
  }>;
  page: { truncated: boolean; nextCursor?: string };
  total: number;
  indexState: "ready" | "rebuilding" | "truncated";
};
export type SetupHistory = {
  schemaVersion: 1;
  botId: BotId;
  currentGenerationId: GenerationId;
  generations: Array<{
    schemaVersion: 1;
    botId: BotId;
    generationId: GenerationId;
    createdAt: Instant;
    status: "pending" | "active" | "superseded" | "failed" | "quarantined";
    origin:
      | { kind: "bootstrap" }
      | {
          kind: "bot-authored";
          runId: string;
          sessionId: string;
          turnId: string;
        }
      | { kind: "revert"; revertsTo: GenerationId; userId: Identifier }
      | {
          kind: "revert";
          revertsTo: GenerationId;
          botId: BotId;
          runId: string;
          turnId: string;
        };
    parentGenerationId?: GenerationId;
    isCurrent: boolean;
    members: Array<{
      packageId: Identifier;
      version: string;
      provenance:
        | { kind: "user"; userId: Identifier; authoredAt: Instant }
        | {
            kind: "bot";
            botId: BotId;
            sessionId: string;
            turnId: string;
            runId: string;
            authoredAt: Instant;
          };
      contentHash?: Digest;
      source?: string;
    }>;
    failures: Array<{
      attempt: number;
      at: Instant;
      phase: "resolve" | "bundle" | "mount" | "health";
      message: string;
    }>;
    quarantine?: { quarantinedAt: Instant; reason: string; failures: number };
  }>;
  cursor?: string;
};
export interface ProtocolTypes {
  Identifier: Identifier;
  BotId: BotId;
  Digest: Digest;
  Instant: Instant;
  HttpsUrl: HttpsUrl;
  NativeReturnUri: NativeReturnUri;
  AuthorizationUrl: AuthorizationUrl;
  Json: Json;
  CatalogRef: CatalogRef;
  ClientHello: ClientHello;
  CompatibilityView: CompatibilityView;
  UpdateRequired: UpdateRequired;
  AuthIdentity: AuthIdentity;
  AuthStartCommand: AuthStartCommand;
  AuthStartView: AuthStartView;
  AuthExchangeCommand: AuthExchangeCommand;
  AuthSessionView: AuthSessionView;
  SessionRevokeCommand: SessionRevokeCommand;
  SheepRecipe: SheepRecipe;
  BotRegistration: BotRegistration;
  BotDirectory: BotDirectory;
  BotLifecycle: BotLifecycle;
  BotLifecycleCommand: BotLifecycleCommand;
  BotCreateCommand: BotCreateCommand;
  BotLifecycleReceipt: BotLifecycleReceipt;
  SheepIdentity: SheepIdentity;
  BotSheepCommand: BotSheepCommand;
  FlockReceipt: FlockReceipt;
  SkillRef: SkillRef;
  TurnCommand: TurnCommand;
  StopCommand: StopCommand;
  RunFenceCommand: RunFenceCommand;
  ReconcileCommand: ReconcileCommand;
  DurableReceipt: DurableReceipt;
  TurnRefusal: TurnRefusal;
  RunCursor: RunCursor;
  Page: Page;
  ConversationQuery: ConversationQuery;
  SendPayload: SendPayload;
  RunEvent: RunEvent;
  RunOutcome: RunOutcome;
  Run: Run;
  Announcement: Announcement;
  ConversationProjection: ConversationProjection;
  StopReceipt: StopReceipt;
  ObserverCursor: ObserverCursor;
  StateFrame: StateFrame;
  ObserverState: ObserverState;
  Notification: Notification;
  NotificationList: NotificationList;
  NotificationAck: NotificationAck;
  Acknowledgement: Acknowledgement;
  UnreadView: UnreadView;
  MarkReadCommand: MarkReadCommand;
  SettingField: SettingField;
  SettingsFrame: SettingsFrame;
  AppletViewerToken: AppletViewerToken;
  ImmutableArtifact: ImmutableArtifact;
  WebArtifact: WebArtifact;
  ActionValueSchema: ActionValueSchema;
  ActionSchema: ActionSchema;
  ViewNode: ViewNode;
  ViewDocument: ViewDocument;
  SurfaceUnavailable: SurfaceUnavailable;
  UnreadDirectory: UnreadDirectory;
  RunLookup: RunLookup;
  BotIdentity: BotIdentity;
  BotWriter: BotWriter;
  TurnResponse: TurnResponse;
  AppletSummary: AppletSummary;
  AppletDirectory: AppletDirectory;
  SettingsChangeCommand: SettingsChangeCommand;
  SettingsReceipt: SettingsReceipt;
  SettingsHandoffCommand: SettingsHandoffCommand;
  GenerationId: GenerationId;
  SettingChoice: SettingChoice;
  SettingsOptionsQuery: SettingsOptionsQuery;
  SettingsOptionsPage: SettingsOptionsPage;
  ConnectionsFrame: ConnectionsFrame;
  PluginsFrame: PluginsFrame;
  NotificationDirectory: NotificationDirectory;
  MarkReadReceipt: MarkReadReceipt;
  BotLifecycleDirectory: BotLifecycleDirectory;
  AuditPage: AuditPage;
  SetupHistory: SetupHistory;
}
