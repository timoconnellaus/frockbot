/// The core family: the card's state, its facts, its body, its decision, the
/// app it offers to connect, the secret it asks for, and what it settles into.
///
/// Seven components, the first family of ADR 0030's catalog. Each is a
/// `CatalogItem` whose `dataSchema` comes from `schemas.dart` — the schema is
/// never written twice — and whose widget is ordinary app code in the app's
/// theme. That is the whole of the protocol's security model on this side: a
/// Card names a component and binds values to it, and what appears on the
/// screen is code this build compiled in.
///
/// `ApprovalActions` and `ConnectApp` have rules of their own. Both are trust
/// chrome, a component only the host draws: `ApprovalActions`'s buttons are the
/// host's, the labels are the only thing a card may choose, and the action
/// names are minted here from the `approvalId` the kernel issued; `ConnectApp`
/// draws what the kernel wrote onto it from its own catalog, and its button is
/// the host's door rather than an action. A Plugin may compose either into a
/// card, and may never restyle one or say what it does. `SecretField` is
/// stricter still: only the kernel's own draw of a secret request may carry
/// it, and what is typed into it never reaches the card at all.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';

import '../../client/transport.dart';
import '../../connections/icon_tile.dart';
import '../../shell/semantics.dart';
import '../approvals.dart';
import '../connections.dart';
import '../press.dart';
import '../secrets.dart';
import 'common.dart';
import 'tone.dart';

/// A small pill naming the card's state, in the tone's colours.
final frockStatusPill = CatalogItem(
  name: 'StatusPill',
  dataSchema: frockSchemaOf('StatusPill'),
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

// Every Frock component is flexible in the flex it is in — the rule and its
// reason live in `frock_catalog.dart` — and for the pill that is what stops it
// running off the edge of the card on a phone: given a share of the row it can
// shrink, and the label ellipsizes inside it. Step 5's screenshots caught the
// other case, a pill laid out at its natural width beside a title that wanted
// the whole line, and prose in the Skill was as far as prose can get.

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
      // One line, ellipsized: a pill is a state, and a state that wrapped on
      // to a second line would be a paragraph in a pill's clothes.
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        softWrap: false,
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
  dataSchema: frockSchemaOf('KeyValueRows'),
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
                    frockString(row['label']) ?? '',
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
  dataSchema: frockSchemaOf('CollapsibleText'),
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

/// What a settled decision says, in the kernel's words for it.
String? _decidedLineV1(String decision) => switch (decision) {
  'approved' => 'You approved this.',
  'denied' => 'You denied this.',
  'expired' => 'This expired before anyone answered.',
  _ => null,
};

/// The approve and decline controls for one Approval the kernel issued.
///
/// The action names are `approval/<approvalId>`, built here from the id in the
/// component's data: the card supplies the id, the host supplies the name, and
/// the kernel refuses an id it never recorded. The decision is the kernel's own
/// word for it — `approved` or `denied`, the two answers `ApprovalUserDecisionV1`
/// records — and not the button's label.
///
/// A decision that has already been made draws no controls at all. It is read
/// from the Bot's own approvals projection rather than from the Card, because
/// an Approval settles without its surface moving — somebody answered on
/// another device, or the alarm expired it — and a live-looking button over a
/// decision that is already recorded is the one thing trust chrome may not do.
final frockApprovalActions = CatalogItem(
  name: 'ApprovalActions',
  dataSchema: frockSchemaOf('ApprovalActions'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final approvalId = frockString(data['approvalId']) ?? '';
    final name = 'approval/$approvalId';
    final pending = CardPressScope.pendingOf(itemContext.buildContext);
    final frozen = pending != null;
    final recorded = CardApprovalsScope.of(itemContext.buildContext)
        ?.approvalStateV1(approvalId);
    final decided = _decidedLineV1(recorded?.decision ?? 'pending');
    if (decided != null) {
      return Text(
        decided,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }
    bool busyWith(String decision) =>
        (pending != null &&
            pending.name == name &&
            pending.componentId == itemContext.id &&
            pending.context?['decision'] == decision) ||
        (recorded?.deciding ?? false);
    void decide(String decision) => itemContext.dispatchEvent(
      UserActionEvent(
        name: name,
        sourceComponentId: itemContext.id,
        context: {'decision': decision},
      ),
    );
    // A `Wrap`, not a `Row`: two buttons and their labels are wider than a
    // narrow card can give, and a decision the person cannot reach is worse
    // than one that took two lines.
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        identified(
          ShellIds.approve(approvalId),
          FilledButton(
            onPressed: approvalId.isEmpty || frozen
                ? null
                : () => decide('approved'),
            child: Text(
              busyWith('approved')
                  ? 'Working…'
                  : frockString(data['approveLabel']) ?? 'Approve',
            ),
          ),
        ),
        identified(
          ShellIds.deny(approvalId),
          TextButton(
            onPressed: approvalId.isEmpty || frozen
                ? null
                : () => decide('denied'),
            child: Text(
              busyWith('denied')
                  ? 'Working…'
                  : frockString(data['declineLabel']) ?? 'Decline',
            ),
          ),
        ),
      ],
    );
  },
);

/// An app the person can connect: its mark, its name, and the door.
///
/// Everything drawn here but the button is the kernel's: it looked the app up
/// in its own catalog when the card was sent and wrote the name, the
/// description and the Connection Type onto the component over whatever the
/// card said. So the button connects the app it names, and the press is the
/// person's own — it opens the app's hosted sign-in through the host, like
/// Connect in the Marketplace, and never goes to the Bot as an action.
///
/// Once the account holds a working Connection of this app the button gives
/// way to a pill saying so, read from the account rather than the Card: the
/// Card does not move when the person comes back from signing in.
final frockConnectApp = CatalogItem(
  name: 'ConnectApp',
  dataSchema: frockSchemaOf('ConnectApp'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    return FrockConnectAppView(
      app: frockString(data['app']) ?? '',
      name: frockString(data['name']),
      description: frockString(data['description']),
      packageId: frockString(data['packageId']),
      connectionTypeId: frockString(data['connectionTypeId']),
    );
  },
);

/// The component itself, so a test can draw one without a surface.
class FrockConnectAppView extends StatelessWidget {
  final String app;
  final String? name;
  final String? description;
  final String? packageId;
  final String? connectionTypeId;
  const FrockConnectAppView({
    super.key,
    required this.app,
    this.name,
    this.description,
    this.packageId,
    this.connectionTypeId,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final connections = CardConnectionsScope.of(context);
    final typeId = connectionTypeId;
    final state = typeId == null
        ? null
        : connections?.connectionStateV1(typeId);
    final title = name ?? app;
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final connected = (state?.ready ?? 0) > 0;
    // A card the kernel never bound — drawn in a preview, or by a build whose
    // backend predates the binding — names no Connection Type, and a button
    // that opened nothing would be worse than one that says it cannot.
    final canConnect =
        connections != null &&
        packageId != null &&
        typeId != null &&
        !(state?.opening ?? false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            ConnectorIconTile(asset: app, label: title),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall,
                  ),
                  if (description != null)
                    Text(
                      description!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: muted,
                    ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (connected)
          FrockStatusPillView(label: 'Connected', tone: FrockTone.success)
        else
          identified(
            ShellIds.connectApp(app),
            FilledButton(
              onPressed: canConnect
                  ? () => connections.connectV1(
                      packageId: packageId!,
                      connectionTypeId: typeId,
                    )
                  : null,
              child: Text(
                (state?.opening ?? false) ? 'Opening…' : 'Connect $title',
              ),
            ),
          ),
        if (!connected && (state?.opened ?? false))
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Finish signing in on $title’s page, then come back here.',
              style: muted,
            ),
          ),
        if (!connected && state?.failure != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              state!.failure!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ),
      ],
    );
  }
}

/// The field a person types a secret into, bound to a request the kernel
/// recorded.
///
/// Everything on it is the kernel's: the request id, whether it is a payment
/// detail, and whether it has been saved. The value is the person's and goes
/// nowhere the card can see — not an action, not the data model — only to the
/// host's save route, after which the field is emptied.
final frockSecretField = CatalogItem(
  name: 'SecretField',
  dataSchema: frockSchemaOf('SecretField'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    return FrockSecretFieldView(
      requestId: frockString(data['requestId']) ?? '',
      payment: data['payment'] == true,
      saved: data['state'] == 'saved',
    );
  },
);

/// The component itself, so a test can draw one without a surface.
class FrockSecretFieldView extends StatefulWidget {
  final String requestId;
  final bool payment;
  final bool saved;
  const FrockSecretFieldView({
    super.key,
    required this.requestId,
    this.payment = false,
    this.saved = false,
  });

  @override
  State<FrockSecretFieldView> createState() => _FrockSecretFieldViewState();
}

class _FrockSecretFieldViewState extends State<FrockSecretFieldView> {
  /// Used only where no card holds the draft — a test, a preview.
  TextEditingController? own;
  bool hidden = true;
  bool saving = false;

  /// Saved by this client before the card redrew to say so.
  bool savedHere = false;
  String? failure;

  /// The command id of the value in the field, kept only while that exact
  /// value is still there, so a save retried after a lost answer is the same
  /// save.
  String? commandId;
  String? commandValue;

  @override
  void dispose() {
    own?.dispose();
    super.dispose();
  }

  TextEditingController fieldOf(CardSecretsV1? secrets) =>
      secrets?.draftV1(widget.requestId) ?? (own ??= TextEditingController());

  Future<void> save(CardSecretsV1 secrets) async {
    final field = fieldOf(secrets);
    final value = field.text;
    if (value.trim().isEmpty || saving) return;
    if (commandValue != value) {
      commandId = randomId();
      commandValue = value;
    }
    setState(() {
      saving = true;
      failure = null;
    });
    try {
      await secrets.saveSecretV1(
        requestId: widget.requestId,
        value: value,
        commandId: commandId!,
      );
      if (!mounted) return;
      field.clear();
      commandId = null;
      commandValue = null;
      setState(() {
        saving = false;
        savedHere = true;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        saving = false;
        failure = error is RequestFailure
            ? error.message
            : 'That couldn’t be saved. Try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (widget.saved || savedHere) {
      return const FrockStatusPillView(
        label: 'Saved to your account',
        tone: FrockTone.success,
      );
    }
    final secrets = CardSecretsScope.of(context);
    final frozen = CardPressScope.pendingOf(context) != null;
    final canSave =
        secrets != null && widget.requestId.isNotEmpty && !saving && !frozen;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        identified(
          ShellIds.secretField(widget.requestId),
          TextField(
            controller: fieldOf(secrets),
            enabled: canSave,
            obscureText: hidden,
            // Nothing that learns, suggests or remembers what is typed here.
            autocorrect: false,
            enableSuggestions: false,
            enableIMEPersonalizedLearning: false,
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            keyboardType: widget.payment
                ? TextInputType.number
                : TextInputType.visiblePassword,
            onSubmitted: canSave ? (_) => save(secrets) : null,
            decoration: InputDecoration(
              labelText: widget.payment
                  ? 'Card or account details'
                  : 'Type it here',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                tooltip: hidden ? 'Show' : 'Hide',
                onPressed: () => setState(() => hidden = !hidden),
                icon: Icon(
                  hidden
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: identified(
            ShellIds.secretSave(widget.requestId),
            FilledButton(
              onPressed: canSave ? () => save(secrets) : null,
              child: Text(saving ? 'Saving…' : 'Save'),
            ),
          ),
        ),
        if (secrets == null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Secrets can’t be saved here.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        if (failure != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              liveRegion: true,
              child: Text(
                failure!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The settled state: a title, the pill, and one line saying what happened.
final frockReceipt = CatalogItem(
  name: 'Receipt',
  dataSchema: frockSchemaOf('Receipt'),
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
            // The pill gives way before the card's edge does, for the reason
            // `StatusPill` is implicitly flexible: whatever the model writes
            // on it, it stays inside the card.
            Flexible(
              child: BoundString(
                dataContext: itemContext.dataContext,
                value: data['status'],
                builder: (context, status) =>
                    FrockStatusPillView(label: status ?? '', tone: tone),
              ),
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
final List<CatalogItem> frockCoreItemsV1 = List.unmodifiable([
  frockStatusPill,
  frockKeyValueRows,
  frockCollapsibleText,
  frockApprovalActions,
  frockConnectApp,
  frockSecretField,
  frockReceipt,
]);
