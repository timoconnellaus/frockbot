/// A Package page, hosted.
///
/// A port of `PackageIframeHost.vue`: the shell owns the frame's chrome — the
/// attribution, the failure line, the height a `flow` page asks for — and the
/// Package owns only the document inside it. Every message is decoded exactly
/// before it is acted on, and a capability the Package did not declare is
/// refused with the host's own sentence rather than silently ignored.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../theme/frock_theme.dart';
import '../view/host_frame.dart';
import 'catalog.dart';

/// The bridge versions a page may announce. A page that never announces is a
/// version 1 page and is only ever sent version 1 messages, so one published
/// before the bump keeps working unchanged.
const packageBridgeVersionsV2 = {1, 2};

/// The theme a page is given.
///
/// Design tokens are the contract between the shell and a Package's page: a
/// page is handed semantic names, never the shell's own styles, and never a
/// colour to hard-code. The names match `PackageIframeHost.vue`, so a page
/// written for the browser is themed identically here.
Map<String, String> packageThemeTokensV1(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  String hex(Color colour) =>
      // ignore: deprecated_member_use -- `toARGB32` is not in the pinned SDK.
      '#${colour.value.toRadixString(16).padLeft(8, '0').substring(2)}';
  return {
    'surface': hex(scheme.surface),
    'surface-raised': hex(scheme.surfaceContainerHighest),
    'surface-subtle': hex(scheme.surfaceContainerHighest),
    'surface-window': hex(Theme.of(context).scaffoldBackgroundColor),
    'text': hex(scheme.onSurface),
    'text-muted': hex(scheme.onSurfaceVariant),
    'text-subtle': hex(scheme.onSurfaceVariant),
    'border': hex(scheme.outlineVariant),
    'border-strong': hex(scheme.outline),
    'accent': hex(scheme.primary),
    'accent-surface': hex(scheme.primaryContainer),
    'accent-text': hex(scheme.primary),
    'on-accent': hex(scheme.onPrimary),
    'danger': hex(scheme.error),
    'danger-surface': hex(scheme.errorContainer),
    'danger-border': hex(scheme.error),
    'focus-ring': hex(scheme.primary),
    'radius-control': '10px',
    'radius-card': '12px',
    'font-sans': 'Manrope, ui-sans-serif, system-ui, sans-serif',
    'font-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    'text-xs': '12px',
    'text-sm': '13px',
    'text-base': '14px',
    'text-md': '15px',
    'text-lg': '17px',
    'text-xl': '20px',
    'leading-normal': '1.5',
    'motion-fast': '${FrockTheme.fast.inMilliseconds}ms',
  };
}

/// `flow` gives the frame the height the page asks for; `fill` gives it the
/// height of its container, for a page that owns a whole panel.
enum PackageFrameLayout { flow, fill }

class PackagePageFrame extends StatefulWidget {
  final NativeApi api;
  final PackageCatalog catalog;
  final PackageContribution contribution;
  final PackagePage page;
  final String botId;
  final String slot;

  /// The named state feeds this frame receives, by state name.
  final Map<String, Object?> states;
  final PackageFrameLayout layout;

  /// A page hosted in a surface has its attribution drawn by the surface.
  final bool attribution;

  /// The title the surface around this frame already shows. When it is the
  /// Package's own name the attribution drops the name and keeps only the
  /// provenance: "Applets" over "Applets" over "Applets" said one thing three
  /// times (2026-09-05).
  final String? surfaceTitle;

  /// What the Session's focused Applet becomes when a page asks. Absent where
  /// the host has no focus to change.
  final Future<void> Function(String? appletId)? onFocus;
  const PackagePageFrame({
    super.key,
    required this.api,
    required this.catalog,
    required this.contribution,
    required this.page,
    required this.botId,
    required this.slot,
    this.states = const {},
    this.layout = PackageFrameLayout.flow,
    this.attribution = true,
    this.surfaceTitle,
    this.onFocus,
  });

  @override
  State<PackagePageFrame> createState() => _PackagePageFrameState();
}

class _PackagePageFrameState extends State<PackagePageFrame> {
  int _bridge = 1;
  double _height = 240;
  String? _failure;

  /// The handshake, then one `state` message per named feed — the order the
  /// browser host posts them in, because a page reads its feeds only after it
  /// has been told who it is.
  List<Map<String, Object?>> _messages(BuildContext context) => [
    {
      'schemaVersion': _bridge,
      'type': 'init',
      'themeTokens': packageThemeTokensV1(context),
      'packageId': widget.contribution.packageId,
      'botId': widget.botId,
      'slot': widget.slot,
      'pageId': widget.page.id,
    },
    for (final feed in {...widget.states, ..._feeds}.entries)
      {
        'schemaVersion': _bridge,
        'type': 'state',
        'name': feed.key,
        'value': feed.value,
      },
  ];

  Future<void> _onMessage(Map<String, Object?> message) async {
    final version = message['schemaVersion'];
    if (version != 1 && version != 2) return;
    switch (message['type']) {
      case 'hello':
        final announced = message['bridgeVersion'];
        // The announcement can land before or after the frame's load, so the
        // handshake is re-sent at the announced version either way.
        if (version != 2 ||
            !packageBridgeVersionsV2.contains(announced) ||
            announced == _bridge) {
          return;
        }
        setState(() => _bridge = announced! as int);
      case 'resize':
        final height = message['height'];
        if (height is! num || !height.isFinite) return;
        setState(() => _height = height.roundToDouble().clamp(96, 1200));
      case 'focus':
        if (!widget.contribution.allowsFocus) {
          setState(
            () => _failure = 'This plugin can’t change which Applet is open.',
          );
          return;
        }
        final appletId = message['appletId'];
        if (appletId != null && appletId is! String) return;
        setState(() => _failure = null);
        await widget.onFocus?.call(appletId as String?);
      case 'openExternal':
        final url = message['url'];
        if (url is! String || !widget.catalog.allowsExternal(url)) {
          setState(() => _failure = 'This plugin can only open its own pages.');
          return;
        }
        setState(() => _failure = null);
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      case 'callTool':
        await _callTool(message);
    }
  }

  Future<void> _callTool(Map<String, Object?> message) async {
    final name = message['name'];
    if (name is! String) return;
    if (!widget.contribution.allowsTool(name)) {
      setState(() => _failure = 'This plugin isn’t allowed to use $name.');
      return;
    }
    setState(() => _failure = null);
    try {
      final result = await callPackageToolV1(
        widget.api,
        widget.botId,
        widget.contribution.packageId,
        name,
        message['input'],
      );
      _feed('tool:$name', result);
    } catch (failure) {
      final detail = failure is RequestFailure
          ? failure.message
          : 'That didn’t work.';
      setState(() => _failure = detail);
      _feed('tool:$name', {'isError': true, 'content': detail});
    }
  }

  /// A tool's answer is a state feed like any other, so the page reads it the
  /// same way it reads everything else the host knows.
  final _feeds = <String, Object?>{};
  void _feed(String name, Object? value) {
    if (!mounted) return;
    setState(() => _feeds[name] = value);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final showsName = widget.contribution.displayName != widget.surfaceTitle;
    final provenance = widget.contribution.provenanceLabel;
    final frame = HostFrame(
      url: widget.catalog.pageUrl(widget.page),
      label: widget.contribution.displayName,
      identity:
          '${widget.contribution.packageId}:${widget.page.contentHash}:$_bridge',
      messages: _messages(context),
      onMessage: (message) => unawaited(_onMessage(message)),
      onFailure: (detail) => setState(() => _failure = detail),
    );
    return DecoratedBox(
      decoration: BoxDecoration(
        border: widget.layout == PackageFrameLayout.fill
            ? null
            : Border.all(color: scheme.outlineVariant),
        borderRadius: widget.layout == PackageFrameLayout.fill
            ? null
            : BorderRadius.circular(12),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.attribution && (showsName || provenance != null))
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              child: Row(
                children: [
                  if (showsName)
                    Expanded(
                      child: Text(
                        widget.contribution.displayName,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    )
                  else
                    const Spacer(),
                  if (provenance != null)
                    Text(
                      provenance,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
          if (widget.layout == PackageFrameLayout.fill)
            Expanded(child: frame)
          else
            SizedBox(height: _height, child: frame),
          if (_failure case final String detail)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              child: Text(
                detail,
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: scheme.error),
              ),
            ),
        ],
      ),
    );
  }
}
