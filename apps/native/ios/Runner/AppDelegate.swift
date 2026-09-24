import Flutter
import UIKit
import UserNotifications
import restart_app

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // A Shorebird patch restarts into a new Flutter engine in this process
    // (`lib/update/update_ready.dart`); that engine needs every plugin, and
    // every channel of ours, registered again.
    RestartAppPlugin.configureEngineRestart { engine in
      GeneratedPluginRegistrant.register(with: engine)
      FrockBotChannels.register(with: engine)
    }
    // Set before launch finishes, so a tap that launched the app is heard.
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    FrockBotChannels.register(with: engineBridge.pluginRegistry)
  }

  // Firebase's delegate proxy is off (`FirebaseAppDelegateProxyEnabled`), so
  // the APNs token and the pushes iOS wakes the app for are handed over here.
  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    PushNotifications.shared.registered(deviceToken)
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    PushNotifications.shared.failed()
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
  }

  override func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    PushNotifications.shared.receive(userInfo)
    completionHandler(.newData)
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler(
      PushNotifications.shared.presentation(notification.request.content.userInfo))
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    PushNotifications.shared.open(response.notification.request.content.userInfo)
    completionHandler()
  }
}
