import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/app.dart';
import 'package:frockbot_client/brand.dart';
import 'package:frockbot_client/client/transport.dart';
import 'package:frockbot_client/flock/avatar.dart';
import 'package:frockbot_client/flock/create.dart';
import 'package:frockbot_client/theme/frock_theme.dart';
import 'package:frockbot_client/voice/appearance.dart';
import 'package:frockbot_native/brand.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'widget_test.dart' show MemoryStore;

/// A white-label's brand: another name, one character of its own, no
/// release channel. Its character borrows a still this application bundles,
/// under an id FrockBot does not have.
const coinfolk = ClientBrand(
  productName: 'Coinfolk',
  builtInModelName: 'Coin AI',
  defaultCharacterId: 'coin',
  characters: [
    CharacterDefinition(
      'coin',
      'Coin',
      Color(0xffe0b43c),
      Color(0xffa07c1c),
      Color(0xfffff6df),
      ink: CharacterInk(
        canvasWidth: 457,
        canvasHeight: 615,
        left: 11,
        top: 146,
        width: 421,
        height: 438,
      ),
      rive: 'assets/characters/sunny.riv',
      still: 'assets/characters/sunny.png',
      voice: 'Kore',
    ),
  ],
);

void wearing(ClientBrand brand) {
  installClientBrand(brand);
  addTearDown(() => installClientBrand(frockbotBrand));
}

/// Every asset key an [Image] on screen is drawing.
Set<String> stills(WidgetTester tester) => {
  for (final image in tester.widgetList<Image>(find.byType(Image)))
    if (image.image case final AssetImage asset) asset.assetName,
};

void withoutDeepLinks(WidgetTester tester) {
  final messenger = tester.binding.defaultBinaryMessenger;
  for (final channel in const [
    MethodChannel('com.llfbandit.app_links/events'),
    MethodChannel('com.llfbandit.app_links/messages'),
  ]) {
    messenger.setMockMethodCallHandler(channel, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
  }
}

Future<void> answer(WidgetTester tester) async {
  for (var round = 0; round < 4; round++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

void main() {
  test('the catalog, the default and the voices are the brand’s', () {
    wearing(coinfolk);

    expect(characterCatalogV1.keys, ['coin']);
    expect(defaultCharacterIdV1, 'coin');
    expect(defaultAvatarAppearanceV1(), {
      'schemaVersion': 1,
      'characterId': 'coin',
      'primary': '#e0b43c',
    });
    // A FrockBot id this build lacks is drawn as the brand's own default.
    expect(defaultAvatarAppearanceV1('pixel')['characterId'], 'coin');
    expect(defaultGeminiVoiceForCharacterV1('coin'), 'Kore');
  });

  testWidgets('sign-in names the brand and draws its character', (
    tester,
  ) async {
    wearing(coinfolk);
    withoutDeepLinks(tester);
    final store = MemoryStore();
    final offline = NativeApi(
      store,
      client: MockClient((_) async => throw http.ClientException('offline')),
    );

    await tester.pumpWidget(FrockBotApp(store: store, api: offline));
    await answer(tester);

    expect(
      tester.widget<MaterialApp>(find.byType(MaterialApp)).title,
      'Coinfolk',
    );
    expect(find.byKey(const ValueKey('sign-in')), findsOneWidget);
    expect(find.text('Coinfolk'), findsOneWidget);
    expect(find.textContaining('Couldn’t reach Coinfolk'), findsOneWidget);
    expect(stills(tester), {'assets/characters/sunny.png'});
    expect(find.textContaining('FrockBot'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('FrockBot')), findsNothing);
  });

  testWidgets('the character picker offers only the brand’s cast', (
    tester,
  ) async {
    wearing(coinfolk);
    final store = MemoryStore();

    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: AvatarPickerSheet(
            api: NativeApi(store),
            botId: 'bot-1',
            botName: 'Penny',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('Coin'), findsOneWidget);
    expect(find.bySemanticsLabel('Pixel'), findsNothing);
    expect(stills(tester), {'assets/characters/sunny.png'});
    expect(find.textContaining('FrockBot'), findsNothing);
  });
}
