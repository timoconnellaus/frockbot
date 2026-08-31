import UIKit
import Capacitor
import UserNotifications

@objc(FrockBotMobilePlugin)
final class FrockBotMobilePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FrockBotMobilePlugin"
    let jsName = "FrockBotMobile"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "invoke", returnType: CAPPluginReturnPromise)
    ]

    private let readClipboard = "mobile.clipboard.readText"
    private let writeClipboard = "mobile.clipboard.writeText"
    private let showNotification = "mobile.notifications.show"

    @objc func invoke(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == Set(["schemaVersion", "commandId", "input"]),
              call.getInt("schemaVersion") == 1,
              let commandId = call.getString("commandId"),
              let input = call.getObject("input") else {
            call.reject("mobile broker request is invalid")
            return
        }
        switch commandId {
        case readClipboard:
            performReadClipboard(call, input)
        case writeClipboard:
            performWriteClipboard(call, input)
        case showNotification:
            performShowNotification(call, input)
        default:
            call.reject("mobile command is unavailable")
        }
    }

    private func performReadClipboard(_ call: CAPPluginCall, _ input: JSObject) {
        guard input.isEmpty else {
            call.reject("clipboard input has unknown fields")
            return
        }
        guard let text = UIPasteboard.general.string, text.count <= 1_000_000 else {
            call.reject("the clipboard does not hold bounded text")
            return
        }
        call.resolve(["text": text])
    }

    private func performWriteClipboard(_ call: CAPPluginCall, _ input: JSObject) {
        guard Set(input.keys) == Set(["text"]),
              let text = input["text"] as? String,
              text.count <= 1_000_000 else {
            call.reject("clipboard input is invalid")
            return
        }
        UIPasteboard.general.string = text
        call.resolve(["written": true])
    }

    private func performShowNotification(_ call: CAPPluginCall, _ input: JSObject) {
        let keys = Set(input.keys)
        guard (keys == Set(["title", "urgency"]) || keys == Set(["title", "body", "urgency"])),
              let title = input["title"] as? String,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              title.count <= 200,
              let urgency = input["urgency"] as? String,
              urgency == "normal" || urgency == "critical" else {
            call.reject("notification input is invalid")
            return
        }
        let body = input["body"] as? String ?? ""
        guard body.count <= 4_096 else {
            call.reject("notification input is invalid")
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error {
                        call.reject(error.localizedDescription)
                    } else if granted {
                        self.deliverNotification(call, title: title, body: body, urgency: urgency)
                    } else {
                        call.reject("notification permission was denied")
                    }
                }
            } else if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                self.deliverNotification(call, title: title, body: body, urgency: urgency)
            } else {
                call.reject("notification permission was denied")
            }
        }
    }

    private func deliverNotification(_ call: CAPPluginCall, title: String, body: String, urgency: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if #available(iOS 15.0, *), urgency == "critical" {
            content.interruptionLevel = .timeSensitive
        }
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve(["shown": true])
            }
        }
    }
}

final class FrockBotBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginType(FrockBotMobilePlugin.self)
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FrockBotBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
