import 'dart:async';

import 'package:frockbot_client/brand.dart';
import 'package:frockbot_native/brand.dart';

/// Every suite runs the client as FrockBot's application does; a test about
/// another brand installs its own and puts this one back.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  installClientBrand(frockbotBrand);
  await testMain();
}
