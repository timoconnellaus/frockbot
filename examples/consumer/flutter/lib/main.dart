import 'package:frockbot_client/frockbot_client.dart';
import 'package:flutter/material.dart';

/// A consumer SignIn. DexFi replaces this with Privy (or anything else).
class FixtureSignIn implements SignIn {
  @override
  Future<void> start() async {}

  @override
  Future<bool> accept(Uri uri) async => false;

  @override
  Future<void> signOut() async {}
}

/// What this empty repo owns: name, tokens, cast, strings, sign-in.
/// Art and platform identity stay in the product app, not in FrockBot.
const consumerProduct = ProductConfig(
  name: 'Consumer',
  origin: '',
  theme: ProductThemeTokens(
    accent: Color(0xff2563eb),
    accentSoft: Color(0xff93c5fd),
    accentDeep: Color(0xff1e3a8a),
    success: Color(0xff44a877),
    successInk: Color(0xff1c7a4e),
    warning: Color(0xffd9a441),
    warningInk: Color(0xff8a6000),
    window: Color(0xff0f172a),
    surface: Color(0xff111827),
    raised: Color(0xff1f2937),
    border: Color(0xff334155),
    muted: Color(0xff94a3b8),
    subtle: Color(0xff64748b),
    text: Color(0xfff8fafc),
    cream: Color(0xfff8fafc),
    paper: Color(0xffffffff),
    ink: Color(0xff0f172a),
    inkMuted: Color(0xff475569),
    line: Color(0xffe2e8f0),
    blush: Color(0xffdbeafe),
    blushInk: Color(0xff1d4ed8),
    blushDark: Color(0xff1e293b),
    blushDarkInk: Color(0xffbfdbfe),
    lightPrimary: Color(0xff1d4ed8),
  ),
  characters: frockbotCharacterCatalogV1,
  defaultCharacterId: defaultFrockbotCharacterIdV1,
  strings: ProductStrings(
    tagline: 'A second product on the FrockBot kit.',
    pitch: 'Chooser, config, wrangler. Nothing copied from the tree.',
    unreachable: 'Couldn’t reach Consumer. Please try again.',
    signInFailed: 'Couldn’t finish signing in. Please try again.',
    signInOpenFailed: 'Couldn’t open sign-in. Please try again.',
    signOutFailed: 'Couldn’t sign out. Please reconnect and try again.',
    deepLinkFailed: 'Couldn’t open that sign-in link. Please try again.',
  ),
  signIn: _signIn,
);

SignIn _signIn(NativeApi _api, LocalStore _store) => FixtureSignIn();

Future<void> main() => runFrockBot(consumerProduct);
