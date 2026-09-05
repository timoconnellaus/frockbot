// Generated from client-wire.schema.json. Do not edit.
import type { ProtocolTypes } from "./types.generated.js";
declare const validators: {
  isIdentifier(value: unknown): value is ProtocolTypes["Identifier"];
  isBotId(value: unknown): value is ProtocolTypes["BotId"];
  isDigest(value: unknown): value is ProtocolTypes["Digest"];
  isInstant(value: unknown): value is ProtocolTypes["Instant"];
  isHttpsUrl(value: unknown): value is ProtocolTypes["HttpsUrl"];
  isJson(value: unknown): value is ProtocolTypes["Json"];
  isCatalogRef(value: unknown): value is ProtocolTypes["CatalogRef"];
  isClientHello(value: unknown): value is ProtocolTypes["ClientHello"];
  isCompatibilityView(
    value: unknown,
  ): value is ProtocolTypes["CompatibilityView"];
  isUpdateRequired(value: unknown): value is ProtocolTypes["UpdateRequired"];
  isAuthIdentity(value: unknown): value is ProtocolTypes["AuthIdentity"];
  isAuthStartCommand(
    value: unknown,
  ): value is ProtocolTypes["AuthStartCommand"];
  isAuthStartView(value: unknown): value is ProtocolTypes["AuthStartView"];
  isAuthExchangeCommand(
    value: unknown,
  ): value is ProtocolTypes["AuthExchangeCommand"];
  isAuthSessionView(value: unknown): value is ProtocolTypes["AuthSessionView"];
  isSessionRevokeCommand(
    value: unknown,
  ): value is ProtocolTypes["SessionRevokeCommand"];
  isSheepRecipe(value: unknown): value is ProtocolTypes["SheepRecipe"];
  isBotRegistration(value: unknown): value is ProtocolTypes["BotRegistration"];
  isBotDirectory(value: unknown): value is ProtocolTypes["BotDirectory"];
  isBotLifecycle(value: unknown): value is ProtocolTypes["BotLifecycle"];
  isBotLifecycleCommand(
    value: unknown,
  ): value is ProtocolTypes["BotLifecycleCommand"];
  isBotCreateCommand(
    value: unknown,
  ): value is ProtocolTypes["BotCreateCommand"];
  isBotLifecycleReceipt(
    value: unknown,
  ): value is ProtocolTypes["BotLifecycleReceipt"];
  isSkillRef(value: unknown): value is ProtocolTypes["SkillRef"];
  isTurnCommand(value: unknown): value is ProtocolTypes["TurnCommand"];
  isStopCommand(value: unknown): value is ProtocolTypes["StopCommand"];
  isRunFenceCommand(value: unknown): value is ProtocolTypes["RunFenceCommand"];
  isReconcileCommand(
    value: unknown,
  ): value is ProtocolTypes["ReconcileCommand"];
  isDurableReceipt(value: unknown): value is ProtocolTypes["DurableReceipt"];
  isTurnRefusal(value: unknown): value is ProtocolTypes["TurnRefusal"];
  isRunCursor(value: unknown): value is ProtocolTypes["RunCursor"];
  isPage(value: unknown): value is ProtocolTypes["Page"];
  isConversation(value: unknown): value is ProtocolTypes["Conversation"];
  isConversationList(
    value: unknown,
  ): value is ProtocolTypes["ConversationList"];
  isConversationStartCommand(
    value: unknown,
  ): value is ProtocolTypes["ConversationStartCommand"];
  isConversationQuery(
    value: unknown,
  ): value is ProtocolTypes["ConversationQuery"];
  isSendPayload(value: unknown): value is ProtocolTypes["SendPayload"];
  isRunEvent(value: unknown): value is ProtocolTypes["RunEvent"];
  isRunOutcome(value: unknown): value is ProtocolTypes["RunOutcome"];
  isRun(value: unknown): value is ProtocolTypes["Run"];
  isAnnouncement(value: unknown): value is ProtocolTypes["Announcement"];
  isConversationProjection(
    value: unknown,
  ): value is ProtocolTypes["ConversationProjection"];
  isStopReceipt(value: unknown): value is ProtocolTypes["StopReceipt"];
  isObserverCursor(value: unknown): value is ProtocolTypes["ObserverCursor"];
  isStateFrame(value: unknown): value is ProtocolTypes["StateFrame"];
  isObserverState(value: unknown): value is ProtocolTypes["ObserverState"];
  isNotification(value: unknown): value is ProtocolTypes["Notification"];
  isNotificationList(
    value: unknown,
  ): value is ProtocolTypes["NotificationList"];
  isNotificationAck(value: unknown): value is ProtocolTypes["NotificationAck"];
  isAcknowledgement(value: unknown): value is ProtocolTypes["Acknowledgement"];
  isUnreadView(value: unknown): value is ProtocolTypes["UnreadView"];
  isMarkReadCommand(value: unknown): value is ProtocolTypes["MarkReadCommand"];
  isSettingField(value: unknown): value is ProtocolTypes["SettingField"];
  isSettingsFrame(value: unknown): value is ProtocolTypes["SettingsFrame"];
  isAppletViewerToken(
    value: unknown,
  ): value is ProtocolTypes["AppletViewerToken"];
  isImmutableArtifact(
    value: unknown,
  ): value is ProtocolTypes["ImmutableArtifact"];
  isWebArtifact(value: unknown): value is ProtocolTypes["WebArtifact"];
  isFallbackBootstrap(
    value: unknown,
  ): value is ProtocolTypes["FallbackBootstrap"];
  isActionValueSchema(
    value: unknown,
  ): value is ProtocolTypes["ActionValueSchema"];
  isActionSchema(value: unknown): value is ProtocolTypes["ActionSchema"];
  isA2uiContribution(
    value: unknown,
  ): value is ProtocolTypes["A2uiContribution"];
  isA2uiSurface(value: unknown): value is ProtocolTypes["A2uiSurface"];
  isA2uiActionCommand(
    value: unknown,
  ): value is ProtocolTypes["A2uiActionCommand"];
  isSurfaceUnavailable(
    value: unknown,
  ): value is ProtocolTypes["SurfaceUnavailable"];
  isUnreadDirectory(value: unknown): value is ProtocolTypes["UnreadDirectory"];
  isRunLookup(value: unknown): value is ProtocolTypes["RunLookup"];
  isBotIdentity(value: unknown): value is ProtocolTypes["BotIdentity"];
  isBotWriter(value: unknown): value is ProtocolTypes["BotWriter"];
  isTurnResponse(value: unknown): value is ProtocolTypes["TurnResponse"];
};
export default validators;
