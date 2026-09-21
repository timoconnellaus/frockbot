import type {
  Acknowledgement,
  Announcement,
  Notification,
  NotificationList,
} from "@frockbot/core/protocol-schemas";
import type {
  ClientAnnouncementV1,
  ClientNotificationAcknowledgementV1,
  ClientNotificationIntent,
  ClientNotificationListV1,
} from "./run-protocol.js";

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

type _Notification = Assert<Eq<ClientNotificationIntent, Notification>>;
type _NotificationList = Assert<Eq<ClientNotificationListV1, NotificationList>>;
type _Ack = Assert<Eq<ClientNotificationAcknowledgementV1, Acknowledgement>>;
type _Announcement = Assert<Eq<ClientAnnouncementV1, Announcement>>;

const critical: Notification = {
  notificationId: "notification-1",
  runId: "run-1",
  createdAt: "2026-09-20T00:00:00.000Z",
  title: "Needs you",
  body: "The Bot asked a question.",
  urgency: "critical",
};

void critical;

const badUrgency: Notification = {
  notificationId: "notification-1",
  runId: "run-1",
  createdAt: "2026-09-20T00:00:00.000Z",
  title: "Needs you",
  body: "The Bot asked a question.",
  // @ts-expect-error urgency is only normal or critical
  urgency: "low",
};

void badUrgency;
