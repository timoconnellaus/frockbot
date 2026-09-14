/// What General offers in its empty conversation.
///
/// A new account's first screen is General with nothing said yet, so this is
/// where a person learns what a Bot is for. Each suggestion only writes into
/// the composer: the person reads it, fills in the bracketed part and decides
/// whether to send, because a tap on a card must never spend a Turn.
///
/// A suggestion that leans on a feature this Bot does not run is not offered.
/// The Bot's Plugins frame is the authority on that; when it cannot be read,
/// only the suggestions that need nothing are shown.
library;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import 'semantics.dart';

/// The Bot the account's authority provisioned. Clients suffix every id they
/// mint, so a bare `general` is only ever that one (`GENERAL_BOT_ID_V1`).
const generalBotIdV1 = 'general';

class StarterSuggestionV1 {
  final String id;
  final String title;
  final String draft;
  final IconData icon;

  /// The first-party feature the suggestion needs switched on for this Bot.
  final String? requires;
  const StarterSuggestionV1({
    required this.id,
    required this.title,
    required this.draft,
    required this.icon,
    this.requires,
  });
}

const starterSuggestionsV1 = <StarterSuggestionV1>[
  StarterSuggestionV1(
    id: 'research',
    title: 'Research something and recommend what to do',
    draft: 'Research [topic] and recommend what I should do. Compare the main options and explain why.',
    icon: Icons.travel_explore,
    requires: 'web',
  ),
  StarterSuggestionV1(
    id: 'project',
    title: 'Plan and complete a project',
    draft: 'Help me plan and complete [project]. Break it into steps, then work through them with me.',
    icon: Icons.checklist,
  ),
  StarterSuggestionV1(
    id: 'recurring',
    title: 'Set up a recurring check',
    draft: 'Every [weekday morning], check [what to watch] and tell me when something needs my attention.',
    icon: Icons.event_repeat,
    requires: 'routines',
  ),
  StarterSuggestionV1(
    id: 'specialist',
    title: 'Create a specialist Bot',
    draft: 'Create a specialist Bot for [job], with instructions suited to it, and tell me what it will do.',
    icon: Icons.add_reaction_outlined,
  ),
];

/// The suggestions a Bot running [features] can act on. Null means the
/// features are unknown, which offers only what needs none.
List<StarterSuggestionV1> startersForV1(Set<String>? features) => [
  for (final starter in starterSuggestionsV1)
    if (starter.requires == null ||
        (features?.contains(starter.requires) ?? false))
      starter,
];

/// The features this Bot runs now, from its Plugins frame, or null when the
/// frame could not be read.
Future<Set<String>?> readBotFeaturesV1(NativeApi api, String botId) async {
  try {
    final frame = await api.request(
      '/api/bots/${Uri.encodeComponent(botId)}/plugins',
    );
    return {
      for (final row in ((frame! as Map)['plugins']! as List).cast<Map>())
        if (row['on'] == true) row['pluginId']! as String,
    };
  } catch (_) {
    return null;
  }
}

/// The selection a prefilled draft opens with: its first bracketed part, so
/// the first keystroke replaces the placeholder, or the end of the text.
TextSelection starterSelectionV1(String draft) {
  final start = draft.indexOf('[');
  final end = start < 0 ? -1 : draft.indexOf(']', start);
  return end < 0
      ? TextSelection.collapsed(offset: draft.length)
      : TextSelection(baseOffset: start, extentOffset: end + 1);
}

class StarterSuggestions extends StatelessWidget {
  final List<StarterSuggestionV1> starters;
  final void Function(StarterSuggestionV1) onSelect;
  const StarterSuggestions({
    super.key,
    required this.starters,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      StarterIds.list,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final starter in starters)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: identified(
                StarterIds.suggestion(starter.id),
                OutlinedButton.icon(
                  key: ValueKey('starter-${starter.id}'),
                  onPressed: () => onSelect(starter),
                  icon: Icon(starter.icon, size: 20),
                  label: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(starter.title),
                  ),
                  style: OutlinedButton.styleFrom(
                    alignment: Alignment.centerLeft,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 14,
                    ),
                    foregroundColor: theme.colorScheme.onSurface,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
