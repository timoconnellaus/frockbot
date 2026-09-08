/// The composer's rules: the draft, send readiness, the Turn limits and the
/// Skill invocation menu.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/composer.dart';
import 'package:frockbot_native/shell/skill_menu.dart';

SkillCatalogEntry entry(String slug, {String? name, String description = ''}) =>
    SkillCatalogEntry(
      ref: 'bot:$slug',
      skill: {'schemaVersion': 1, 'source': 'bot', 'slug': slug},
      name: name ?? slug,
      description: description,
      path: '/skills/$slug',
    );

void main() {
  group('composer draft restoration', () {
    test('retains a rejected submission in its originating Bot draft', () {
      final drafts = ComposerDraftStore();
      final submission = drafts.begin('bot-a', 'message for A');
      drafts.setDraft('bot-b', 'message for B');

      expect(drafts.reject(submission), 'message for A');
      expect(drafts.draftFor('bot-a'), 'message for A');
      expect(drafts.draftFor('bot-b'), 'message for B');
    });

    test('does not restore an older submission over a newer one', () {
      final drafts = ComposerDraftStore();
      final stale = drafts.begin('bot-a', 'older');
      final current = drafts.begin('bot-a', 'newer');

      expect(drafts.reject(stale), isNull);
      expect(drafts.reject(current), 'newer');
    });

    test('preserves text typed after submission alongside rejected text', () {
      final drafts = ComposerDraftStore();
      final submission = drafts.begin('bot-a', 'rejected');
      drafts.setDraft('bot-a', 'new draft');

      expect(drafts.reject(submission), 'rejected\n\nnew draft');
    });
  });

  group('what the composer needs and what a retry needs', () {
    test('a client with a Bot, a model and a connection can start a Turn', () {
      expect(
        sendReady(connection: 'ready', modelReady: true, activeBotId: 'scout'),
        isTrue,
      );
    });

    test('nothing is sent while the shell is not connected to its Bot', () {
      expect(
        sendReady(
          connection: 'connecting',
          modelReady: true,
          activeBotId: 'scout',
        ),
        isFalse,
      );
      expect(
        sendReady(
          connection: 'ready',
          modelReady: false,
          activeBotId: 'scout',
        ),
        isFalse,
      );
      expect(
        sendReady(connection: 'ready', modelReady: true),
        isFalse,
      );
    });

    test('an empty or oversized draft is not sendable', () {
      expect(draftSendable(''), isFalse);
      expect(draftSendable('book it'), isTrue);
      expect(draftSendable('x' * (turnTextMaxCharacters + 1)), isFalse);
    });

    /// The case Try again exists for. The message was admitted, so the
    /// composer was cleared; the Turn then failed retryably. Readiness is the
    /// whole of what trying again needs — the words come off the person's own
    /// line in the thread, not out of the empty composer.
    test('trying again is available with an empty composer', () {
      final ready = sendReady(
        connection: 'ready',
        modelReady: true,
        activeBotId: 'scout',
      );
      expect(ready && draftSendable(''), isFalse);
      expect(ready, isTrue);
    });

    test('the counter appears only as the budget runs out', () {
      expect(turnTextCounterVisible('book it'), isFalse);
      expect(turnTextCounterVisible('x' * turnTextCounterFrom), isTrue);
      expect(turnTextRemaining('x' * turnTextMaxCharacters), 0);
      expect(turnTextTooLong('x' * (turnTextMaxCharacters + 1)), isTrue);
    });
  });

  group('the Skill popover reads the composer', () {
    test('opens at the start of a message and after whitespace', () {
      expect(skillPopoverFor('/rev', 4)?.trigger, '/');
      expect(skillPopoverFor('/rev', 4)?.query, 'rev');
      expect(skillPopoverFor('ship it @rel', 12)?.trigger, '@');
    });

    test('does not open inside an email address or a path', () {
      expect(skillPopoverFor('tim@example.com', 15), isNull);
      expect(skillPopoverFor('src/shell/main', 14), isNull);
    });

    test('closes again on any whitespace after the trigger', () {
      expect(skillPopoverFor('/rev ', 5), isNull);
    });

    test('removes the trigger and its query on selection', () {
      const text = 'ship it /rev';
      final popover = skillPopoverFor(text, text.length)!;
      final replaced = textWithoutSkillTrigger(text, popover, text.length);

      expect(replaced.text, 'ship it ');
      expect(replaced.caret, 8);
    });
  });

  group('the candidates a query offers', () {
    final catalog = [
      entry('review', name: 'Review'),
      entry('release', name: 'Release'),
      entry('deploy', name: 'Deploy', description: 'review the release'),
    ];

    test('an exact name sorts above a prefix, above a substring', () {
      expect(
        [for (final c in rankSkillCandidates(catalog, 'review')) c.entry.ref],
        ['bot:review', 'bot:deploy'],
      );
      expect(rankSkillCandidates(catalog, 'review').first.rank, 1);
      expect(rankSkillCandidates(catalog, 'review').last.rank, 4);
    });

    // With no query nothing distinguishes one Skill from another, so the tie
    // break is the whole order — by ref, which is stable across reads.
    test('no query offers everything, ordered by ref', () {
      expect(
        [for (final c in rankSkillCandidates(catalog, '')) c.entry.ref],
        ['bot:deploy', 'bot:release', 'bot:review'],
      );
      expect(rankSkillCandidates(catalog, '').first.rank, 0);
    });

    test('ties break on the ref, not on catalog order', () {
      expect(
        [for (final c in rankSkillCandidates(catalog, 'e')) c.entry.ref],
        ['bot:deploy', 'bot:release', 'bot:review'],
      );
    });

    test('an attached Skill is not offered a second time', () {
      expect(
        [
          for (final c in rankSkillCandidates(
            catalog,
            '',
            exclude: ['bot:review'],
          ))
            c.entry.ref,
        ],
        ['bot:deploy', 'bot:release'],
      );
    });
  });

  group('the popover keyboard model', () {
    final candidates = rankSkillCandidates([
      entry('a'),
      entry('b'),
      entry('c'),
    ], '');

    /// The popover is refreshed from the composer's own keystrokes, including
    /// the one that has just moved the highlight, so the highlight is carried
    /// by ref: the Skill under it keeps its place for as long as the query
    /// still offers it.
    test('keeps the highlight on the Skill it was on', () {
      expect(keptSkillHighlight('bot:b', candidates), 1);
      expect(keptSkillHighlight('bot:gone', candidates), 0);
      expect(keptSkillHighlight('bot:b', const []), 0);
    });

    test('moves the highlight, wrapping at both ends', () {
      expect(nextSkillHighlight(2, 3, 1), 0);
      expect(nextSkillHighlight(0, 3, -1), 2);
      expect(nextSkillHighlight(0, 0, 1), 0);
    });
  });

  group('the attached refs', () {
    test('are bounded at three and never duplicated', () {
      final store = SkillAttachmentStore();

      expect(store.attach(entry('a')), isTrue);
      expect(store.attach(entry('a')), isFalse);
      expect(store.attach(entry('b')), isTrue);
      expect(store.attach(entry('c')), isTrue);
      expect(store.full, isTrue);
      expect(store.attach(entry('d')), isFalse);
      expect(store.attached.length, maxInvokedSkills);
    });

    test('are handed over once and put back on a refusal', () {
      final store = SkillAttachmentStore();
      store.attach(entry('a'));
      final held = store.attached;

      expect(store.take().length, 1);
      expect(store.attached, isEmpty);

      store.restore(held);
      expect([for (final e in store.attached) e.ref], ['bot:a']);
    });

    test('detaching removes exactly the one named', () {
      final store = SkillAttachmentStore();
      store.attach(entry('a'));
      store.attach(entry('b'));
      store.detach('bot:a');

      expect([for (final e in store.attached) e.ref], ['bot:b']);
    });
  });
}
