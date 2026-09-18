# frockbot_client

The Bot client a product embeds: conversation shell, cards, protocol,
transport, character engine and theme machinery, behind one `ProductConfig`.

FrockBot's `apps/native/lib/main.dart` is the first consumer. A second
product writes its own `main.dart`, palette, character assets and
platform identity, and calls `runFrockBot`.

Consumed via path until the first Dart tag. npm is the Worker/libraries
channel; this kit is a separate pub.dev (or path) channel.
