import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    // No title bar: the app runs to the window's edge and draws its own
    // chrome, the way a desktop tool does. The traffic lights stay where
    // macOS puts them; the Flutter shell keeps its top-left corner clear for
    // them (see `desktopTitleBarInset` in `shell/desktop_layout.dart`) and
    // asks, over the channel below, for the window to follow a drag that
    // starts in that strip.
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.isMovableByWindowBackground = false

    let window = FlutterMethodChannel(
      name: "com.frockbot/window", binaryMessenger: flutterViewController.engine.binaryMessenger)
    window.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "startDrag":
        if let event = NSApp.currentEvent { self.performDrag(with: event) }
        result(nil)
      case "zoom":
        self.performZoom(nil)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    RegisterGeneratedPlugins(registry: flutterViewController)
    MacMessagesBridge.shared.bind(flutterViewController.engine.binaryMessenger)

    super.awakeFromNib()
  }
}
