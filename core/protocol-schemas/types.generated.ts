// Generated from client-wire.schema.json. Do not edit.
export type Identifier = string;
export type BotId = string;
export type RunVia =
  { kind: "bot"; name: string; botId: BotId } | { kind: "voice" };
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
  nativeVersion?: string;
  catalogs: Array<CatalogRef>;
};
export type CompatibilityView = {
  schemaVersion: 1;
  protocolMin: number;
  protocolMax: number;
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
export type BotVoiceAppearance = {
  schemaVersion: 1;
  voiceName: string;
  delivery: {
    accent?: string;
    attitude?: string;
    pace?: string;
    turnLength?: string;
    humour?: string;
    disfluency?: string;
    formality?: string;
    custom?: string;
  };
};
export type AvatarAppearance = {
  schemaVersion: 1;
  characterId: string;
  primary: string;
};
export type ThemeHex = string;
export type ThemeTokens = {
  surfaces: {
    window: ThemeHex;
    surface: ThemeHex;
    raised: ThemeHex;
    text: ThemeHex;
    muted: ThemeHex;
    line: ThemeHex;
    accent: ThemeHex;
    onAccent: ThemeHex;
  };
  type: "manrope" | "inter";
  bubbles: { bot: "plain" | "raised"; me: "accent" | "tint" };
};
export type ThemeDocument = {
  schemaVersion: 1;
  look: "ink" | "paper" | "studio";
  tokens: ThemeTokens;
  phases?: Array<{ after: string; tokens: ThemeTokens }>;
};
export type BotDirectoryProfile = {
  name: string;
  description?: string;
  sourceRevision: number;
};
export type BotRegistration = {
  schemaVersion: 1;
  botId: BotId;
  registeredAt: Instant;
  initialName: string;
  initialDescription?: string;
  avatar: AvatarAppearance;
  createdBy?: BotWriter;
  voice?: BotVoiceAppearance;
  look?: "inherit" | "studio" | "custom";
  document?: ThemeDocument;
  currentProfile?: BotDirectoryProfile;
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
  avatar?: AvatarAppearance;
  voice?: BotVoiceAppearance;
};
export type BotLifecycleReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  botId: BotId;
  status: "pending" | "applied" | "rejected";
  lifecycle: BotLifecycle;
  failure?: string;
};
export type AvatarIdentity = {
  schemaVersion: 1;
  botId: BotId;
  revision: number;
  avatar: AvatarAppearance;
};
export type BotAvatarCommand = {
  schemaVersion: 1;
  type: "bot/update-avatar";
  commandId: Identifier;
  expectedRevision: number;
  botId: BotId;
  avatar: AvatarAppearance;
};
export type VoiceIdentity = {
  schemaVersion: 1;
  botId: BotId;
  revision: number;
  voice?: BotVoiceAppearance;
};
export type BotVoiceCommand = {
  schemaVersion: 1;
  type: "bot/update-voice";
  commandId: Identifier;
  expectedRevision: number;
  botId: BotId;
  voice: BotVoiceAppearance;
};
export type LookIdentity = {
  schemaVersion: 1;
  botId: BotId;
  revision: number;
  look: "inherit" | "studio" | "custom";
  document?: ThemeDocument;
};
export type BotLookCommand = {
  schemaVersion: 1;
  type: "bot/update-look";
  commandId: Identifier;
  expectedRevision: number;
  botId: BotId;
  look: "inherit" | "studio" | "custom";
  document?: ThemeDocument;
};
export type FlockReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  status: "applied" | "rejected";
  revision: number;
  failure?: string;
};
export type SkillRef =
  | { schemaVersion: 1; source: "bot" | "user" | "managed"; slug: string }
  | { schemaVersion: 1; source: "plugin"; pluginId: string; slug: string };
export type Attachment = {
  uploadId: Digest;
  kind: "image" | "document";
  name: string;
  mediaType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif"
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    | "text/csv"
    | "text/plain"
    | "text/markdown"
    | "application/json";
  bytes: number;
};
export type UploadRef = { uploadId: Digest };
export type UploadReceipt = { schemaVersion: 1; upload: Attachment };
export type TurnCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  text: string;
  skills?: Array<SkillRef>;
  attachments?: Array<UploadRef>;
  supersedes?: { runId?: Identifier };
  retryOf?: Identifier;
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
  owner: { kind: "user" | "bot"; id: Identifier };
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
export type ConversationQuery = {
  schemaVersion: 1;
  before?: RunCursor;
  counterpart?: ExchangeCounterpart;
};
export type ExchangeCounterpart =
  { kind: "bot"; botId: BotId } | { kind: "voice" };
export type A2uiAgentMessage =
  | {
      version: "v1.0" | "v0.9";
      createSurface: {
        surfaceId: Identifier;
        catalogId?: string;
        sendDataModel?: boolean;
        surfaceProperties?: {
          [key: string]: Json;
        };
        theme?: {
          [key: string]: Json;
        };
        components?: Array<{
          id: Identifier;
          component: string;
          [key: string]: Json;
        }>;
        dataModel?: {
          [key: string]: Json;
        };
      };
    }
  | {
      version: "v1.0" | "v0.9";
      updateComponents: {
        surfaceId: Identifier;
        components: Array<{
          id: Identifier;
          component: string;
          [key: string]: Json;
        }>;
      };
    }
  | {
      version: "v1.0" | "v0.9";
      updateDataModel: { surfaceId: Identifier; path?: string; value: Json };
    }
  | { version: "v1.0" | "v0.9"; deleteSurface: { surfaceId: Identifier } };
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
    }
  | { type: "card"; surfaceId: Identifier; messages: Array<A2uiAgentMessage> };
export type RunEvent =
  | {
      type: "send/to-user";
      payload: SendPayload;
      ordinal: number;
      seq?: number;
    }
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
  | { type: "reply/to-caller"; caller: "voice" | "bot"; text: string }
  | {
      type: "message/to-bot";
      callId: string;
      botId: BotId;
      text: string;
      seq?: number;
    }
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
    }
  | {
      type: "plugin/model-usage";
      pluginId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costMicros?: number;
    };
export type RunOutcome =
  | { type: "completed"; text: string }
  | { type: "failed" | "cancelled"; message: string; text?: string };
export type Run =
  | {
      schemaVersion: 1 | 2 | 3 | 4;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      attachments?: Array<Attachment>;
      status: "running";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      queued?: true;
      partialText?: string;
      via?: RunVia;
      messageRunId?: Identifier;
      messageAdmittedAt?: Instant;
      retryOf?: Identifier;
      retriedBy?: Identifier;
      canRetry?: boolean;
      landedAt?: { runId: Identifier; seq: number };
    }
  | {
      schemaVersion: 1 | 2 | 3 | 4;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      attachments?: Array<Attachment>;
      status: "completed";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      outcome: { type: "completed"; text: string };
      via?: RunVia;
      messageRunId?: Identifier;
      messageAdmittedAt?: Instant;
      retryOf?: Identifier;
      retriedBy?: Identifier;
      canRetry?: boolean;
      landedAt?: { runId: Identifier; seq: number };
    }
  | {
      schemaVersion: 1 | 2 | 3 | 4;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      attachments?: Array<Attachment>;
      status: "failed";
      events: Array<RunEvent>;
      stopRequestedAt?: Instant;
      outcome: { type: "failed"; message: string; text?: string };
      via?: RunVia;
      messageRunId?: Identifier;
      messageAdmittedAt?: Instant;
      retryOf?: Identifier;
      retriedBy?: Identifier;
      canRetry?: boolean;
      landedAt?: { runId: Identifier; seq: number };
    }
  | {
      schemaVersion: 1 | 2 | 3 | 4;
      runId: Identifier;
      admittedAt: Instant;
      input: string;
      attachments?: Array<Attachment>;
      status: "cancelled";
      events: Array<RunEvent>;
      stopRequestedAt: Instant;
      outcome: { type: "cancelled"; message: string; text?: string };
      via?: RunVia;
      messageRunId?: Identifier;
      messageAdmittedAt?: Instant;
      retryOf?: Identifier;
      retriedBy?: Identifier;
      canRetry?: boolean;
      landedAt?: { runId: Identifier; seq: number };
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
      type: "voice/call";
      announcementId: string;
      at: Instant;
      callId: Identifier;
      startedAt: Instant;
      endedAt: Instant;
      turns: Array<{ transcript: string; answer?: string }>;
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
export type ConversationEntityId = string;
export type ConversationKind =
  "message" | "run-status" | "announcement" | "card-revision" | "computer";
export type ConversationMessageUpdate = {
  runId: Identifier;
  sessionId: string;
  occurrenceId: string;
  event: {
    type: "send/to-user";
    payload: SendPayload;
    ordinal: number;
    seq?: number;
  };
};
export type StateFrame =
  | {
      schemaVersion: 1;
      type: "state/update";
      epoch: ObserverCursor;
      cursor: ObserverCursor;
      kind: ConversationKind;
      entityId: ConversationEntityId;
      revision: number;
      payload:
        | ConversationMessageUpdate
        | { run: Run }
        | { announcement: Announcement }
        | { surfaceId: string; revision: number }
        | {};
    }
  | {
      schemaVersion: 1;
      type: "state/snapshot";
      epoch: ObserverCursor;
      cursor: ObserverCursor;
      reason: "initial" | "gap" | "cursor-ahead" | "epoch";
      conversation: ConversationProjection;
    }
  | {
      schemaVersion: 1;
      type: "state/part";
      epoch: ObserverCursor;
      cursor: ObserverCursor;
      eventId: string;
      part: number;
      parts: number;
      data: string;
    }
  | {
      schemaVersion: 1;
      type: "state/ready";
      epoch: ObserverCursor;
      cursor: ObserverCursor;
    }
  | {
      schemaVersion: 1;
      type: "state/draft";
      runId: Identifier;
      ordinal: number;
      parts: Array<string>;
    };
export type ObserverState = {
  schemaVersion: 1;
  botId: BotId;
  cursor: ObserverCursor;
  epoch?: ObserverCursor;
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
  lastActivityCursor?: MessageCursor;
  lastActivityAt?: Instant;
  lastViewedAt?: Instant;
  lastMessage?: {
    schemaVersion: 1;
    text: string;
    at: Instant;
    role: "assistant" | "user";
  };
  working?: boolean;
  notificationsEnabled: boolean;
  unreadFromMessageId?: string;
  lastSeenCursor?: MessageCursor;
  lastMessageId?: string;
};
export type MarkReadCommand =
  | {
      schemaVersion: 1;
      type: "bot/mark-read";
      commandId: Identifier;
      botId: BotId;
      upToCursor: MessageCursor;
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
  editable: boolean;
  hint?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  required?: boolean;
  choices?: Array<SettingChoice>;
  choiceSource?: "account-models" | "routine-editor" | "routine-editor-hidden";
  isSet?: boolean;
  canReset?: boolean;
};
export type SettingsFrame = {
  schemaVersion: 1;
  home: "models" | "connections" | "application" | "bot";
  revision: number;
  ownerId: Identifier;
  sections: Array<{
    id: string;
    label: string;
    fields: Array<SettingField>;
    credentialStatus?: "not-required" | "missing" | "connected" | "revoked";
    failure?: string;
    actions?: Array<{ kind: "manage-provider"; label: string }>;
  }>;
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
export type PanelBagEntry = {
  pluginId: Identifier;
  displayName: string;
  surfaceId: Identifier;
  label: string;
};
export type PanelFocus =
  { pluginId: null } | { pluginId: Identifier; surfaceId: Identifier };
export type PanelDoor = {
  pluginId: Identifier;
  label: string;
  opens?: { pluginId: Identifier; surfaceId: Identifier };
  document?: ViewDocument;
  failure?: string;
};
export type PanelPage = {
  url: string;
  state: {
    [key: string]: Json;
  };
  abilities?: Array<"microphone">;
};
export type PanelOpenView = {
  schemaVersion: 1;
  bag: Array<PanelBagEntry>;
  focus: PanelFocus;
  document?: ViewDocument;
  page?: PanelPage;
  failure?: string;
  doors: Array<PanelDoor>;
};
export type UnreadDirectory = { schemaVersion: 1; unread: Array<UnreadView> };
export type RunLookup =
  | { schemaVersion: 1; state: "not-admitted" }
  | { schemaVersion: 1; state: "running" | "terminal"; run: Run };
export type RunQuestions = {
  schemaVersion: 1;
  runId: Identifier;
  questions: Array<{ callId: string; botId: BotId; runId: Identifier }>;
};
export type BotIdentity = {
  schemaVersion: 1;
  botId: BotId;
  name: string;
  namedBy: "user" | "bot";
  hiddenFromSidebar: boolean;
  title?: string;
  pinnedAt?: Instant;
  sidebarOrder?: number;
};
export type BotWriter = {
  kind: "bot";
  botId: BotId;
  sessionId: string;
  turnId: Identifier;
};
export type TurnAdmission = { schemaVersion: 1; runId: Identifier };
export type TurnResponse = {
  schemaVersion: 1;
  runId: Identifier;
  text: string;
  events: Array<RunEvent>;
  notification?: Notification;
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
    state:
      | "authorizing"
      | "ready"
      | "disabled"
      | "revoking"
      | "reconciliation-required"
      | "failed";
    packageId: Identifier;
    connectionTypeId: Identifier;
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
    installed: boolean;
    settings?: Array<SettingField>;
    description?: string;
    icon?: Identifier;
  }>;
  modelInUse?: string;
  nextCursor?: number;
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
    kind: "shell" | "browser" | "mcp" | "file" | "process" | "device";
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
export type MessageCursor = string;
export type GroupId = string;
export type GroupChatRecord = {
  schemaVersion: 1;
  groupId: GroupId;
  name?: string;
  members: Array<BotId>;
  createdAt: Instant;
  updatedAt: Instant;
  archivedAt?: Instant;
  pinnedAt?: Instant;
  sidebarOrder?: number;
  hiddenFromSidebar?: true;
};
export type GroupChatList = {
  schemaVersion: 1;
  revision: number;
  groups: Array<GroupChatRecord>;
};
export type GroupMember = { botId: BotId; name: string; description?: string };
export type GroupChatView = {
  schemaVersion: 1;
  group: GroupChatRecord;
  members: Array<GroupMember>;
  head: number;
  readThrough: number;
  unread: number;
  working: Array<BotId>;
};
export type GroupMention = { botId: BotId; start: number; end: number };
export type GroupEvent =
  | { type: "created"; members: Array<BotId>; name?: string }
  | { type: "renamed"; name: string | null }
  | { type: "member-added"; botId: BotId }
  | { type: "member-removed"; botId: BotId }
  | { type: "archived" }
  | { type: "restored" }
  | { type: "turn-stopped"; botId: BotId; runId: Identifier }
  | { type: "turn-failed"; botId: BotId; runId: Identifier }
  | {
      type: "bot-message";
      botId: BotId;
      toBotId: BotId;
      runId: Identifier;
      callId: string;
    };
export type GroupMessageBody =
  | {
      kind: "text";
      text: string;
      mentions: Array<GroupMention>;
      mentionsUser?: true;
    }
  | { kind: "event"; event: GroupEvent };
export type GroupAuthor = { kind: "user" } | { kind: "bot"; botId: BotId };
export type GroupMessage = {
  schemaVersion: 1;
  seq: number;
  messageId: string;
  at: Instant;
  author: GroupAuthor;
  body: GroupMessageBody;
};
export type GroupMessagePage = {
  schemaVersion: 1;
  messages: Array<GroupMessage>;
  hasMore: boolean;
};
export type GroupChatCommand =
  | {
      type: "group/create";
      commandId: Identifier;
      members: Array<BotId>;
      name?: string;
    }
  | {
      type: "group/rename";
      commandId: Identifier;
      groupId: GroupId;
      name: string | null;
    }
  | {
      type: "group/add-member";
      commandId: Identifier;
      groupId: GroupId;
      botId: BotId;
    }
  | {
      type: "group/remove-member";
      commandId: Identifier;
      groupId: GroupId;
      botId: BotId;
    }
  | { type: "group/archive"; commandId: Identifier; groupId: GroupId }
  | { type: "group/restore"; commandId: Identifier; groupId: GroupId }
  | { type: "group/delete"; commandId: Identifier; groupId: GroupId }
  | {
      type: "group/arrange";
      commandId: Identifier;
      groupId: GroupId;
      pinned?: boolean;
      sidebarOrder?: number | null;
      hidden?: boolean;
    };
export type GroupChatReceipt = {
  schemaVersion: 1;
  commandId: Identifier;
  groupId: GroupId;
  status: "applied" | "unchanged";
  group?: GroupChatRecord;
  revision: number;
};
export type GroupPostCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  text: string;
};
export type GroupPostReceipt = { schemaVersion: 1; message: GroupMessage };
export type GroupReadCommand = { schemaVersion: 1; upTo: number };
export type GroupReadReceipt = { schemaVersion: 1; readThrough: number };
export type GroupStopCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  botId?: BotId;
};
export type GroupStopReceipt = { schemaVersion: 1; stopped: Array<BotId> };
export type GroupRetryCommand = {
  schemaVersion: 1;
  commandId: Identifier;
  botId: BotId;
  runId: Identifier;
};
export type GroupRetryReceipt = { schemaVersion: 1 };
export type GroupStateFrame = {
  schemaVersion: 1;
  type: "group/state";
  head: number;
  readThrough: number;
  working: Array<BotId>;
};
export interface ProtocolTypes {
  Identifier: Identifier;
  BotId: BotId;
  RunVia: RunVia;
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
  BotVoiceAppearance: BotVoiceAppearance;
  AvatarAppearance: AvatarAppearance;
  ThemeHex: ThemeHex;
  ThemeTokens: ThemeTokens;
  ThemeDocument: ThemeDocument;
  BotDirectoryProfile: BotDirectoryProfile;
  BotRegistration: BotRegistration;
  BotDirectory: BotDirectory;
  BotLifecycle: BotLifecycle;
  BotLifecycleCommand: BotLifecycleCommand;
  BotCreateCommand: BotCreateCommand;
  BotLifecycleReceipt: BotLifecycleReceipt;
  AvatarIdentity: AvatarIdentity;
  BotAvatarCommand: BotAvatarCommand;
  VoiceIdentity: VoiceIdentity;
  BotVoiceCommand: BotVoiceCommand;
  LookIdentity: LookIdentity;
  BotLookCommand: BotLookCommand;
  FlockReceipt: FlockReceipt;
  SkillRef: SkillRef;
  Attachment: Attachment;
  UploadRef: UploadRef;
  UploadReceipt: UploadReceipt;
  TurnCommand: TurnCommand;
  StopCommand: StopCommand;
  RunFenceCommand: RunFenceCommand;
  ReconcileCommand: ReconcileCommand;
  DurableReceipt: DurableReceipt;
  TurnRefusal: TurnRefusal;
  RunCursor: RunCursor;
  Page: Page;
  ConversationQuery: ConversationQuery;
  ExchangeCounterpart: ExchangeCounterpart;
  A2uiAgentMessage: A2uiAgentMessage;
  SendPayload: SendPayload;
  RunEvent: RunEvent;
  RunOutcome: RunOutcome;
  Run: Run;
  Announcement: Announcement;
  ConversationProjection: ConversationProjection;
  StopReceipt: StopReceipt;
  ObserverCursor: ObserverCursor;
  ConversationEntityId: ConversationEntityId;
  ConversationKind: ConversationKind;
  ConversationMessageUpdate: ConversationMessageUpdate;
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
  ImmutableArtifact: ImmutableArtifact;
  WebArtifact: WebArtifact;
  ActionValueSchema: ActionValueSchema;
  ActionSchema: ActionSchema;
  ViewNode: ViewNode;
  ViewDocument: ViewDocument;
  SurfaceUnavailable: SurfaceUnavailable;
  PanelBagEntry: PanelBagEntry;
  PanelFocus: PanelFocus;
  PanelDoor: PanelDoor;
  PanelPage: PanelPage;
  PanelOpenView: PanelOpenView;
  UnreadDirectory: UnreadDirectory;
  RunLookup: RunLookup;
  RunQuestions: RunQuestions;
  BotIdentity: BotIdentity;
  BotWriter: BotWriter;
  TurnAdmission: TurnAdmission;
  TurnResponse: TurnResponse;
  SettingsChangeCommand: SettingsChangeCommand;
  SettingsReceipt: SettingsReceipt;
  SettingsHandoffCommand: SettingsHandoffCommand;
  GenerationId: GenerationId;
  SettingChoice: SettingChoice;
  SettingsOptionsQuery: SettingsOptionsQuery;
  SettingsOptionsPage: SettingsOptionsPage;
  ConnectionsFrame: ConnectionsFrame;
  NotificationDirectory: NotificationDirectory;
  MarkReadReceipt: MarkReadReceipt;
  BotLifecycleDirectory: BotLifecycleDirectory;
  AuditPage: AuditPage;
  SetupHistory: SetupHistory;
  MessageCursor: MessageCursor;
  GroupId: GroupId;
  GroupChatRecord: GroupChatRecord;
  GroupChatList: GroupChatList;
  GroupMember: GroupMember;
  GroupChatView: GroupChatView;
  GroupMention: GroupMention;
  GroupEvent: GroupEvent;
  GroupMessageBody: GroupMessageBody;
  GroupAuthor: GroupAuthor;
  GroupMessage: GroupMessage;
  GroupMessagePage: GroupMessagePage;
  GroupChatCommand: GroupChatCommand;
  GroupChatReceipt: GroupChatReceipt;
  GroupPostCommand: GroupPostCommand;
  GroupPostReceipt: GroupPostReceipt;
  GroupReadCommand: GroupReadCommand;
  GroupReadReceipt: GroupReadReceipt;
  GroupStopCommand: GroupStopCommand;
  GroupStopReceipt: GroupStopReceipt;
  GroupRetryCommand: GroupRetryCommand;
  GroupRetryReceipt: GroupRetryReceipt;
  GroupStateFrame: GroupStateFrame;
}
