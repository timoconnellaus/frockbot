/// How a Bot sounds, as the settings surface offers it (ADR 0031).
///
/// A mirror of `app/voice/appearance.ts`, which is the source of truth: the
/// thirty prebuilt Gemini voices with Google's one-word character for each,
/// the accent and attitude presets, and the delivery dials. Only the parts a
/// client needs are here — the labels and the slugs. Rendering a preset into
/// prose is the server's, because the wording of "dry and deadpan" must be
/// able to improve for every Bot at once without shipping an app.
///
/// Nothing here talks to the network. What a Bot stores is slugs, so a
/// picker validates against these lists and sends the slug back unchanged.
library;

/// One of Gemini's prebuilt voices, as the settings picker shows it.
class GeminiVoiceOptionV1 {
  /// Sent as `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
  final String voiceName;

  /// Google's one-word character for the voice.
  final String character;
  const GeminiVoiceOptionV1(this.voiceName, this.character);
}

/// The thirty prebuilt voices native-audio models accept.
const geminiVoicesV1 = <GeminiVoiceOptionV1>[
  GeminiVoiceOptionV1('Zephyr', 'Bright'),
  GeminiVoiceOptionV1('Puck', 'Upbeat'),
  GeminiVoiceOptionV1('Charon', 'Informative'),
  GeminiVoiceOptionV1('Kore', 'Firm'),
  GeminiVoiceOptionV1('Fenrir', 'Excitable'),
  GeminiVoiceOptionV1('Leda', 'Youthful'),
  GeminiVoiceOptionV1('Orus', 'Firm'),
  GeminiVoiceOptionV1('Aoede', 'Breezy'),
  GeminiVoiceOptionV1('Callirrhoe', 'Easy-going'),
  GeminiVoiceOptionV1('Autonoe', 'Bright'),
  GeminiVoiceOptionV1('Enceladus', 'Breathy'),
  GeminiVoiceOptionV1('Iapetus', 'Clear'),
  GeminiVoiceOptionV1('Umbriel', 'Easy-going'),
  GeminiVoiceOptionV1('Algieba', 'Smooth'),
  GeminiVoiceOptionV1('Despina', 'Smooth'),
  GeminiVoiceOptionV1('Erinome', 'Clear'),
  GeminiVoiceOptionV1('Algenib', 'Gravelly'),
  GeminiVoiceOptionV1('Rasalgethi', 'Informative'),
  GeminiVoiceOptionV1('Laomedeia', 'Upbeat'),
  GeminiVoiceOptionV1('Achernar', 'Soft'),
  GeminiVoiceOptionV1('Alnilam', 'Firm'),
  GeminiVoiceOptionV1('Schedar', 'Even'),
  GeminiVoiceOptionV1('Gacrux', 'Mature'),
  GeminiVoiceOptionV1('Pulcherrima', 'Forward'),
  GeminiVoiceOptionV1('Achird', 'Friendly'),
  GeminiVoiceOptionV1('Zubenelgenubi', 'Casual'),
  GeminiVoiceOptionV1('Vindemiatrix', 'Gentle'),
  GeminiVoiceOptionV1('Sadachbia', 'Lively'),
  GeminiVoiceOptionV1('Sadaltager', 'Knowledgeable'),
  GeminiVoiceOptionV1('Sulafat', 'Warm'),
];

GeminiVoiceOptionV1? findGeminiVoiceV1(String? voiceName) {
  if (voiceName == null) return null;
  for (final voice in geminiVoicesV1) {
    if (voice.voiceName == voiceName) return voice;
  }
  return null;
}

/// The voice used when nothing — not the Bot, not its character — says.
const defaultGeminiVoiceV1 = 'Schedar';

/// A default voice per character, so two Bots never sound the same without
/// anyone opening settings.
const geminiVoiceByCharacterV1 = <String, String>{
  'pixel': 'Schedar',
  'guardian': 'Orus',
  'sunny': 'Puck',
  'chill': 'Callirrhoe',
  'nudge': 'Achird',
  'fox': 'Zubenelgenubi',
  'dog': 'Sulafat',
  'goat': 'Gacrux',
  'cow': 'Vindemiatrix',
  'cat': 'Despina',
  'rabbit': 'Leda',
};

String defaultGeminiVoiceForCharacterV1(String? characterId) =>
    geminiVoiceByCharacterV1[characterId] ?? defaultGeminiVoiceV1;

/// A preset the person picks by its label and the Bot stores by its slug.
class VoicePresetV1 {
  final String slug;
  final String label;
  const VoicePresetV1(this.slug, this.label);
}

/// The accents. The prose and the BCP-47 tag that travels with it are the
/// server's; a client only ever names the slug.
const voiceAccentsV1 = <VoicePresetV1>[
  VoicePresetV1('australian', 'Australian'),
  VoicePresetV1('british', 'British'),
  VoicePresetV1('northern-english', 'Northern English'),
  VoicePresetV1('scottish', 'Scottish'),
  VoicePresetV1('irish', 'Irish'),
  VoicePresetV1('american', 'American'),
  VoicePresetV1('southern-us', 'Southern US'),
  VoicePresetV1('canadian', 'Canadian'),
  VoicePresetV1('new-zealand', 'New Zealand'),
  VoicePresetV1('south-african', 'South African'),
  VoicePresetV1('indian', 'Indian'),
];

/// The attitudes: a personality, so exactly one is chosen.
const voiceAttitudesV1 = <VoicePresetV1>[
  VoicePresetV1('warm-friendly', 'Warm & friendly'),
  VoicePresetV1('calm-reassuring', 'Calm & reassuring'),
  VoicePresetV1('brisk-efficient', 'Brisk & efficient'),
  VoicePresetV1('upbeat-energetic', 'Upbeat & energetic'),
  VoicePresetV1('dry-deadpan', 'Dry & deadpan'),
  VoicePresetV1('playful-teasing', 'Playful & teasing'),
  VoicePresetV1('professional-neutral', 'Professional & neutral'),
  VoicePresetV1('blunt-direct', 'Blunt & direct'),
  VoicePresetV1('thoughtful-measured', 'Thoughtful & measured'),
  VoicePresetV1('gentle-patient', 'Gentle & patient'),
  VoicePresetV1('nerdy-enthusiastic', 'Nerdy & enthusiastic'),
  VoicePresetV1('low-key-conspiratorial', 'Low-key & conspiratorial'),
];

/// The dials: independent of each other and of the attitude.
const voicePacesV1 = <VoicePresetV1>[
  VoicePresetV1('slower', 'Slower'),
  VoicePresetV1('natural', 'Natural'),
  VoicePresetV1('faster', 'Faster'),
];
const voiceTurnLengthsV1 = <VoicePresetV1>[
  VoicePresetV1('terse', 'Terse'),
  VoicePresetV1('natural', 'Natural'),
  VoicePresetV1('chatty', 'Chatty'),
];
const voiceHumoursV1 = <VoicePresetV1>[
  VoicePresetV1('none', 'None'),
  VoicePresetV1('dry', 'Dry'),
  VoicePresetV1('playful', 'Playful'),
];
const voiceDisfluenciesV1 = <VoicePresetV1>[
  VoicePresetV1('clean', 'Clean'),
  VoicePresetV1('natural', 'Natural'),
];

const voiceCustomMaxCharsV1 = 500;

String? voicePresetLabelV1(List<VoicePresetV1> presets, String? slug) {
  if (slug == null) return null;
  for (final preset in presets) {
    if (preset.slug == slug) return preset.label;
  }
  return null;
}

/// The described half of a voice. Every field is optional: what is not set
/// is not said, and the delivery block shrinks to nothing.
class VoiceDeliveryV1 {
  final String? accent;
  final String? attitude;
  final String? pace;
  final String? turnLength;
  final String? humour;
  final String? disfluency;

  /// Not offered on this surface, and carried through untouched so a value
  /// set elsewhere survives a save from here.
  final String? formality;

  /// The person's own words, appended last so they win a tie.
  final String? custom;
  const VoiceDeliveryV1({
    this.accent,
    this.attitude,
    this.pace,
    this.turnLength,
    this.humour,
    this.disfluency,
    this.formality,
    this.custom,
  });

  VoiceDeliveryV1 copyWith({
    Object? accent = _keep,
    Object? attitude = _keep,
    Object? pace = _keep,
    Object? turnLength = _keep,
    Object? humour = _keep,
    Object? disfluency = _keep,
    Object? custom = _keep,
  }) => VoiceDeliveryV1(
    accent: _pick(accent, this.accent),
    attitude: _pick(attitude, this.attitude),
    pace: _pick(pace, this.pace),
    turnLength: _pick(turnLength, this.turnLength),
    humour: _pick(humour, this.humour),
    disfluency: _pick(disfluency, this.disfluency),
    formality: formality,
    custom: _pick(custom, this.custom),
  );

  /// Only the keys that are set, so the command carries what was chosen and
  /// nothing else.
  Map<String, Object?> toJson() => {
    if (accent != null) 'accent': accent,
    if (attitude != null) 'attitude': attitude,
    if (pace != null) 'pace': pace,
    if (turnLength != null) 'turnLength': turnLength,
    if (humour != null) 'humour': humour,
    if (disfluency != null) 'disfluency': disfluency,
    if (formality != null) 'formality': formality,
    if (custom != null && custom!.isNotEmpty) 'custom': custom,
  };

  static VoiceDeliveryV1 fromJson(Object? input) {
    if (input is! Map) return const VoiceDeliveryV1();
    String? slug(String key, List<VoicePresetV1> allowed) {
      final value = input[key];
      if (value is! String) return null;
      return voicePresetLabelV1(allowed, value) == null ? null : value;
    }

    final custom = input['custom'];
    final formality = input['formality'];
    return VoiceDeliveryV1(
      accent: slug('accent', voiceAccentsV1),
      attitude: slug('attitude', voiceAttitudesV1),
      pace: slug('pace', voicePacesV1),
      turnLength: slug('turnLength', voiceTurnLengthsV1),
      humour: slug('humour', voiceHumoursV1),
      disfluency: slug('disfluency', voiceDisfluenciesV1),
      formality: formality is String ? formality : null,
      custom: custom is String && custom.isNotEmpty ? custom : null,
    );
  }
}

/// What a Bot stores: Gemini's one typed field, then the prose presets.
class BotVoiceAppearanceV1 {
  final String voiceName;
  final VoiceDeliveryV1 delivery;
  const BotVoiceAppearanceV1({
    required this.voiceName,
    this.delivery = const VoiceDeliveryV1(),
  });

  BotVoiceAppearanceV1 copyWith({
    String? voiceName,
    VoiceDeliveryV1? delivery,
  }) => BotVoiceAppearanceV1(
    voiceName: voiceName ?? this.voiceName,
    delivery: delivery ?? this.delivery,
  );

  Map<String, Object?> toJson() => {
    'schemaVersion': 1,
    'voiceName': voiceName,
    'delivery': delivery.toJson(),
  };

  /// Lenient, unlike the server's decoder: a client that cannot read what it
  /// was sent shows the character's default rather than an empty page.
  static BotVoiceAppearanceV1? fromJson(Object? input) {
    if (input is! Map) return null;
    final name = input['voiceName'];
    if (findGeminiVoiceV1(name is String ? name : null) == null) return null;
    return BotVoiceAppearanceV1(
      voiceName: name! as String,
      delivery: VoiceDeliveryV1.fromJson(input['delivery']),
    );
  }
}

/// The voice a Bot speaks in: its own, else its character's default with no
/// delivery presets. Never null — Gemini always has a voice to give.
BotVoiceAppearanceV1 resolveBotVoiceV1({
  BotVoiceAppearanceV1? chosen,
  String? characterId,
}) =>
    chosen ??
    BotVoiceAppearanceV1(
      voiceName: defaultGeminiVoiceForCharacterV1(characterId),
    );

/// The one line that says how a Bot sounds: its voice, then whatever of the
/// accent and attitude it has chosen.
String voiceSummaryLineV1(BotVoiceAppearanceV1 voice) => [
  voice.voiceName,
  ?voicePresetLabelV1(voiceAccentsV1, voice.delivery.accent),
  ?voicePresetLabelV1(voiceAttitudesV1, voice.delivery.attitude),
].join(' · ');

const _keep = Object();
String? _pick(Object? next, String? current) =>
    identical(next, _keep) ? current : next as String?;
