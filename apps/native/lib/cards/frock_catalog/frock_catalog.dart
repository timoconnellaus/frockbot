/// The Frock catalog: FrockBot's own A2UI components, drawn by the host.
///
/// Five components, the first family of ADR 0030's catalog. Each is a
/// `CatalogItem` whose `dataSchema` comes from `schemas.dart` — the schema is
/// never written twice — and whose widget is ordinary app code in the app's
/// theme. That is the whole of the protocol's security model on this side: a
/// Card names a component and binds values to it, and what appears on the
/// screen is code this build compiled in.
///
/// `ApprovalActions` is the one with a rule of its own. The buttons are the
/// host's, the labels are the only thing a card may choose, and the action
/// names are minted here from the `approvalId` the kernel issued — a Plugin
/// may compose the component into a card, and may never restyle it or name
/// its own action. Trust chrome is a component only the host draws.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';
import 'package:json_schema_builder/json_schema_builder.dart';

import '../press.dart';
import 'schemas.dart';
import 'tone.dart';

/// One Frock component's schema, as `CatalogItem` wants it.
Schema _schemaOf(String name) {
  final schema = frockCatalogSchemasV1[name];
  if (schema == null) throw StateError('no schema for Frock $name');
  return Schema.fromMap(schema);
}

String? _string(Object? value) => value is String ? value : null;

/// A small pill naming the card's state, in the tone's colours.
final frockStatusPill = CatalogItem(
  name: 'StatusPill',
  dataSchema: _schemaOf('StatusPill'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    return BoundString(
      dataContext: itemContext.dataContext,
      value: data['label'],
      builder: (context, label) => FrockStatusPillView(
        label: label ?? '',
        tone: FrockTone.read(data['tone']),
      ),
    );
  },
);

/// The pill itself, so the host can draw one outside a surface too.
class FrockStatusPillView extends StatelessWidget {
  final String label;
  final FrockTone tone;
  const FrockStatusPillView({
    super.key,
    required this.label,
    this.tone = FrockTone.neutral,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = frockToneColorsV1(theme, tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: colors.wash,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelMedium?.copyWith(
          color: colors.ink,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// Labelled values in a column: From, To, Cc, Subject.
final frockKeyValueRows = CatalogItem(
  name: 'KeyValueRows',
  dataSchema: _schemaOf('KeyValueRows'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final rows = [
      for (final row in (data['rows'] as List?) ?? const [])
        if (row is Map) row.cast<String, Object?>(),
    ];
    final theme = Theme.of(itemContext.buildContext);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 72,
                  child: Text(
                    _string(row['label']) ?? '',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: BoundString(
                    dataContext: itemContext.dataContext,
                    value: row['value'],
                    builder: (context, value) =>
                        Text(value ?? '', style: theme.textTheme.bodyMedium),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  },
);

/// A body of text that starts collapsed. The control says which way it goes.
final frockCollapsibleText = CatalogItem(
  name: 'CollapsibleText',
  dataSchema: _schemaOf('CollapsibleText'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final lines = data['collapsedLines'];
    return BoundString(
      dataContext: itemContext.dataContext,
      value: data['text'],
      builder: (context, text) => FrockCollapsibleTextView(
        text: text ?? '',
        collapsedLines: lines is int && lines > 0 && lines <= 40 ? lines : 6,
      ),
    );
  },
);

class FrockCollapsibleTextView extends StatefulWidget {
  final String text;
  final int collapsedLines;
  const FrockCollapsibleTextView({
    super.key,
    required this.text,
    this.collapsedLines = 6,
  });

  @override
  State<FrockCollapsibleTextView> createState() =>
      _FrockCollapsibleTextViewState();
}

class _FrockCollapsibleTextViewState extends State<FrockCollapsibleTextView> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.bodyMedium;
    return LayoutBuilder(
      builder: (context, constraints) {
        // Whether there is anything to show is measured, not guessed: a body
        // that already fits draws no control, so a two-line note never offers
        // to expand into itself.
        final painter = TextPainter(
          text: TextSpan(text: widget.text, style: style),
          maxLines: widget.collapsedLines,
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
        )..layout(maxWidth: constraints.maxWidth);
        final overflows = painter.didExceedMaxLines;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              widget.text,
              style: style,
              maxLines: expanded || !overflows ? null : widget.collapsedLines,
              overflow: expanded || !overflows
                  ? TextOverflow.clip
                  : TextOverflow.ellipsis,
            ),
            if (overflows)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: InkWell(
                  onTap: () => setState(() => expanded = !expanded),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text(
                      expanded ? 'Show less' : 'Show more',
                      style: theme.textTheme.labelLarge?.copyWith(
                        color: theme.colorScheme.primary,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// The approve and decline controls for one Approval the kernel issued.
///
/// The action names are `approval/<approvalId>`, built here from the id in the
/// component's data: the card supplies the id, the host supplies the name, and
/// the kernel refuses an id it never recorded.
final frockApprovalActions = CatalogItem(
  name: 'ApprovalActions',
  dataSchema: _schemaOf('ApprovalActions'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final approvalId = _string(data['approvalId']) ?? '';
    final name = 'approval/$approvalId';
    final pending = CardPressScope.pendingOf(itemContext.buildContext);
    final busy = pending == name;
    final frozen = pending != null;
    void decide(String decision) => itemContext.dispatchEvent(
      UserActionEvent(
        name: name,
        sourceComponentId: itemContext.id,
        context: {'decision': decision},
      ),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        FilledButton(
          onPressed: approvalId.isEmpty || frozen
              ? null
              : () => decide('approve'),
          child: Text(
            busy ? 'Working…' : _string(data['approveLabel']) ?? 'Approve',
          ),
        ),
        const SizedBox(width: 8),
        TextButton(
          onPressed: approvalId.isEmpty || frozen
              ? null
              : () => decide('decline'),
          child: Text(_string(data['declineLabel']) ?? 'Decline'),
        ),
      ],
    );
  },
);

/// The settled state: a title, the pill, and one line saying what happened.
final frockReceipt = CatalogItem(
  name: 'Receipt',
  dataSchema: _schemaOf('Receipt'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final tone = FrockTone.read(data['tone'], fallback: FrockTone.success);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(
              child: BoundString(
                dataContext: itemContext.dataContext,
                value: data['title'],
                builder: (context, title) =>
                    Text(title ?? '', style: theme.textTheme.titleSmall),
              ),
            ),
            const SizedBox(width: 8),
            BoundString(
              dataContext: itemContext.dataContext,
              value: data['status'],
              builder: (context, status) =>
                  FrockStatusPillView(label: status ?? '', tone: tone),
            ),
          ],
        ),
        if (data['summary'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: BoundString(
              dataContext: itemContext.dataContext,
              value: data['summary'],
              builder: (context, summary) => Text(
                summary ?? '',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
      ],
    );
  },
);

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockCatalogItemsV1 = List.unmodifiable([
  frockStatusPill,
  frockKeyValueRows,
  frockCollapsibleText,
  frockApprovalActions,
  frockReceipt,
]);
