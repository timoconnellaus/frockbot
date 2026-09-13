/// One search palette, sized for a desktop or the phone's keyboard.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../flock/sheep.dart';
import '../shell/semantics.dart';
import '../shell/desktop_layout.dart';
import 'controller.dart';

Future<SearchSelection?> showSearchOverlayV1(
  BuildContext context,
  NativeApi api, {
  List<SearchBot> bots = const [],
  List<SearchAction> actions = const [],
}) => showDialog<SearchSelection>(
  context: context,
  useSafeArea: false,
  barrierColor: Colors.black.withValues(alpha: 0.65),
  builder: (_) => SearchOverlay(api: api, bots: bots, actions: actions),
);

/// The shortcut belongs to the signed-in shell, including pages above it and
/// the composer while it owns text focus.
class SearchShortcutListener extends StatefulWidget {
  final VoidCallback onOpen;
  final Widget child;
  const SearchShortcutListener({
    super.key,
    required this.onOpen,
    required this.child,
  });

  @override
  State<SearchShortcutListener> createState() => _SearchShortcutListenerState();
}

class _SearchShortcutListenerState extends State<SearchShortcutListener> {
  bool _key(KeyEvent event) {
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyK) {
      return false;
    }
    final keyboard = HardwareKeyboard.instance;
    if ((!keyboard.isMetaPressed && !keyboard.isControlPressed) ||
        keyboard.isAltPressed) {
      return false;
    }
    widget.onOpen();
    return true;
  }

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_key);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_key);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class SearchOverlay extends StatefulWidget {
  final NativeApi api;
  final List<SearchBot> bots;
  final List<SearchAction> actions;
  const SearchOverlay({
    super.key,
    required this.api,
    this.bots = const [],
    this.actions = const [],
  });

  @override
  State<SearchOverlay> createState() => _SearchOverlayState();
}

class _SearchOverlayState extends State<SearchOverlay> {
  late final controller = BotSearchController(
    widget.api,
    bots: widget.bots,
    actions: widget.actions,
  );
  final editor = TextEditingController();
  late final focus = FocusNode(onKeyEvent: _key);
  final scroll = ScrollController();
  int selected = 0;
  String _selectionScope = '';
  bool get phone =>
      shellTierForWidth(MediaQuery.sizeOf(context).width) == ShellTier.single;
  bool get mac =>
      defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS;
  List<SearchEntry> entries = const [];

  @override
  void initState() {
    super.initState();
    controller.addListener(_repaint);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) focus.requestFocus();
    });
  }

  void _repaint() {
    if (!mounted) return;
    final scope =
        '${controller.category}:${controller.query}:${controller.includeArchived}:${controller.includeTools}';
    final selectedKey = entries.elementAtOrNull(selected)?.key;
    final nextEntries = controller.entries;
    setState(() {
      if (scope != _selectionScope) {
        selected = 0;
        _selectionScope = scope;
        if (scroll.hasClients) scroll.jumpTo(0);
      } else {
        final nextIndex = nextEntries.indexWhere(
          (entry) => entry.key == selectedKey,
        );
        selected = nextIndex < 0 ? 0 : nextIndex;
      }
      entries = nextEntries;
    });
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final keyboard = HardwareKeyboard.instance;
    final modifier = keyboard.isMetaPressed || keyboard.isControlPressed;
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp) {
      if (entries.isNotEmpty) {
        setState(
          () => selected =
              (selected + (key == LogicalKeyboardKey.arrowDown ? 1 : -1)) %
              entries.length,
        );
        final height = phone ? 80.0 : 64.0;
        if (scroll.hasClients) {
          final top = selected * height;
          final bottom = top + height;
          final position = scroll.position;
          final target = top < position.pixels
              ? top
              : bottom > position.pixels + position.viewportDimension
              ? bottom - position.viewportDimension
              : position.pixels;
          scroll.jumpTo(target.clamp(0, position.maxScrollExtent));
        }
      }
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      _activate(selected);
      return KeyEventResult.handled;
    }
    if (modifier && !keyboard.isAltPressed) {
      final digit = int.tryParse(key.keyLabel);
      if (digit != null && digit >= 1 && digit <= 9) {
        _activate(digit - 1);
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  void _activate(int index) {
    if (index >= 0 && index < entries.length) {
      Navigator.of(context).pop(entries[index].selection);
    }
  }

  @override
  void dispose() {
    controller.removeListener(_repaint);
    controller.dispose();
    editor.dispose();
    focus.dispose();
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    entries = controller.entries;
    selected = entries.isEmpty ? 0 : selected.clamp(0, entries.length - 1);
    final scheme = Theme.of(context).colorScheme;
    final content = identified(
      SearchIds.overlay,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(),
          if (!phone) ...[
            Divider(
              height: 1,
              color: scheme.outlineVariant.withValues(alpha: 0.35),
            ),
            _tabs(),
          ],
          SizedBox(
            height: 2,
            child: controller.busy || controller.rebuilding
                ? const LinearProgressIndicator(minHeight: 2)
                : null,
          ),
          Expanded(child: _body()),
        ],
      ),
    );
    if (phone) {
      return Dialog.fullscreen(
        child: Scaffold(
          backgroundColor: scheme.surface,
          body: SafeArea(child: content),
        ),
      );
    }
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      backgroundColor: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.55)),
      ),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: 680,
        height: math.min(570, MediaQuery.sizeOf(context).height - 48),
        child: content,
      ),
    );
  }

  Widget _header() {
    final scheme = Theme.of(context).colorScheme;
    final field = identified(
      SearchIds.field,
      TextField(
        controller: editor,
        focusNode: focus,
        autofocus: true,
        autocorrect: false,
        maxLength: searchMaxQueryLengthV1,
        textInputAction: TextInputAction.search,
        style: TextStyle(fontSize: phone ? 20 : 17),
        decoration: InputDecoration(
          counterText: '',
          hintText: 'Search',
          filled: phone,
          fillColor: scheme.surfaceContainerHighest,
          prefixIcon: Icon(
            Icons.search_rounded,
            size: phone ? 23 : 21,
            color: scheme.onSurfaceVariant,
          ),
          suffixIcon: editor.text.isEmpty
              ? null
              : IconButton(
                  tooltip: 'Clear search',
                  onPressed: () {
                    editor.clear();
                    controller.setQuery('');
                    focus.requestFocus();
                  },
                  icon: const Icon(Icons.cancel_rounded, size: 18),
                ),
          border: phone
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(28),
                  borderSide: BorderSide.none,
                )
              : InputBorder.none,
          enabledBorder: phone
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(28),
                  borderSide: BorderSide(
                    color: scheme.outlineVariant.withValues(alpha: 0.5),
                  ),
                )
              : InputBorder.none,
          focusedBorder: phone
              ? OutlineInputBorder(
                  borderRadius: BorderRadius.circular(28),
                  borderSide: BorderSide(color: scheme.outlineVariant),
                )
              : InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(vertical: 13),
          isDense: true,
        ),
        onChanged: controller.setQuery,
        onSubmitted: (_) => _activate(selected),
      ),
    );
    return Padding(
      padding: phone
          ? const EdgeInsets.fromLTRB(12, 10, 12, 14)
          : const EdgeInsets.fromLTRB(10, 10, 8, 10),
      child: Row(
        children: [
          if (phone) ...[_close(), const SizedBox(width: 8)],
          Expanded(child: field),
          if (phone) const SizedBox(width: 8),
          _menu(),
          if (!phone) _close(),
        ],
      ),
    );
  }

  Widget _close() => identified(
    SearchIds.close,
    IconButton(
      tooltip: 'Close search',
      onPressed: () => Navigator.of(context).pop(),
      style: phone
          ? IconButton.styleFrom(
              backgroundColor: Theme.of(context)
                  .colorScheme
                  .surfaceContainerHighest,
              minimumSize: const Size(44, 44),
            )
          : null,
      icon: const Icon(Icons.close_rounded),
    ),
  );

  Widget _tabs() => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    padding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
    child: Row(
      children: [
        for (final category in SearchCategory.values)
          Padding(
            padding: const EdgeInsets.only(right: 1),
            child: identified(
              SearchIds.category(category.name),
              TextButton(
                onPressed: () {
                  controller.setCategory(category);
                  focus.requestFocus();
                },
                style: TextButton.styleFrom(
                  foregroundColor: category == controller.category
                      ? Theme.of(context).colorScheme.onSurface
                      : Theme.of(context).colorScheme.onSurfaceVariant,
                  backgroundColor: category == controller.category
                      ? Theme.of(context).colorScheme.surfaceContainerHighest
                      : Colors.transparent,
                  minimumSize: const Size(0, 34),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                  textStyle: const TextStyle(fontSize: 14),
                ),
                child: Text(category.label),
              ),
            ),
          ),
      ],
    ),
  );

  Widget _menu() => identified(
    phone ? SearchIds.filter : SearchIds.options,
    PopupMenuButton<String>(
      tooltip: phone ? 'Filter search' : 'Search options',
      position: PopupMenuPosition.under,
      requestFocus: false,
      constraints: phone
          ? BoxConstraints(
              minWidth: 220,
              maxWidth: 280,
              maxHeight: math.max(
                120,
                MediaQuery.sizeOf(context).height -
                    MediaQuery.viewInsetsOf(context).bottom -
                    MediaQuery.paddingOf(context).top -
                    100,
              ),
            )
          : null,
      icon: Icon(phone ? Icons.filter_list_rounded : Icons.more_horiz_rounded),
      style: phone
          ? IconButton.styleFrom(
              backgroundColor: Theme.of(context)
                  .colorScheme
                  .surfaceContainerHighest,
              minimumSize: const Size(44, 44),
            )
          : null,
      onSelected: (value) {
        if (value == 'options') {
          unawaited(_advancedOptions());
          return;
        }
        switch (value) {
          case 'archived':
            controller.setIncludeArchived(!controller.includeArchived);
          case 'tools':
            controller.setIncludeTools(!controller.includeTools);
          case 'rebuild':
            unawaited(controller.rebuild());
          default:
            controller.setCategory(SearchCategory.values.byName(value));
        }
        focus.requestFocus();
      },
      itemBuilder: (_) => [
        if (phone) ...[
          for (final category in SearchCategory.values.where(
            (value) =>
                value != SearchCategory.links &&
                value != SearchCategory.actions,
          ))
            CheckedPopupMenuItem<String>(
              value: category.name,
              checked: controller.category == category,
              child: identified(
                SearchIds.category(category.name),
                Text(category.labelFor(phone: true)),
              ),
            ),
          const PopupMenuDivider(),
          PopupMenuItem<String>(
            value: 'options',
            child: identified(SearchIds.options, const Text('Search options…')),
          ),
        ] else ...[
          CheckedPopupMenuItem<String>(
            value: 'archived',
            checked: controller.includeArchived,
            child: identified(
              SearchIds.includeArchived,
              const Text('Archived Bots'),
            ),
          ),
          CheckedPopupMenuItem<String>(
            value: 'tools',
            checked: controller.includeTools,
            child: identified(
              SearchIds.includeTools,
              const Text('Tool output'),
            ),
          ),
          const PopupMenuDivider(),
          PopupMenuItem<String>(
            value: 'rebuild',
            enabled: !controller.rebuilding,
            child: identified(
              SearchIds.rebuild,
              const Text('Rebuild search index'),
            ),
          ),
        ],
      ],
    ),
  );

  Future<void> _advancedOptions() async {
    await showDialog<void>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (_, update) => AlertDialog(
          title: const Text('Search options'),
          contentPadding: const EdgeInsets.fromLTRB(8, 12, 8, 8),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                identified(
                  SearchIds.includeArchived,
                  CheckboxListTile(
                    title: const Text('Archived Bots'),
                    value: controller.includeArchived,
                    onChanged: (value) => update(
                      () => controller.setIncludeArchived(value == true),
                    ),
                  ),
                ),
                identified(
                  SearchIds.includeTools,
                  CheckboxListTile(
                    title: const Text('Tool output'),
                    value: controller.includeTools,
                    onChanged: (value) =>
                        update(() => controller.setIncludeTools(value == true)),
                  ),
                ),
                identified(
                  SearchIds.rebuild,
                  TextButton(
                    onPressed: controller.rebuilding
                        ? null
                        : () {
                            Navigator.of(dialog).pop();
                            unawaited(controller.rebuild());
                          },
                    child: const Text('Rebuild search index'),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialog).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
    if (mounted) focus.requestFocus();
  }

  Widget _note(String text, {VoidCallback? retry}) => identified(
    SearchIds.note,
    Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(text, style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
          if (retry != null)
            TextButton(onPressed: retry, child: const Text('Retry')),
        ],
      ),
    ),
  );

  Widget _body() {
    if (controller.category == SearchCategory.groups) {
      return _empty(
        Icons.forum_outlined,
        'Group chats aren’t available yet',
        'Your Bots are in the Bots category.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.error != null)
          _note(
            'Search couldn’t run. ${controller.error}',
            retry: () => unawaited(controller.run()),
          ),
        if (controller.wantsRoutines && controller.failedRoutineBots > 0)
          _note(
            'Couldn’t load Routines from ${controller.failedRoutineBots} ${controller.failedRoutineBots == 1 ? 'Bot' : 'Bots'}. Other results are still available.',
            retry: () => unawaited(controller.loadRoutines(retry: true)),
          ),
        if (controller.indexState == 'rebuilding')
          _note('Rebuilding search. Results may be incomplete.')
        else if (controller.indexState == 'truncated')
          _note('The oldest conversations are no longer searchable.'),
        Expanded(
          child: entries.isEmpty
              ? controller.busy
                    ? _empty(Icons.search_rounded, 'Searching…', '')
                    : controller.error != null ||
                          (controller.wantsRoutines &&
                              controller.failedRoutineBots > 0)
                    ? const SizedBox.shrink()
                    : _empty(
                        Icons.search_rounded,
                        controller.query.trim().isEmpty
                            ? 'No ${controller.category == SearchCategory.all ? 'Bots' : controller.category.label.toLowerCase()} yet'
                            : 'No results for “${controller.query.trim()}”',
                        controller.query.trim().isEmpty
                            ? ''
                            : 'Try a different word or category.',
                      )
              : ListView.builder(
                  controller: scroll,
                  padding: EdgeInsets.fromLTRB(
                    phone ? 12 : 10,
                    phone ? 4 : 0,
                    phone ? 12 : 10,
                    10,
                  ),
                  itemCount: entries.length,
                  itemExtent: phone ? 80 : 64,
                  itemBuilder: (_, index) => _row(entries[index], index),
                ),
        ),
        if (controller.truncated)
          _note(
            'More matches than this page holds. Narrow the query to see them.',
          ),
      ],
    );
  }

  Widget _empty(IconData icon, String title, String detail) => Center(
    child: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 28,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                detail,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    ),
  );

  Widget _row(SearchEntry entry, int index) {
    final scheme = Theme.of(context).colorScheme;
    final bot = entry.bot;
    final destination = entry.selection;
    final id = destination.runId != null
        ? SearchIds.hit(destination.runId!)
        : destination.routineId != null
        ? SearchIds.routine(destination.botId!, destination.routineId!)
        : destination.actionId != null
        ? SearchIds.action(destination.actionId!)
        : SearchIds.bot(destination.botId!);
    return identified(
      id,
      Semantics(
        selected: !phone && selected == index,
        child: Material(
          color: !phone && selected == index
              ? scheme.onSurface.withValues(alpha: 0.11)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            onTap: () => _activate(index),
            onHover: (hover) {
              if (hover && selected != index) setState(() => selected = index);
            },
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: phone ? 6 : 10,
                vertical: 8,
              ),
              child: Row(
                children: [
                  if (entry.category == SearchCategory.bots && bot != null)
                    SheepAvatar(
                      size: phone ? 42 : 32,
                      background: bot.background,
                    )
                  else
                    _icon(entry),
                  SizedBox(width: phone ? 14 : 12),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          entry.title.split('\n').first,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: phone ? 17 : 15,
                            fontWeight: phone
                                ? FontWeight.w500
                                : FontWeight.w400,
                          ),
                        ),
                        if (entry.subtitle.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            entry.subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: phone ? 15 : 14,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (entry.category == SearchCategory.bots &&
                      bot?.unread == true) ...[
                    const SizedBox(width: 10),
                    Semantics(
                      label: 'Unread',
                      child: Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: scheme.primary,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ],
                  if (!phone && index < 9) ...[
                    const SizedBox(width: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 5,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(4),
                        border: Border.all(
                          color: scheme.outlineVariant.withValues(alpha: 0.45),
                        ),
                        color: scheme.surface.withValues(alpha: 0.55),
                      ),
                      child: Semantics(
                        label: '${mac ? 'Command' : 'Control'} ${index + 1}',
                        excludeSemantics: true,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (mac)
                              Icon(
                                Icons.keyboard_command_key,
                                size: 12,
                                color: scheme.onSurfaceVariant,
                              ),
                            Text(
                              '${mac ? '' : 'Ctrl+'}${index + 1}',
                              style: TextStyle(
                                fontSize: 11,
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  (IconData, Color) _fileIcon(String title) {
    final name = title.split('\n').first.toLowerCase();
    if (name.endsWith('.pdf') || title.contains('application/pdf')) {
      return (Icons.picture_as_pdf_outlined, const Color(0xffff596c));
    }
    if (title.contains('image/') ||
        RegExp(r'\.(png|jpe?g|gif|webp|heic|svg)$').hasMatch(name)) {
      return (Icons.image_outlined, const Color(0xffffa64d));
    }
    return (Icons.insert_drive_file_outlined, const Color(0xff65aaff));
  }

  Widget _icon(SearchEntry entry) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (entry.category) {
      SearchCategory.routines => (
        Icons.schedule_rounded,
        const Color(0xffb88aff),
      ),
      SearchCategory.files => _fileIcon(entry.title),
      SearchCategory.links => (Icons.link_rounded, const Color(0xff70b6eb)),
      SearchCategory.actions => (
        switch (entry.selection.actionId) {
          'computer' || 'machines' => Icons.computer_outlined,
          'billing' => Icons.bar_chart_rounded,
          'plugins' => Icons.extension_outlined,
          'marketplace' => Icons.storefront_outlined,
          'routines' => Icons.schedule_rounded,
          _ => Icons.settings_outlined,
        },
        scheme.onSurfaceVariant,
      ),
      _ => (Icons.chat_bubble_outline_rounded, scheme.onSurfaceVariant),
    };
    return Container(
      width: phone ? 42 : 32,
      height: phone ? 42 : 32,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Icon(icon, size: phone ? 23 : 19, color: color),
    );
  }
}
