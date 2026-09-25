/// Activity: what a person's Bots did outside the conversation.
///
/// The conversation shows what was said and hides how a Bot got there, so this
/// is where the rest is seen — mail sent, services called, commands run, a
/// microphone used. Each row is one Turn's effects in one place, in a sentence
/// the server wrote (`app/audit/activity.ts`); this host draws it, puts it
/// under the local day it happened on, and opens that Turn's work when tapped.
///
/// It renders durable state and infers nothing. An outcome the log does not
/// know is said on the row, never quietly dropped.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../flock/avatar.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/chat_pane.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../theme/controls.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/time.dart';
import 'activity.dart';

/// The page's read: the first page for a Bot and a filter, and each earlier
/// page appended under it.
class AuditController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore? store;
  final String? userId;

  /// The Bot whose activity is read. Absent reads every Bot this account has.
  String? botId;

  /// One of [activityFilters]' slugs.
  String filter = 'everything';

  List<wire.ActivityRow> rows = const [];
  String? nextCursor;
  String indexState = 'ready';

  /// Whether [rows] answers the query in force; false until the first read
  /// lands, and while a read for a different query is out.
  bool loaded = false;
  bool loading = false;
  bool loadingMore = false;
  String? error;
  String? moreError;

  bool _closed = false;
  int _request = 0;

  AuditController(this.api, {this.store, this.userId, this.botId});

  /// Only the default view is kept: it is the one a person opens.
  String? get _cacheKey =>
      userId == null || botId != null || filter != 'everything'
      ? null
      : 'activity-page.$userId';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  /// Paints the last default page this device read, before the network
  /// answers. A shape this build cannot read is thrown away.
  Future<void> restore() async {
    final key = _cacheKey;
    final local = store;
    if (key == null || local == null) return;
    try {
      final text = await local.read(key);
      // The live read, or a change of filter, got there first.
      if (text == null || loaded || _cacheKey != key) return;
      _adopt(wire.ActivityPage.fromJson(jsonDecode(text)));
      _changed();
    } catch (_) {
      await local.delete(key);
    }
  }

  void _adopt(wire.ActivityPage page, {bool append = false}) {
    rows = [if (append) ...rows, ...page.rows];
    nextCursor = page.nextCursor;
    indexState = page.indexState;
    loaded = true;
  }

  /// A new query. The rows on screen stay until the answer replaces them, so
  /// a change of filter does not blank the page; if the read fails they go,
  /// because they answer a question nobody is asking any more.
  Future<void> choose({String? botId, String? filter}) async {
    this.botId = botId;
    if (filter != null) this.filter = filter;
    _stale = true;
    await load();
  }

  bool _stale = false;

  /// Reads the newest page for the query in force.
  Future<void> load() async {
    final request = ++_request;
    loading = true;
    error = null;
    moreError = null;
    _changed();
    try {
      final answer = await api.request(
        activityPathV1(botId: botId, filter: filter),
      );
      final page = wire.ActivityPage.fromJson(answer);
      if (request != _request) return;
      _adopt(page);
      _stale = false;
      final key = _cacheKey;
      final local = store;
      if (key != null && local != null) {
        unawaited(local.write(key, jsonEncode(answer)));
      }
    } catch (_) {
      if (request != _request) return;
      error = 'Couldn’t load activity. Check your connection and try again.';
      if (_stale) {
        rows = const [];
        nextCursor = null;
        loaded = false;
        _stale = false;
      }
    } finally {
      if (request == _request) {
        loading = false;
        _changed();
      }
    }
  }

  /// Reads the page before the last one shown, from the cursor it carried.
  Future<void> more() async {
    final cursor = nextCursor;
    if (cursor == null || loadingMore || loading) return;
    final request = _request;
    loadingMore = true;
    moreError = null;
    _changed();
    try {
      final page = wire.ActivityPage.fromJson(
        await api.request(
          activityPathV1(botId: botId, filter: filter, before: cursor),
        ),
      );
      if (request != _request) return;
      _adopt(page, append: true);
    } catch (_) {
      if (request != _request) return;
      moreError = 'Couldn’t load earlier activity.';
    } finally {
      loadingMore = false;
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// Activity as a page, pushed from the You page.
class AuditPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;

  /// The Bot the page opens on. Absent opens on every Bot.
  final String? botId;
  final String? botName;

  /// A Bot's name as the rest of the app says it now; the directory's is the
  /// name it was created with.
  final String Function(wire.BotRegistration bot)? nameOf;

  /// When the page opened, for tests; otherwise the clock at each build.
  final DateTime Function()? now;
  const AuditPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.botId,
    this.botName,
    this.nameOf,
    this.now,
  });

  @override
  State<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends State<AuditPage> {
  late AuditController controller;
  late Future<wire.BotDirectory> directory;

  AuditController _create() {
    final next = AuditController(
      widget.api,
      store: widget.store,
      userId: widget.userId,
      botId: widget.botId,
    );
    unawaited(next.restore());
    unawaited(next.load());
    return next;
  }

  @override
  void initState() {
    super.initState();
    controller = _create();
    directory = widget.api
        .request('/api/bots')
        .then(wire.BotDirectory.fromJson);
  }

  @override
  void didUpdateWidget(AuditPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api && oldWidget.botId == widget.botId) return;
    final previous = controller;
    controller = _create();
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  /// The Turn behind a row, on the same Work view a message in the thread
  /// opens. A Turn the Bot no longer holds says so rather than opening an
  /// empty surface.
  Future<void> _openRun(wire.ActivityRow row) async {
    final runId = row.runId;
    if (runId == null) return;
    try {
      final run = await BackendChatTransport(widget.api)
          .lookup(row.botId.value, runId);
      if (!mounted) return;
      if (run == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('That Turn is no longer on this Bot.')),
        );
        return;
      }
      final line = projectRuns([run]).lastOrNull;
      if (line == null) return;
      await Navigator.of(context)
          .push(MaterialPageRoute<void>(builder: (_) => RunPage(line: line)));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Couldn’t open that Turn. Try again.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(
      child: AppBar(
        title: const Text('Activity'),
        actions: [
          ListenableBuilder(
            listenable: controller,
            builder: (context, _) => identified(
              AuditIds.refresh,
              IconButton(
                tooltip: 'Refresh activity',
                onPressed: controller.loading ? null : controller.load,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ),
          ),
        ],
      ),
    ),
    body: SafeArea(
      top: false,
      child: FutureBuilder<wire.BotDirectory>(
        future: directory,
        builder: (context, result) => ListenableBuilder(
          listenable: controller,
          builder: (context, _) => _body(
            context,
            result.data?.bots ?? const <wire.BotRegistration>[],
          ),
        ),
      ),
    ),
  );

  Widget _body(BuildContext context, List<wire.BotRegistration> bots) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final byId = {for (final bot in bots) bot.botId.value: bot};
    final now = widget.now?.call() ?? DateTime.now();
    final filtered =
        controller.botId != null || controller.filter != 'everything';
    final Widget content;
    if (!controller.loaded && controller.error != null) {
      content = _Notice(
        icon: Icons.cloud_off_rounded,
        title: 'Activity couldn’t load',
        detail: controller.error!,
        action: 'Try again',
        onAction: controller.load,
      );
    } else if (!controller.loaded) {
      content = const _Skeleton();
    } else if (controller.rows.isEmpty) {
      content = _Notice(
        icon: Icons.history_rounded,
        title: filtered ? 'Nothing here yet' : 'Nothing yet',
        detail: filtered
            ? 'Nothing matches this filter. Try All Bots or Everything.'
            : 'When a Bot sends, changes or runs something, it shows up here.',
      );
    } else {
      content = identified(
        AuditIds.list,
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final day in activityDays(controller.rows, now)) ...[
              _DayLabel(day.label),
              FrockRowGroup(
                indent: 58,
                rows: [
                  for (final row in day.rows)
                    _ActivityRowView(
                      row: row,
                      bot: byId[row.botId.value],
                      name: switch (byId[row.botId.value]) {
                        final bot? => widget.nameOf?.call(bot) ?? row.botName,
                        null => row.botName,
                      },
                      onTap: row.runId == null ? null : () => _openRun(row),
                    ),
                ],
              ),
              const SizedBox(height: 18),
            ],
            if (controller.nextCursor != null)
              Center(
                child: controller.loadingMore
                    ? const Padding(
                        padding: EdgeInsets.all(8),
                        child: SizedBox.square(
                          dimension: 22,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : identified(
                        AuditIds.showEarlier,
                        OutlinedButton(
                          style: frockCompactButton(context).copyWith(
                            minimumSize: const WidgetStatePropertyAll(
                              Size(0, 38),
                            ),
                          ),
                          onPressed: controller.more,
                          child: const Text('Show earlier'),
                        ),
                      ),
              ),
            if (controller.moreError case final String message) ...[
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            if (controller.nextCursor == null &&
                controller.indexState == 'truncated')
              _Footnote('Older activity is no longer kept.'),
          ],
        ),
      );
    }
    return Stack(
      fit: StackFit.expand,
      children: [
        RefreshIndicator(
          onRefresh: controller.load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
            children: [
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(
                          'What your Bots did outside the conversation: email '
                          'they sent, services they changed, commands they '
                          'ran, devices they used.',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: muted,
                            height: 1.45,
                          ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          _BotPicker(
                            bots: bots,
                            selected: controller.botId,
                            nameOf: (bot) =>
                                widget.nameOf?.call(bot) ??
                                (bot.currentProfile?.name ?? bot.initialName),
                            fallbackName: widget.botName,
                            onChosen: (botId) =>
                                controller.choose(botId: botId),
                          ),
                          identified(
                            AuditIds.filter,
                            FrockSegmented(
                              label: 'Show',
                              selected: controller.filter,
                              options: activityFilters,
                              onChosen: (slug) => controller.choose(
                                botId: controller.botId,
                                filter: slug,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (controller.loaded && controller.error != null) ...[
                        const SizedBox(height: 14),
                        Text(
                          controller.error!,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.error,
                          ),
                        ),
                      ],
                      if (controller.indexState == 'rebuilding') ...[
                        const SizedBox(height: 14),
                        _Footnote(
                          'Activity is being brought up to date. Some rows may '
                          'be missing for a moment.',
                          align: TextAlign.start,
                        ),
                      ],
                      const SizedBox(height: 22),
                      content,
                      if (controller.loaded && controller.rows.isNotEmpty)
                        _Footnote(
                          'Each row opens that Turn’s work. Commands are kept '
                          'only as a short preview, with anything that looks '
                          'like a secret removed.',
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        // Over the top edge, not in the list: a refresh comes and goes, and
        // the rows under it must not jump each time.
        if (controller.loading && controller.loaded)
          const Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: LinearProgressIndicator(minHeight: 2),
          ),
      ],
    );
  }
}

class _DayLabel extends StatelessWidget {
  final String text;
  const _DayLabel(this.text);

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
          fontSize: 12.5,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    ),
  );
}

class _Footnote extends StatelessWidget {
  final String text;
  final TextAlign align;
  const _Footnote(this.text, {this.align = TextAlign.center});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 14, 8, 0),
    child: Text(
      text,
      textAlign: align,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        fontSize: 12.5,
        color: Theme.of(context).colorScheme.onSurfaceVariant
            .withValues(alpha: 0.8),
      ),
    ),
  );
}

/// One Turn's effects in one place: who, what, where, and when.
class _ActivityRowView extends StatelessWidget {
  final wire.ActivityRow row;
  final wire.BotRegistration? bot;
  final String name;
  final VoidCallback? onTap;
  const _ActivityRowView({
    required this.row,
    required this.bot,
    required this.name,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final dark = theme.brightness == Brightness.dark;
    final quiet = row.quiet == true;
    final at = DateTime.parse(row.at.value).toLocal();
    final base = theme.textTheme.bodyMedium?.copyWith(
      fontSize: 14,
      height: 1.35,
      color: quiet ? scheme.onSurfaceVariant : scheme.onSurface,
    );
    final approved = row.approved == true;
    return Semantics(
      button: onTap != null,
      label:
          '$name ${row.text}. ${row.place}.'
          '${approved ? ' You approved.' : ''}'
          '${row.note == null ? '' : ' ${row.note}.'}'
          ' ${clockLabel(at)}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Opacity(
                opacity: quiet ? 0.7 : 1,
                child: CharacterAvatar(
                  size: 32,
                  botId: row.botId.value,
                  characterId: bot?.avatar.characterId,
                  primary: bot?.avatar.primary,
                  motion: CharacterMotion.quiet,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: name,
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          TextSpan(text: ' ${row.text}'),
                        ],
                      ),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: base,
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        _Tag(row.place),
                        if (approved)
                          _Mark(
                            icon: Icons.check_rounded,
                            text: 'You approved',
                            color: dark
                                ? FrockTheme.success
                                : FrockTheme.successInk,
                          ),
                        if (row.note case final String note)
                          _Mark(
                            icon: Icons.error_outline_rounded,
                            text: note,
                            color: dark
                                ? FrockTheme.warning
                                : FrockTheme.warningInk,
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Text(
                  clockLabel(at),
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontSize: 12.5,
                    color: scheme.onSurfaceVariant,
                    fontFeatures: FrockTheme.tabularFigures,
                  ),
                ),
              ),
              SizedBox(
                width: 24,
                child: onTap == null
                    ? null
                    : Icon(
                        Icons.chevron_right_rounded,
                        size: 18,
                        color: scheme.onSurfaceVariant.withValues(alpha: 0.55),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where it happened: a service, a Computer, a device.
class _Tag extends StatelessWidget {
  final String text;
  const _Tag(this.text);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.05),
        border: Border.all(color: FrockTheme.hairline(scheme)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: theme.textTheme.labelSmall?.copyWith(
          fontSize: 11.5,
          letterSpacing: 0,
          color: scheme.onSurface.withValues(alpha: 0.78),
        ),
      ),
    );
  }
}

class _Mark extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color color;
  const _Mark({required this.icon, required this.text, required this.color});

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 13, color: color),
      const SizedBox(width: 3),
      Text(
        text,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(fontSize: 11.5, letterSpacing: 0, color: color),
      ),
    ],
  );
}

/// "All Bots" or one Bot, as a compact control beside the filters.
class _BotPicker extends StatelessWidget {
  final List<wire.BotRegistration> bots;
  final String? selected;
  final String Function(wire.BotRegistration bot) nameOf;
  final String? fallbackName;
  final ValueChanged<String?> onChosen;
  const _BotPicker({
    required this.bots,
    required this.selected,
    required this.nameOf,
    required this.fallbackName,
    required this.onChosen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    wire.BotRegistration? chosen;
    for (final bot in bots) {
      if (bot.botId.value == selected) chosen = bot;
    }
    final label = selected == null
        ? 'All Bots'
        : chosen == null
        ? (fallbackName ?? 'One Bot')
        : nameOf(chosen);
    return identified(
      AuditIds.botFilter,
      PopupMenuButton<String>(
        tooltip: 'Show activity for',
        position: PopupMenuPosition.under,
        onSelected: (value) => onChosen(value.isEmpty ? null : value),
        itemBuilder: (_) => [
          CheckedPopupMenuItem<String>(
            value: '',
            checked: selected == null,
            child: const Text('All Bots'),
          ),
          for (final bot in bots)
            CheckedPopupMenuItem<String>(
              value: bot.botId.value,
              checked: bot.botId.value == selected,
              child: Row(
                children: [
                  CharacterAvatar(
                    size: 22,
                    botId: bot.botId.value,
                    characterId: bot.avatar.characterId,
                    primary: bot.avatar.primary,
                    motion: CharacterMotion.quiet,
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(nameOf(bot), overflow: TextOverflow.ellipsis),
                  ),
                ],
              ),
            ),
        ],
        child: Semantics(
          button: true,
          label: 'Show activity for: $label',
          excludeSemantics: true,
          child: Container(
            height: 34,
            padding: const EdgeInsets.only(left: 10, right: 6),
            decoration: BoxDecoration(
              color: scheme.onSurface.withValues(alpha: 0.05),
              border: Border.all(color: FrockTheme.hairline(scheme)),
              borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (chosen != null) ...[
                  CharacterAvatar(
                    size: 20,
                    botId: chosen.botId.value,
                    characterId: chosen.avatar.characterId,
                    primary: chosen.avatar.primary,
                    motion: CharacterMotion.quiet,
                  ),
                  const SizedBox(width: 8),
                ],
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 160),
                  child: Text(
                    label,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontSize: 13,
                      color: scheme.onSurface,
                    ),
                  ),
                ),
                const SizedBox(width: 2),
                Icon(
                  Icons.expand_more_rounded,
                  size: 18,
                  color: scheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A designed state in the place the rows would be: empty, or unreadable.
class _Notice extends StatelessWidget {
  final IconData icon;
  final String title;
  final String detail;
  final String? action;
  final VoidCallback? onAction;
  const _Notice({
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 28),
        child: Column(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: scheme.onSurface.withValues(alpha: 0.05),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 22, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Text(
                detail,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                  height: 1.45,
                ),
              ),
            ),
            if (action case final String label) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onAction, child: Text(label)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Rows the shape of the ones on their way.
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Loading activity',
    liveRegion: true,
    child: ExcludeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 2, 4, 10),
            child: FrockSkeleton(width: 56, height: 12),
          ),
          FrockRowGroup(
            indent: 58,
            rows: [
              for (final width in const [0.72, 0.55, 0.64, 0.48])
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 14, 16, 14),
                  child: Row(
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.onSurface
                              .withValues(alpha: 0.06),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: LayoutBuilder(
                          builder: (context, box) => Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              FrockSkeleton(
                                width: box.maxWidth * width,
                                height: 13,
                              ),
                              const SizedBox(height: 8),
                              const FrockSkeleton(width: 64, height: 12),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}
