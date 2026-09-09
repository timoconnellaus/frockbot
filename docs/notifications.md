# Messages, unread state and Android notifications

Every explicit `send_to_user` message advances the Bot's cloud-owned message cursor as part of the transaction that persists that send. A Turn can send several messages, and its settlement adds no unread count. Text, approvals, widgets and Routine messages use the same notification preference. Private model text never becomes an alert.

Clients mark the latest displayed message read only while the app/window is focused, the conversation is visible and its viewport is at the latest messages. A background app, another open Bot or a viewport in older history does not mark new messages read. Explicit Mark as read is a separate action. Read cursors only move forwards and name real messages; an older device cannot undo another device's read. Manual unread is a reminder and creates no push.

Android uses Firebase Cloud Messaging's native Android SDK and `NotificationCompat.MessagingStyle`. New messages update the Bot's existing expandable notification; other Bots have their own notifications. Swiping away the notification leaves the conversation unread. Tapping opens that Bot. Read updates remove the corresponding messages from notifications on other devices. Notification permission, sound, vibration, lock-screen visibility and launcher badges use Android's controls. The in-app unread count does not depend on launcher behavior.

A short-lived device presence record can defer a push while another device is reading. Only a durable read receipt can discard the alert. If presence becomes stale without a read, the Bot's durable outbox retries delivery. The outbox shares the Bot's alarm and also drains immediately after messages and read commands. Alarm retry can take up to roughly 30 seconds after a stale presence lease.

Each User holds a bounded device registry. Tokens rotate under a stable installation ID; logout unregisters the device and clears local notification state. Read signals have a 24-hour delivery lifetime, and app resume reconciles read state again. Push messages carry stable message cursors; Android ignores duplicates and already-read messages and does not re-alert for an older out-of-order message.

The server records an external attempt before calling FCM. A known service rejection is retried with backoff. An ambiguous network outcome or interrupted attempt is recorded as uncertain and is not blindly repeated; the message remains available in the conversation. Delivery receipt cursors are bounded to one per Bot/device/update kind. Push is an alert transport, never message history authority.

## Configuration

The Android configuration is `apps/native/android/app/google-services.json`, for Firebase project `frock-bot` and package `com.frockbot.mobile`. It contains Firebase's public app configuration. The release workflow requires `FCM_SERVICE_ACCOUNT` in GitHub Actions and forwards it to the production Worker. The server's dedicated `frockbot-push` service account has the Firebase Cloud Messaging role. Its private JSON credential belongs only in the Cloudflare Worker secret `FCM_SERVICE_ACCOUNT`, never in the APK or repository.

The authenticated `/api/push/device` endpoint registers tokens, renews focused-viewer presence, and removes an installation. The User identity comes from gateway authentication, not request JSON.

## Release verification

The one-time, repeatable `notification-state-cleanup.ts` cleanup removes disposable old Turn-based unread state and pending notification projections when each Bot is loaded. It retains conversations and settings. A release must visit the unread directory to load existing Bots and verify a fresh conversation before declaring the change ready.

Android native Firebase changes require a full Shorebird release through `scripts/native-update.py release`, followed by publishing and `adb install -r`; they cannot ship as a Dart-only patch. Deploy the backend before installing the message-cursor client.

Read cursors are message cursors, which the `1.1.0` build cannot decode, so this release raises both the app version and `minimumNativeVersion` to `1.2.0`: an install that is not upgraded is told to update rather than left with a broken sidebar. The release name comes from `apps/native/pubspec.yaml`, so the APK and the gate cannot disagree. A read command an older build left behind is discarded on load instead of retried.

Check real-device delivery with the conversation focused, another Bot selected, the app backgrounded, and the process stopped normally. Verify bursts, notification navigation, mute, notification permission denied, read-on-another-device, logout, and offline catch-up. Android force-stop is a separate OS state: FCM delivery resumes after the user opens the app again.
