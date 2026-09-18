/// The closed ThemeDocument the thread paints from.
///
/// A mirror of `core/theme/document.ts`. The directory row is the paint
/// source: `_select` compiles this locally and never waits on a hook.
library;

import 'package:flutter/material.dart';

enum AccountLook { ink, paper, system }

enum BotLook { inherit, studio }

enum NamedLook { ink, paper, studio }

enum ThemeTypeface { manrope, inter }

enum BotBubble { plain, raised }

enum MeBubble { accent, tint }

class ThemeSurfaces {
  final Color window;
  final Color surface;
  final Color raised;
  final Color text;
  final Color muted;
  final Color line;
  final Color accent;
  final Color onAccent;
  const ThemeSurfaces({
    required this.window,
    required this.surface,
    required this.raised,
    required this.text,
    required this.muted,
    required this.line,
    required this.accent,
    required this.onAccent,
  });
}

class ThemeTokens {
  final ThemeSurfaces surfaces;
  final ThemeTypeface type;
  final BotBubble botBubble;
  final MeBubble meBubble;
  const ThemeTokens({
    required this.surfaces,
    required this.type,
    required this.botBubble,
    required this.meBubble,
  });
}

class ThemePhase {
  final TimeOfDay after;
  final ThemeTokens tokens;
  const ThemePhase({required this.after, required this.tokens});
}

class ThemeDocument {
  final NamedLook look;
  final ThemeTokens tokens;
  final List<ThemePhase> phases;
  const ThemeDocument({
    required this.look,
    required this.tokens,
    this.phases = const [],
  });

  static ThemeDocument get ink => ThemeDocument(
    look: NamedLook.ink,
    tokens: inkTokens,
  );

  static ThemeDocument get paper => ThemeDocument(
    look: NamedLook.paper,
    tokens: paperTokens,
  );

  static ThemeDocument get studio => ThemeDocument(
    look: NamedLook.studio,
    tokens: studioTokens,
  );
}

const inkTokens = ThemeTokens(
  surfaces: ThemeSurfaces(
    window: Color(0xff1f1e24),
    surface: Color(0xff1a191e),
    raised: Color(0xff2c2a33),
    text: Color(0xfff6f2ee),
    muted: Color(0xffa8a3a6),
    line: Color(0xff3a3742),
    accent: Color(0xffd03f64),
    onAccent: Color(0xffffffff),
  ),
  type: ThemeTypeface.manrope,
  botBubble: BotBubble.raised,
  meBubble: MeBubble.tint,
);

const paperTokens = ThemeTokens(
  surfaces: ThemeSurfaces(
    window: Color(0xfffaf7f2),
    surface: Color(0xffffffff),
    raised: Color(0xfff2ece4),
    text: Color(0xff1e1d27),
    muted: Color(0xff6d6974),
    line: Color(0xffe7e0d9),
    accent: Color(0xffc23359),
    onAccent: Color(0xffffffff),
  ),
  type: ThemeTypeface.manrope,
  botBubble: BotBubble.raised,
  meBubble: MeBubble.accent,
);

const studioTokens = ThemeTokens(
  surfaces: ThemeSurfaces(
    window: Color(0xfffaf7f2),
    surface: Color(0xffffffff),
    raised: Color(0xfff2ece4),
    text: Color(0xff1e1d27),
    muted: Color(0xff6d6974),
    line: Color(0xffe7e0d9),
    accent: Color(0xffc23359),
    onAccent: Color(0xffffffff),
  ),
  type: ThemeTypeface.manrope,
  botBubble: BotBubble.plain,
  meBubble: MeBubble.accent,
);

AccountLook parseAccountLook(String? value) => switch (value) {
  'paper' => AccountLook.paper,
  'system' => AccountLook.system,
  _ => AccountLook.ink,
};

BotLook parseBotLook(String? value) =>
    value == 'studio' ? BotLook.studio : BotLook.inherit;

NamedLook resolveAccountNamedLook(AccountLook look, Brightness platform) =>
    switch (look) {
      AccountLook.ink => NamedLook.ink,
      AccountLook.paper => NamedLook.paper,
      AccountLook.system =>
        platform == Brightness.dark ? NamedLook.ink : NamedLook.paper,
    };

ThemeDocument namedLookDocument(NamedLook look) => switch (look) {
  NamedLook.ink => ThemeDocument.ink,
  NamedLook.paper => ThemeDocument.paper,
  NamedLook.studio => ThemeDocument.studio,
};

/// Compile the tokens a Bot paints when its directory row has no document.
ThemeDocument compileBotLook({
  required BotLook look,
  required AccountLook account,
  required Brightness platform,
}) => look == BotLook.studio
    ? ThemeDocument.studio
    : namedLookDocument(resolveAccountNamedLook(account, platform));

Color? parseHexColor(String? value) {
  if (value == null || !RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(value)) {
    return null;
  }
  return Color(int.parse('ff${value.substring(1)}', radix: 16));
}

ThemeTokens? decodeThemeTokens(Object? value) {
  if (value is! Map) return null;
  final surfaces = value['surfaces'];
  final bubbles = value['bubbles'];
  if (surfaces is! Map || bubbles is! Map) return null;
  final window = parseHexColor(surfaces['window'] as String?);
  final surface = parseHexColor(surfaces['surface'] as String?);
  final raised = parseHexColor(surfaces['raised'] as String?);
  final text = parseHexColor(surfaces['text'] as String?);
  final muted = parseHexColor(surfaces['muted'] as String?);
  final line = parseHexColor(surfaces['line'] as String?);
  final accent = parseHexColor(surfaces['accent'] as String?);
  final onAccent = parseHexColor(surfaces['onAccent'] as String?);
  if (window == null ||
      surface == null ||
      raised == null ||
      text == null ||
      muted == null ||
      line == null ||
      accent == null ||
      onAccent == null) {
    return null;
  }
  final type = value['type'] == 'inter'
      ? ThemeTypeface.inter
      : value['type'] == 'manrope'
      ? ThemeTypeface.manrope
      : null;
  final bot = bubbles['bot'] == 'plain'
      ? BotBubble.plain
      : bubbles['bot'] == 'raised'
      ? BotBubble.raised
      : null;
  final me = bubbles['me'] == 'accent'
      ? MeBubble.accent
      : bubbles['me'] == 'tint'
      ? MeBubble.tint
      : null;
  if (type == null || bot == null || me == null) return null;
  final tokens = ThemeTokens(
    surfaces: ThemeSurfaces(
      window: window,
      surface: surface,
      raised: raised,
      text: text,
      muted: muted,
      line: line,
      accent: accent,
      onAccent: onAccent,
    ),
    type: type,
    botBubble: bot,
    meBubble: me,
  );
  return tokensMeetContrastFloor(tokens) ? tokens : null;
}

bool tokensMeetContrastFloor(ThemeTokens tokens) {
  double ratio(Color foreground, Color background) {
    final left = foreground.computeLuminance();
    final right = background.computeLuminance();
    final lighter = left > right ? left : right;
    final darker = left > right ? right : left;
    return (lighter + 0.05) / (darker + 0.05);
  }

  final surfaces = tokens.surfaces;
  return ratio(surfaces.text, surfaces.window) >= 4.5 &&
      ratio(surfaces.text, surfaces.surface) >= 4.5 &&
      ratio(surfaces.muted, surfaces.window) >= 3 &&
      ratio(surfaces.onAccent, surfaces.accent) >= 4.5;
}

ThemePhase? decodeThemePhase(Object? value) {
  if (value is! Map) return null;
  final after = value['after'];
  final tokens = decodeThemeTokens(value['tokens']);
  if (after is! String || tokens == null) return null;
  final match = RegExp(r'^([01]\d|2[0-3]):([0-5]\d)$').firstMatch(after);
  if (match == null) return null;
  return ThemePhase(
    after: TimeOfDay(
      hour: int.parse(match.group(1)!),
      minute: int.parse(match.group(2)!),
    ),
    tokens: tokens,
  );
}

ThemeDocument? decodeThemeDocument(Object? value) {
  if (value is! Map) return null;
  for (final key in const ['approval', 'billing', 'Stop', 'grants']) {
    if (value.containsKey(key)) return null;
  }
  final look = switch (value['look']) {
    'ink' => NamedLook.ink,
    'paper' => NamedLook.paper,
    'studio' => NamedLook.studio,
    _ => null,
  };
  final tokens = decodeThemeTokens(value['tokens']);
  if (look == null || tokens == null) return null;
  final phases = value['phases'];
  final decodedPhases = <ThemePhase>[];
  if (phases != null) {
    if (phases is! List || phases.length > 24) return null;
    for (final phase in phases) {
      final decoded = decodeThemePhase(phase);
      if (decoded == null) return null;
      decodedPhases.add(decoded);
    }
  }
  return ThemeDocument(look: look, tokens: tokens, phases: decodedPhases);
}

ThemeTokens resolveThemeTokens(
  ThemeDocument document, {
  required DateTime now,
  required String timezone,
}) {
  if (document.phases.isEmpty) return document.tokens;
  final location = _offsetMinutes(now, timezone);
  final current = location.hour * 60 + location.minute;
  var chosen = document.phases.last;
  for (final phase in document.phases) {
    final after = phase.after.hour * 60 + phase.after.minute;
    if (after <= current) chosen = phase;
  }
  return chosen.tokens;
}

TimeOfDay _offsetMinutes(DateTime now, String timezone) {
  // Flutter has no IANA zone table; UTC uses the UTC clock and every other
  // named zone uses the device clock. Phase documents still paint without a
  // network round trip.
  final clock = timezone == 'UTC' ? now.toUtc() : now.toLocal();
  return TimeOfDay(hour: clock.hour, minute: clock.minute);
}

/// Paint source for one Bot: the stored document, else the compiled look.
ThemeDocument paintDocumentFor({
  required BotLook look,
  required Object? document,
  required AccountLook account,
  required Brightness platform,
}) {
  final stored = decodeThemeDocument(document);
  return stored ??
      compileBotLook(look: look, account: account, platform: platform);
}
