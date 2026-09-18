/// FrockBot's app entry. The Bot client lives in `frockbot_client`; this
/// file is the first consumer of [ProductConfig].
library;

import 'package:frockbot_client/frockbot_client.dart';

import 'product.dart';

export 'package:frockbot_client/app.dart';

Future<void> main() => runFrockBot(frockbotProduct);
