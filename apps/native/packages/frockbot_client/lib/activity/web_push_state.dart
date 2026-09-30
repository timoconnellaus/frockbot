/// Where this browser stands with notifications.
enum WebPushState {
  /// No Web Push here at all.
  unsupported,

  /// An iPhone or iPad tab: Safari delivers Web Push only to an app on the
  /// Home Screen.
  needsHomeScreen,

  /// Nobody has asked yet; turning them on asks.
  ask,

  /// The person allowed notifications for this site.
  allowed,

  /// The person refused them; only the browser's own settings undo that.
  blocked,
}
