import 'package:flutter/material.dart';

enum CharacterActivity {
  idle,
  thinking,
  working,
  needsAttention,
  success,
  still,
}

enum CharacterEmotion {
  neutral,
  excited,
  sad,
  tired,
  curious,
  content,
  surprised,
  uncertain,
}

enum CharacterMotion { active, quiet, still }

@immutable
class CharacterDefinition {
  final String id;
  final String label;
  final Color primary;
  final Color shade;
  final Color eyes;
  const CharacterDefinition(
    this.id,
    this.label,
    this.primary,
    this.shade,
    this.eyes,
  );
}

/// FrockBot's cast. A [ProductConfig] may name a different map; this is
/// what the kit draws when nothing has been configured yet, so tests and
/// FrockBot itself keep the same pixels.
const frockbotCharacterCatalogV1 = <String, CharacterDefinition>{
  'pixel': CharacterDefinition(
    'pixel',
    'Pixel',
    Color(0xfffc85ae),
    Color(0xffa95d75),
    Color(0xfffcf6e3),
  ),
  'guardian': CharacterDefinition(
    'guardian',
    'Guardian',
    Color(0xff3c3543),
    Color(0xff211d26),
    Color(0xffffeee0),
  ),
  'sunny': CharacterDefinition(
    'sunny',
    'Sunny',
    Color(0xffffc928),
    Color(0xffd99a00),
    Color(0xfffff6df),
  ),
  'chill': CharacterDefinition(
    'chill',
    'Chill',
    Color(0xff59c7ff),
    Color(0xff258dc5),
    Color(0xfff4fbff),
  ),
  'nudge': CharacterDefinition(
    'nudge',
    'Nudge',
    Color(0xffff8b27),
    Color(0xffc95b12),
    Color(0xfffff4e9),
  ),
  'fox': CharacterDefinition(
    'fox',
    'Fox',
    Color(0xffef6b4a),
    Color(0xffae402b),
    Color(0xfffff0dc),
  ),
  'dog': CharacterDefinition(
    'dog',
    'Dog',
    Color(0xffdca258),
    Color(0xffb67c39),
    Color(0xfffff1d3),
  ),
  'goat': CharacterDefinition(
    'goat',
    'Goat',
    Color(0xffd8c8ab),
    Color(0xff9d8968),
    Color(0xfffff8e8),
  ),
  'cow': CharacterDefinition(
    'cow',
    'Cow',
    Color(0xfff4eee4),
    Color(0xffb9a99a),
    Color(0xfffff8e8),
  ),
  'cat': CharacterDefinition(
    'cat',
    'Cat',
    Color(0xff8b72d9),
    Color(0xff5942a0),
    Color(0xfffff2dc),
  ),
  'rabbit': CharacterDefinition(
    'rabbit',
    'Rabbit',
    Color(0xffd7b9f1),
    Color(0xff9d78be),
    Color(0xfffff7e8),
  ),
};

const defaultFrockbotCharacterIdV1 = 'pixel';
