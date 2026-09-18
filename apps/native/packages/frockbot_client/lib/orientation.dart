import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

bool get isNativeMobile =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS);

Future<void> setComputerFullscreen(bool fullscreen) async {
  if (!isNativeMobile) return;
  if (defaultTargetPlatform == TargetPlatform.android) {
    // Flutter's system UI modes cannot hide bars with our Android target SDK.
    await const MethodChannel('com.frockbot.mobile/display')
        .invokeMethod<void>('fullscreen', fullscreen);
  } else {
    await SystemChrome.setEnabledSystemUIMode(
      fullscreen ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge,
    );
  }
}

Future<void> setMobileOrientation({bool computerOpen = false}) async {
  if (!isNativeMobile) return;
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    if (computerOpen) ...[
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ],
  ]);
}
