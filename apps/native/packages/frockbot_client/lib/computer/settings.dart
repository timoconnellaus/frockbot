/// The Computer's own settings: a checkpoint, a Reset to it, and an Update to
/// a fresh machine.
///
/// One Computer serves every Bot of the User, so everything here happens to
/// all of them, and the page says so before anything else. Reset and Update
/// each take two gestures — the row, then a dialog that says what stays and
/// what goes — because both throw away the machine's own state.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/dialogs.dart';
import '../theme/rows.dart';
import 'client.dart';

/// What both actions keep, in the words the dialogs use.
const computerKeptCopyV1 =
    'Kept: your Bots’ Skills and memory, the files your Plugins keep, and '
    'your browser sign-ins.';

/// What Reset loses.
const computerResetLostCopyV1 =
    'Lost: everything installed or changed on the machine since then, and '
    'every other file on it.';

/// What Update loses.
const computerUpdateLostCopyV1 =
    'Lost: everything installed on the machine, every other file on it, and '
    'its checkpoints.';

/// Which sign-ins survive, said once at the foot of the page.
const computerSignInsCopyV1 =
    'Sign-ins are the browser’s cookies, kept sealed off the Computer as they '
    'were when last saved: when the desktop was last handed back, or a Bot '
    'last used the browser. Passwords saved in the browser are not kept.';

/// The age of the newest checkpoint, or that there is none.
String computerCheckpointLineV1(DateTime? checkpointAt, {DateTime? now}) {
  if (checkpointAt == null) return 'No checkpoint saved yet';
  final age = (now ?? DateTime.now()).difference(checkpointAt);
  if (age.inMinutes < 1) return 'Last checkpoint saved just now';
  if (age.inHours < 1) return 'Last checkpoint saved ${age.inMinutes}m ago';
  if (age.inDays < 1) return 'Last checkpoint saved ${age.inHours}h ago';
  return 'Last checkpoint saved ${age.inDays}d ago';
}

class ComputerSettingsPage extends StatelessWidget {
  final ComputerController controller;
  const ComputerSettingsPage({super.key, required this.controller});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(child: AppBar(title: const Text('Computer'))),
    body: SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: ComputerSettingsView(controller: controller),
          ),
        ),
      ),
    ),
  );
}

class ComputerSettingsView extends StatelessWidget {
  final ComputerController controller;
  const ComputerSettingsView({super.key, required this.controller});

  static const _moving = {'provisioning', 'updating', 'taking-control'};

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final theme = Theme.of(context);
      final state = controller.state;
      final moving = _moving.contains(state.phase);
      final held = state.phase == 'human-control';
      final idle = !controller.busy && !moving;
      final quiet = theme.textTheme.bodySmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      );
      return identified(
        ComputerSettingsIds.page,
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
              child: Text(
                'One Computer is shared by all your Bots. What you do here '
                'happens to it for every one of them.',
                style: quiet,
              ),
            ),
            if (moving || state.phase == 'error' || controller.failure != null)
              _status(context, state),
            const FrockSectionLabel('Checkpoint'),
            FrockRowGroup(
              rows: [
                identified(
                  ComputerSettingsIds.save,
                  FrockRow(
                    icon: Icons.bookmark_add_outlined,
                    title: 'Save a checkpoint',
                    subtitle: computerCheckpointLineV1(state.checkpointAt),
                    chevron: false,
                    onTap: idle
                        ? () => unawaited(controller.command('saveCheckpoint'))
                        : null,
                  ),
                ),
              ],
            ),
            const FrockSectionLabel('Start over'),
            FrockRowGroup(
              rows: [
                identified(
                  ComputerSettingsIds.reset,
                  FrockRow(
                    icon: Icons.history_rounded,
                    title: 'Reset Computer',
                    subtitle: held
                        ? 'Release the desktop first'
                        : state.checkpointAt == null
                        ? 'Save a checkpoint first'
                        : 'Back to the last checkpoint',
                    onTap: idle && !held && state.checkpointAt != null
                        ? () => unawaited(_reset(context))
                        : null,
                  ),
                ),
                identified(
                  ComputerSettingsIds.update,
                  FrockRow(
                    icon: Icons.system_update_alt_rounded,
                    title: 'Update Computer',
                    subtitle: held
                        ? 'Release the desktop first'
                        : 'A fresh machine, keeping files and sign-ins',
                    onTap: idle && !held
                        ? () => unawaited(_update(context))
                        : null,
                  ),
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 14, 4, 0),
              child: Text(computerSignInsCopyV1, style: quiet),
            ),
          ],
        ),
      );
    },
  );

  /// What the Computer is doing now, or what refused.
  Widget _status(BuildContext context, ComputerProjection state) {
    final progress = state.progress;
    final line = controller.failure ?? progress?.activeLabel ?? state.message;
    return identified(
      ComputerSettingsIds.status,
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 4),
        child: Semantics(
          liveRegion: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (progress != null) ...[
                Text(
                  computerOpeningHeadingV1(state),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 6),
                LinearProgressIndicator(minHeight: 2, value: progress.fraction),
                const SizedBox(height: 6),
              ],
              Text(
                line,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: state.phase == 'error' || controller.failure != null
                      ? Theme.of(context).colorScheme.error
                      : Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _reset(BuildContext context) async {
    final when = computerCheckpointLineV1(controller.state.checkpointAt)
        .replaceFirst('Last checkpoint saved ', '');
    if (await _confirm(
      context,
      id: ComputerSettingsIds.resetConfirm,
      title: 'Reset the Computer?',
      lines: [
        'It goes back to the checkpoint saved $when.',
        computerKeptCopyV1,
        computerResetLostCopyV1,
      ],
      action: 'Reset',
    )) {
      await controller.command('resetComputer');
    }
  }

  Future<void> _update(BuildContext context) async {
    if (await _confirm(
      context,
      id: ComputerSettingsIds.updateConfirm,
      title: 'Update the Computer?',
      lines: [
        'It is replaced by a fresh machine running the latest system, which '
            'takes a few minutes.',
        computerKeptCopyV1,
        computerUpdateLostCopyV1,
      ],
      action: 'Update',
    )) {
      await controller.command('updateComputer');
    }
  }

  Future<bool> _confirm(
    BuildContext context, {
    required String id,
    required String title,
    required List<String> lines,
    required String action,
  }) async =>
      await showDialog<bool>(
        context: context,
        builder: (dialog) => identified(
          id,
          AlertDialog(
            insetPadding: frockDialogInset,
            title: frockDialogTitle(Text(title)),
            content: frockDialogBody(
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final (index, line) in lines.indexed) ...[
                    if (index > 0) const SizedBox(height: 10),
                    Text(line),
                  ],
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: Theme.of(dialog).colorScheme.error,
                  foregroundColor: Theme.of(dialog).colorScheme.onError,
                ),
                onPressed: () => Navigator.pop(dialog, true),
                child: Text(action),
              ),
            ],
          ),
        ),
      ) ??
      false;
}
