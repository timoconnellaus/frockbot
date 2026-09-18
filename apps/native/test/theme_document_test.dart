import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/theme/document.dart';

void main() {
  test('Ink, Paper, and Studio compile from the named look', () {
    expect(namedLookDocument(NamedLook.ink).look, NamedLook.ink);
    expect(namedLookDocument(NamedLook.paper).look, NamedLook.paper);
    expect(namedLookDocument(NamedLook.studio).look, NamedLook.studio);
    expect(
      compileBotLook(
        look: BotLook.studio,
        account: AccountLook.ink,
        platform: Brightness.dark,
      ).look,
      NamedLook.studio,
    );
    expect(
      compileBotLook(
        look: BotLook.inherit,
        account: AccountLook.paper,
        platform: Brightness.dark,
      ).look,
      NamedLook.paper,
    );
    expect(
      compileBotLook(
        look: BotLook.inherit,
        account: AccountLook.system,
        platform: Brightness.light,
      ).look,
      NamedLook.paper,
    );
  });

  test('a stored document wins over compiling look', () {
    final painted = paintDocumentFor(
      look: BotLook.inherit,
      document: {
        'schemaVersion': 1,
        'look': 'studio',
        'tokens': {
          'surfaces': {
            'window': '#faf7f2',
            'surface': '#ffffff',
            'raised': '#f2ece4',
            'text': '#1e1d27',
            'muted': '#6d6974',
            'line': '#e7e0d9',
            'accent': '#c23359',
            'onAccent': '#ffffff',
          },
          'type': 'manrope',
          'bubbles': {'bot': 'plain', 'me': 'accent'},
        },
      },
      account: AccountLook.ink,
      platform: Brightness.dark,
    );
    expect(painted.look, NamedLook.studio);
    expect(painted.tokens.botBubble, BotBubble.plain);
  });

  test('Studio or a stored document is this Bot’s own look', () {
    expect(botHasOwnLook(look: BotLook.studio, document: null), isTrue);
    expect(botHasOwnLook(look: BotLook.inherit, document: null), isFalse);
    expect(
      botHasOwnLook(look: BotLook.inherit, document: {'schemaVersion': 1}),
      isTrue,
    );
    expect(
      botHasOwnLook(look: BotLook.custom, document: {'schemaVersion': 1}),
      isTrue,
    );
    expect(botHasOwnLook(look: BotLook.custom, document: null), isFalse);
    expect(parseBotLook('custom'), BotLook.custom);
    expect(botLookSummary(BotLook.custom), 'Custom');
  });

  test('forbidden keys and a contrast failure skip the document', () {
    expect(
      decodeThemeDocument({
        'schemaVersion': 1,
        'look': 'ink',
        'tokens': {
          'surfaces': {
            'window': '#1f1e24',
            'surface': '#1a191e',
            'raised': '#2c2a33',
            'text': '#f6f2ee',
            'muted': '#a8a3a6',
            'line': '#3a3742',
            'accent': '#db4b6d',
            'onAccent': '#ffffff',
          },
          'type': 'manrope',
          'bubbles': {'bot': 'raised', 'me': 'tint'},
        },
        'approval': true,
      }),
      isNull,
    );
    expect(
      decodeThemeDocument({
        'schemaVersion': 1,
        'look': 'ink',
        'tokens': {
          'surfaces': {
            'window': '#ffffff',
            'surface': '#ffffff',
            'raised': '#ffffff',
            'text': '#eeeeee',
            'muted': '#dddddd',
            'line': '#cccccc',
            'accent': '#ffffff',
            'onAccent': '#ffffff',
          },
          'type': 'manrope',
          'bubbles': {'bot': 'raised', 'me': 'tint'},
        },
      }),
      isNull,
    );
  });
}
