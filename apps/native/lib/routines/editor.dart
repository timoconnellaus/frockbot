import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../view/document.dart';
import '../view/embed.dart';
import '../view/nodes.dart';

const _editorId = 'routine.editorId';
const _name = 'routine.name';
const _prompt = 'routine.prompt';
const _schedule = 'routine.schedule';
const _scheduleDescription = 'routine.scheduleDescription';
const _timezone = 'routine.timezone';
const _keyVersion = 'routine.keyVersion';

class RoutinePluginTriggerV1 {
  final String name;
  final String description;
  const RoutinePluginTriggerV1(this.name, this.description);

  String get displayName => name
      .split(RegExp(r'[-_]'))
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}

class RoutinePluginSourceV1 {
  final String pluginId;
  final String displayName;
  final List<RoutinePluginTriggerV1> triggers;
  const RoutinePluginSourceV1({
    required this.pluginId,
    required this.displayName,
    required this.triggers,
  });
}

/// Trigger-capable Plugins that are installed, available, and on for this Bot.
List<RoutinePluginSourceV1> routinePluginSourcesV1(Object? value) {
  if (value is! Map || value['plugins'] is! List) return const [];
  final sources = <RoutinePluginSourceV1>[];
  for (final raw in value['plugins'] as List) {
    if (raw is! Map || raw['on'] != true) continue;
    if (raw['unavailable'] != null || raw['quarantined'] != null) continue;
    final pluginId = raw['pluginId'];
    final displayName = raw['displayName'];
    final declared = raw['triggers'];
    if (pluginId is! String ||
        displayName is! String ||
        declared is! List ||
        declared.isEmpty) {
      continue;
    }
    final triggers = <RoutinePluginTriggerV1>[];
    for (final trigger in declared) {
      if (trigger is! Map ||
          trigger['name'] is! String ||
          trigger['description'] is! String) {
        continue;
      }
      triggers.add(
        RoutinePluginTriggerV1(
          trigger['name'] as String,
          trigger['description'] as String,
        ),
      );
    }
    if (triggers.isNotEmpty) {
      sources.add(
        RoutinePluginSourceV1(
          pluginId: pluginId,
          displayName: displayName,
          triggers: triggers,
        ),
      );
    }
  }
  return sources;
}

Map<String, ViewFieldBuilder> routineEditorFieldBuildersV1(
  List<RoutinePluginSourceV1> Function() plugins, {
  required bool Function() pluginsPending,
}) => {
  'routine-editor-hidden': (_, _, _, _, _) => const SizedBox.shrink(),
  'routine-editor': (context, field, id, value, onChanged) {
    final scope = ViewScope.of(context);
    return identified(
      RoutineIds.editor,
      RoutineEditorV1(
        key: ValueKey('routine-editor.${scope.controller.revision}'),
        plugins: plugins(),
        pluginsPending: pluginsPending(),
        source: value as String? ?? 'schedule',
        routineId: scope.controller.values[_editorId] as String?,
        name: scope.controller.values[_name] as String? ?? '',
        prompt: scope.controller.values[_prompt] as String? ?? '',
        schedule: scope.controller.values[_schedule] as String? ?? '0 9 * * *',
        scheduleDescription:
            scope.controller.values[_scheduleDescription] as String? ??
            'Every day at 9:00am',
        timezone: scope.controller.values[_timezone] as String?,
        hookKeyVersion: int.tryParse(
          scope.controller.values[_keyVersion] as String? ?? '',
        ),
        enabled: onChanged != null,
        onSourceChanged: onChanged,
      ),
    );
  },
};

enum _RoutineSourceKind { schedule, webhook, plugin }

enum _RoutineCadence { daily, weekdays, weekly, monthly, interval, custom }

class _FriendlySchedule {
  _RoutineCadence cadence;
  TimeOfDay time;
  int weekday;
  int monthDay;
  int interval;
  String intervalUnit;
  String original;
  String originalDescription;

  _FriendlySchedule({
    required this.cadence,
    required this.time,
    this.weekday = DateTime.monday,
    this.monthDay = 1,
    this.interval = 15,
    this.intervalUnit = 'minutes',
    required this.original,
    required this.originalDescription,
  });

  factory _FriendlySchedule.parse(String raw, String description) {
    final value = raw.trim().toLowerCase();
    final interval = RegExp(r'^@every\s+(\d+)([mh])$').firstMatch(value);
    if (interval != null) {
      return _FriendlySchedule(
        cadence: _RoutineCadence.interval,
        time: const TimeOfDay(hour: 9, minute: 0),
        interval: int.parse(interval.group(1)!),
        intervalUnit: interval.group(2) == 'h' ? 'hours' : 'minutes',
        original: raw,
        originalDescription: description,
      );
    }
    final alias = switch (value) {
      '@daily' || '@midnight' => '0 0 * * *',
      '@hourly' => '@every 1h',
      '@weekly' => '0 0 * * 0',
      '@monthly' => '0 0 1 * *',
      _ => value,
    };
    final aliasInterval = RegExp(r'^@every\s+(\d+)([mh])$').firstMatch(alias);
    if (aliasInterval != null) {
      return _FriendlySchedule(
        cadence: _RoutineCadence.interval,
        time: const TimeOfDay(hour: 9, minute: 0),
        interval: int.parse(aliasInterval.group(1)!),
        intervalUnit: aliasInterval.group(2) == 'h' ? 'hours' : 'minutes',
        original: raw,
        originalDescription: description,
      );
    }
    final fields = alias.split(RegExp(r'\s+'));
    if (fields.length == 5) {
      final minute = int.tryParse(fields[0]);
      final hour = int.tryParse(fields[1]);
      if (minute != null && hour != null && minute < 60 && hour < 24) {
        final time = TimeOfDay(hour: hour, minute: minute);
        if (fields[2] == '*' && fields[3] == '*' && fields[4] == '*') {
          return _FriendlySchedule(
            cadence: _RoutineCadence.daily,
            time: time,
            original: raw,
            originalDescription: description,
          );
        }
        if (fields[2] == '*' && fields[3] == '*' && fields[4] == '1-5') {
          return _FriendlySchedule(
            cadence: _RoutineCadence.weekdays,
            time: time,
            original: raw,
            originalDescription: description,
          );
        }
        final weekday = int.tryParse(fields[4]);
        if (fields[2] == '*' &&
            fields[3] == '*' &&
            weekday != null &&
            weekday >= 0 &&
            weekday <= 6) {
          return _FriendlySchedule(
            cadence: _RoutineCadence.weekly,
            time: time,
            weekday: weekday == 0 ? DateTime.sunday : weekday,
            original: raw,
            originalDescription: description,
          );
        }
        final day = int.tryParse(fields[2]);
        if (day != null &&
            day >= 1 &&
            day <= 28 &&
            fields[3] == '*' &&
            fields[4] == '*') {
          return _FriendlySchedule(
            cadence: _RoutineCadence.monthly,
            time: time,
            monthDay: day,
            original: raw,
            originalDescription: description,
          );
        }
      }
    }
    return _FriendlySchedule(
      cadence: _RoutineCadence.custom,
      time: const TimeOfDay(hour: 9, minute: 0),
      original: raw,
      originalDescription: description,
    );
  }

  String get value => switch (cadence) {
    _RoutineCadence.daily => '${time.minute} ${time.hour} * * *',
    _RoutineCadence.weekdays => '${time.minute} ${time.hour} * * 1-5',
    _RoutineCadence.weekly =>
      '${time.minute} ${time.hour} * * ${weekday == DateTime.sunday ? 0 : weekday}',
    _RoutineCadence.monthly => '${time.minute} ${time.hour} $monthDay * *',
    _RoutineCadence.interval =>
      '@every $interval${intervalUnit == 'hours' ? 'h' : 'm'}',
    _RoutineCadence.custom => original,
  };

  String summary(MaterialLocalizations localizations) {
    if (cadence == _RoutineCadence.custom) return originalDescription;
    if (cadence == _RoutineCadence.interval) {
      final unit = intervalUnit == 'hours' ? 'hour' : 'minute';
      return 'Every $interval $unit${interval == 1 ? '' : 's'}';
    }
    final at = localizations.formatTimeOfDay(time);
    return switch (cadence) {
      _RoutineCadence.daily => 'Every day at $at',
      _RoutineCadence.weekdays => 'Every weekday at $at',
      _RoutineCadence.weekly => 'Every ${_weekdayNames[weekday - 1]} at $at',
      _RoutineCadence.monthly => 'On day $monthDay of every month at $at',
      _ => originalDescription,
    };
  }
}

const _weekdayNames = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

class RoutineEditorV1 extends StatefulWidget {
  final List<RoutinePluginSourceV1> plugins;

  /// Whether the read that answers for [plugins] is still out. A list that is
  /// empty because nobody has read it yet is not a list of no Plugins, and a
  /// stored trigger the editor cannot see yet is not a trigger that is gone.
  final bool pluginsPending;
  final String source;
  final String? routineId;
  final String name;
  final String prompt;
  final String schedule;
  final String scheduleDescription;
  final String? timezone;
  final int? hookKeyVersion;
  final bool enabled;
  final void Function(Object? value)? onSourceChanged;

  const RoutineEditorV1({
    super.key,
    required this.plugins,
    required this.pluginsPending,
    required this.source,
    required this.routineId,
    required this.name,
    required this.prompt,
    required this.schedule,
    required this.scheduleDescription,
    required this.timezone,
    required this.hookKeyVersion,
    required this.enabled,
    required this.onSourceChanged,
  });

  @override
  State<RoutineEditorV1> createState() => _RoutineEditorV1State();
}

class _RoutineEditorV1State extends State<RoutineEditorV1> {
  late final _RoutineSourceKind storedSourceKind;
  late _RoutineSourceKind sourceKind;
  String? pluginId;
  String? trigger;
  late _FriendlySchedule schedule;

  static _RoutineSourceKind _sourceKindOf(String source) {
    if (source == 'webhook') return _RoutineSourceKind.webhook;
    if (source.startsWith('plugin:')) return _RoutineSourceKind.plugin;
    return _RoutineSourceKind.schedule;
  }

  @override
  void initState() {
    super.initState();
    schedule = _FriendlySchedule.parse(
      widget.schedule,
      widget.scheduleDescription,
    );
    storedSourceKind = _sourceKindOf(widget.source);
    sourceKind = storedSourceKind;
    if (storedSourceKind == _RoutineSourceKind.plugin) {
      final parts = widget.source.split(':');
      if (parts.length == 3) {
        pluginId = parts[1];
        trigger = parts[2];
      }
    }
  }

  RoutinePluginSourceV1? get selectedPlugin =>
      widget.plugins.where((plugin) => plugin.pluginId == pluginId).firstOrNull;

  void chooseSource(_RoutineSourceKind kind, [String? nextPlugin]) {
    if (!widget.enabled) return;
    setState(() {
      sourceKind = kind;
      pluginId = nextPlugin;
      trigger = null;
    });
    if (kind == _RoutineSourceKind.schedule) {
      widget.onSourceChanged?.call('schedule');
    } else if (kind == _RoutineSourceKind.webhook) {
      widget.onSourceChanged?.call('webhook');
    }
  }

  void chooseTrigger(String name) {
    if (!widget.enabled || pluginId == null) return;
    setState(() => trigger = name);
    widget.onSourceChanged?.call('plugin:$pluginId:$name');
  }

  void scheduleChanged() {
    final scope = ViewScope.of(context);
    scope.controller.change(_schedule, schedule.value);
    scope.controller.change(
      _scheduleDescription,
      schedule.summary(MaterialLocalizations.of(context)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('What should this Bot do?', style: theme.textTheme.titleLarge),
        const SizedBox(height: 14),
        _actionFields(context),
        const SizedBox(height: 22),
        Text('When does it fire?', style: theme.textTheme.titleLarge),
        const SizedBox(height: 4),
        Text(
          'A time, a webhook, or a Plugin with triggers.',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        _sourceChoices(context),
        const SizedBox(height: 16),
        _configureStep(context),
        const SizedBox(height: 18),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          runSpacing: 8,
          children: [
            _routineAction('cancel-edit', 'Cancel'),
            widget.enabled && _canSave
                ? _routineAction(
                    'save-routine',
                    widget.routineId == null
                        ? 'Create Routine'
                        : 'Save changes',
                    style: 'primary',
                  )
                : FilledButton(
                    onPressed: null,
                    child: Text(
                      widget.routineId == null
                          ? 'Create Routine'
                          : 'Save changes',
                    ),
                  ),
          ],
        ),
        if (widget.routineId != null) ...[
          const SizedBox(height: 16),
          _editActions(),
        ],
      ],
    );
  }

  /// A Plugin source is not ready to save until a trigger is named. A stored
  /// trigger the catalog has not shown yet still counts — that is the one the
  /// Routine already has.
  bool get _canSave =>
      sourceKind != _RoutineSourceKind.plugin ||
      trigger != null ||
      (widget.source.startsWith('plugin:') &&
          widget.source.split(':').length == 3);

  Widget _sourceChoices(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _sourceChoice(
          context,
          identifier: RoutineIds.sourceSchedule,
          width: constraints.maxWidth,
          icon: Icons.schedule_rounded,
          title: 'Schedule',
          detail: 'At a time you choose',
          selected: sourceKind == _RoutineSourceKind.schedule,
          onTap: () => chooseSource(_RoutineSourceKind.schedule),
        ),
        _sourceChoice(
          context,
          identifier: RoutineIds.sourceWebhook,
          width: constraints.maxWidth,
          icon: Icons.webhook_rounded,
          title: 'Webhook',
          detail: 'When another service calls it',
          selected: sourceKind == _RoutineSourceKind.webhook,
          onTap: () => chooseSource(_RoutineSourceKind.webhook),
        ),
        for (final plugin in widget.plugins)
          _sourceChoice(
            context,
            identifier: RoutineIds.sourcePlugin(plugin.pluginId),
            width: constraints.maxWidth,
            icon: Icons.extension_rounded,
            title: plugin.displayName,
            detail:
                '${plugin.triggers.length} ${plugin.triggers.length == 1 ? 'trigger' : 'triggers'}',
            selected:
                sourceKind == _RoutineSourceKind.plugin &&
                pluginId == plugin.pluginId,
            onTap: () =>
                chooseSource(_RoutineSourceKind.plugin, plugin.pluginId),
          ),
        if (sourceKind == _RoutineSourceKind.plugin && selectedPlugin == null)
          _sourceChoice(
            context,
            identifier: RoutineIds.sourcePlugin(pluginId ?? 'unavailable'),
            width: constraints.maxWidth,
            icon: widget.pluginsPending
                ? Icons.extension_rounded
                : Icons.extension_off_rounded,
            title: 'Current Plugin',
            detail: widget.pluginsPending
                ? 'Checking availability…'
                : 'Unavailable for this Bot',
            selected: true,
            onTap: () {},
          ),
        if (widget.pluginsPending && widget.plugins.isEmpty)
          _sourceChoice(
            context,
            identifier: RoutineIds.sourcePluginsPending,
            width: constraints.maxWidth,
            icon: Icons.extension_rounded,
            title: 'Plugins',
            detail: 'Checking this Bot’s Plugins…',
            selected: false,
            onTap: () {},
          ),
      ],
    ),
  );

  Widget _sourceChoice(
    BuildContext context, {
    required String identifier,
    required double width,
    required IconData icon,
    required String title,
    required String detail,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return identified(
      identifier,
      SizedBox(
        width: width >= 430 ? (width - 8) / 2 : width,
        child: Material(
          color: selected
              ? Theme.of(context).brightness == Brightness.dark
                    ? FrockTheme.blushDark
                    : FrockTheme.blush
              : scheme.surfaceContainerHighest,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(13),
            side: BorderSide(
              color: selected ? scheme.primary : scheme.outlineVariant,
            ),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(13),
            onTap: widget.enabled ? onTap : null,
            child: Padding(
              padding: const EdgeInsets.all(13),
              child: Row(
                children: [
                  Icon(icon, size: 21),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _configureStep(BuildContext context) => switch (sourceKind) {
    _RoutineSourceKind.schedule => _scheduleEditor(context),
    _RoutineSourceKind.webhook => _webhookEditor(context),
    _RoutineSourceKind.plugin => _pluginEditor(context),
  };

  Widget _webhookEditor(BuildContext context) => const _InfoBox(
    icon: Icons.webhook_rounded,
    title: 'Ready for incoming webhooks',
    detail: 'After you create this Routine, FrockBot will show its URL and secret once. Copy them into the service that will call it.',
  );

  Widget _pluginEditor(BuildContext context) {
    final plugin = selectedPlugin;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (plugin == null)
          widget.pluginsPending
              ? const _InfoBox(
                  icon: Icons.extension_rounded,
                  title: 'Still loading Plugins',
                  detail: 'This Bot’s Plugin list is still being read. The existing trigger will be kept.',
                )
              : const _InfoBox(
                  icon: Icons.extension_off_rounded,
                  title: 'This Plugin is unavailable',
                  detail: 'The existing trigger will be kept. Choose another source to replace it.',
                )
        else
          RadioGroup<String>(
            groupValue: trigger,
            onChanged: widget.enabled
                ? (next) {
                    if (next != null) chooseTrigger(next);
                  }
                : (_) {},
            child: Column(
              children: [
                for (final option in plugin.triggers)
                  identified(
                    RoutineIds.pluginTrigger(plugin.pluginId, option.name),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: RadioListTile<String>(
                        value: option.name,
                        enabled: widget.enabled,
                        title: Text(option.displayName),
                        subtitle: Text(option.description),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                          side: BorderSide(
                            color: trigger == option.name
                                ? Theme.of(context).colorScheme.primary
                                : Theme.of(context).colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _scheduleEditor(BuildContext context) {
    final localizations = MaterialLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final option in const [
              (_RoutineCadence.daily, 'Daily'),
              (_RoutineCadence.weekdays, 'Weekdays'),
              (_RoutineCadence.weekly, 'Weekly'),
              (_RoutineCadence.monthly, 'Monthly'),
              (_RoutineCadence.interval, 'Interval'),
            ])
              ChoiceChip(
                label: Text(option.$2),
                selected: schedule.cadence == option.$1,
                onSelected: widget.enabled
                    ? (_) {
                        setState(() => schedule.cadence = option.$1);
                        scheduleChanged();
                      }
                    : null,
              ),
          ],
        ),
        const SizedBox(height: 14),
        if (schedule.cadence == _RoutineCadence.custom)
          _InfoBox(
            icon: Icons.auto_awesome_rounded,
            title: schedule.originalDescription,
            detail: 'This custom schedule will be kept until you choose a simpler schedule above.',
          )
        else if (schedule.cadence == _RoutineCadence.interval)
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<int>(
                  initialValue: schedule.interval,
                  decoration: const InputDecoration(labelText: 'Every'),
                  items: [
                    for (var value = 1; value <= 59; value++)
                      DropdownMenuItem(value: value, child: Text('$value')),
                    if (schedule.interval > 59)
                      DropdownMenuItem(
                        value: schedule.interval,
                        child: Text('${schedule.interval}'),
                      ),
                  ],
                  onChanged: widget.enabled
                      ? (next) {
                          if (next == null) return;
                          setState(() => schedule.interval = next);
                          scheduleChanged();
                        }
                      : null,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: schedule.intervalUnit,
                  decoration: const InputDecoration(labelText: 'Unit'),
                  items: const [
                    DropdownMenuItem(value: 'minutes', child: Text('minutes')),
                    DropdownMenuItem(value: 'hours', child: Text('hours')),
                  ],
                  onChanged: widget.enabled
                      ? (next) {
                          if (next == null) return;
                          setState(() => schedule.intervalUnit = next);
                          scheduleChanged();
                        }
                      : null,
                ),
              ),
            ],
          )
        else ...[
          if (schedule.cadence == _RoutineCadence.weekly)
            DropdownButtonFormField<int>(
              initialValue: schedule.weekday,
              decoration: const InputDecoration(labelText: 'Day'),
              items: [
                for (var day = 1; day <= 7; day++)
                  DropdownMenuItem(
                    value: day,
                    child: Text(_weekdayNames[day - 1]),
                  ),
              ],
              onChanged: widget.enabled
                  ? (next) {
                      if (next == null) return;
                      setState(() => schedule.weekday = next);
                      scheduleChanged();
                    }
                  : null,
            ),
          if (schedule.cadence == _RoutineCadence.monthly)
            DropdownButtonFormField<int>(
              initialValue: schedule.monthDay,
              decoration: const InputDecoration(labelText: 'Day of month'),
              items: [
                for (var day = 1; day <= 28; day++)
                  DropdownMenuItem(value: day, child: Text('$day')),
              ],
              onChanged: widget.enabled
                  ? (next) {
                      if (next == null) return;
                      setState(() => schedule.monthDay = next);
                      scheduleChanged();
                    }
                  : null,
            ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: widget.enabled
                ? () async {
                    final next = await showTimePicker(
                      context: context,
                      initialTime: schedule.time,
                    );
                    if (next == null || !mounted) return;
                    setState(() => schedule.time = next);
                    scheduleChanged();
                  }
                : null,
            icon: const Icon(Icons.schedule_rounded),
            label: Text(localizations.formatTimeOfDay(schedule.time)),
          ),
        ],
        const SizedBox(height: 12),
        Text(
          widget.timezone == null
              ? '${schedule.summary(localizations)} · Profile timezone'
              : '${schedule.summary(localizations)} · ${widget.timezone}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }

  Widget _actionFields(BuildContext context) {
    final scope = ViewScope.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        identified(
          RoutineIds.editorField('name'),
          TextFormField(
            initialValue: widget.name,
            enabled: widget.enabled,
            maxLength: 100,
            decoration: const InputDecoration(labelText: 'Routine name'),
            onChanged: (next) => scope.controller.change(_name, next),
          ),
        ),
        const SizedBox(height: 10),
        identified(
          RoutineIds.editorField('prompt'),
          TextFormField(
            initialValue: widget.prompt,
            enabled: widget.enabled,
            maxLength: 8000,
            minLines: 3,
            maxLines: 7,
            decoration: const InputDecoration(
              labelText: 'Instructions',
              helperText: 'Event details arrive automatically. Describe the outcome you want.',
            ),
            onChanged: (next) => scope.controller.change(_prompt, next),
          ),
        ),
      ],
    );
  }

  Widget _editActions() => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      _routineAction('run-routine', 'Run now'),
      _routineAction('open-runs', 'Run log'),
      if (storedSourceKind != _RoutineSourceKind.schedule)
        _routineAction(
          'rotate-key',
          widget.hookKeyVersion == null ? 'Mint key' : 'Rotate key',
        ),
      if (storedSourceKind != _RoutineSourceKind.schedule &&
          widget.hookKeyVersion != null)
        _routineAction('revoke-key', 'Revoke key', style: 'danger'),
      _routineAction('delete-routine', 'Delete', style: 'danger'),
    ],
  );

  Widget _routineAction(String actionId, String label, {String? style}) =>
      ViewActionNode(
        node: {
          'type': 'action',
          'actionId': actionId,
          'label': label,
          'style': ?style,
          'input': {
            'kind': actionId,
            if (widget.routineId != null) 'routineId': widget.routineId,
          },
        },
      );
}

class _InfoBox extends StatelessWidget {
  final IconData icon;
  final String title;
  final String detail;
  const _InfoBox({
    required this.icon,
    required this.title,
    required this.detail,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: 0.32),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(13),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20, color: scheme.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 3),
                  Text(detail, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
