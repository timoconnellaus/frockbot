/// What a Turn actually did.
///
/// Tool receipts are not chat: the thread is the Bot's words, and what it
/// called to produce them belongs on a Work view the person opens from the
/// message. On the phone that is a page; at wide widths it is the right panel.
library;

import 'package:flutter/material.dart';

import 'desktop_layout.dart';
import 'semantics.dart';
import 'transcript_model.dart';

/// The words a running Turn earns in the thread — and only those. A plain
/// running Turn draws nothing here: the Bot itself, working wherever it is
/// drawn, says that. Two states still need a line of text above the
/// composer: a Stop the person asked for and is waiting on, and a Turn
/// waiting behind the one it displaced.
class WorkingIndicator extends StatelessWidget {
  final String label;
  const WorkingIndicator({super.key, required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.workingNotice,
      Semantics(
        liveRegion: true,
        label: label,
        child: Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

// ----------------------------------------------------------- the run view

/// A Turn's receipts: what it called, what came back, and how it ended.
class RunView extends StatelessWidget {
  final TranscriptLine line;
  final VoidCallback? onClose;

  /// Off where the surface already carries a title of its own — the page on a
  /// phone has an app bar, and two headings saying "Work" is one too many.
  final bool header;
  const RunView({
    super.key,
    required this.line,
    this.onClose,
    this.header = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.runView,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (header) ...[
            DesktopWindowDragRegion(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text('Work', style: theme.textTheme.titleMedium),
                    ),
                    if (onClose != null)
                      identified(
                        ShellIds.runViewClose,
                        IconButton(
                          tooltip: 'Close',
                          onPressed: onClose,
                          icon: const Icon(Icons.close),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const Divider(height: 1),
          ],
          Expanded(
            child:
                line.tools.isEmpty &&
                    line.sends.isEmpty &&
                    line.pluginCalls.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.build_outlined,
                            size: 32,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'This reply used no tools.',
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    children: [
                      for (final tool in line.tools) _ToolRow(tool: tool),
                      if (line.pluginCalls.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                          child: Text(
                            'Plugins',
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                        for (final call in line.pluginCalls)
                          _PluginCallRow(call: call),
                      ],
                      if (line.notice != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                          child: Text(
                            line.notice!,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

/// One model call a Plugin made, as the receipt reads it: the Plugin, the
/// model, the tokens, and the cost when the account was billed for it.
class _PluginCallRow extends StatelessWidget {
  final PluginModelCall call;
  const _PluginCallRow({required this.call});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cost = call.cost;
    return ListTile(
      dense: true,
      leading: Icon(
        Icons.extension_outlined,
        size: 18,
        color: theme.colorScheme.primary,
      ),
      title: Text(call.pluginId, style: theme.textTheme.bodyMedium),
      subtitle: Text(
        '${call.model} · ${call.inputTokens} in, ${call.outputTokens} out'
        '${cost == null ? '' : ' · $cost'}',
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  final ToolActivity tool;
  const _ToolRow({required this.tool});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, colour) = switch (tool.status) {
      'failed' => (Icons.error_outline, theme.colorScheme.error),
      'running' => (Icons.more_horiz, theme.colorScheme.onSurfaceVariant),
      _ => (Icons.check_circle_outline, theme.colorScheme.primary),
    };
    return ExpansionTile(
      dense: true,
      shape: const Border(),
      collapsedShape: const Border(),
      leading: Icon(icon, size: 18, color: colour),
      title: Text(tool.name, style: theme.textTheme.bodyMedium),
      subtitle: Text(tool.status, style: theme.textTheme.bodySmall),
      childrenPadding: const EdgeInsets.fromLTRB(52, 0, 16, 12),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (tool.input != null)
          SelectableText(
            '${tool.input}',
            style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
          ),
        if (tool.text != null) ...[
          const SizedBox(height: 8),
          SelectableText(tool.text!, style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}
