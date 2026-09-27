import 'dart:convert';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Compile-time-only, bounded telemetry. It records no text or identifiers.
/// App input-to-frame excludes hardware dispatch/compositor latency; the full
/// input-to-paint gate still requires the OS trace and physical IME fixture.
class AcceptanceMetrics with WidgetsBindingObserver {
  static const enabled = bool.fromEnvironment('NATIVE_ACCEPTANCE');
  static final instance = AcceptanceMetrics._();
  AcceptanceMetrics._();
  final _clock = Stopwatch();
  final _frames = <Map<String, double>>[];
  final _inputs = <double>[];
  bool _first = true;
  bool _editable = false;
  void start() {
    if (!enabled) return;
    _clock.start();
    WidgetsBinding.instance.addObserver(this);
    SchedulerBinding.instance.addTimingsCallback((timings) {
      for (final timing in timings) {
        _frames.add({
          'buildMs': timing.buildDuration.inMicroseconds / 1000,
          'rasterMs': timing.rasterDuration.inMicroseconds / 1000,
          'totalMs': timing.totalSpan.inMicroseconds / 1000,
        });
        if (_frames.length >= 120) flush();
      }
      if (_first) {
        _emit({'firstPaintMs': _clock.elapsedMicroseconds / 1000});
        _first = false;
        flush();
      }
    });
  }

  void editableShown() {
    if (!enabled || _editable) return;
    _editable = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _emit({'firstEditableFrameMs': _clock.elapsedMicroseconds / 1000});
    });
  }

  void inputChanged() {
    if (!enabled) return;
    final start = _clock.elapsedMicroseconds;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _inputs.add((_clock.elapsedMicroseconds - start) / 1000);
      if (_inputs.length >= 120) flush();
    });
  }

  void flush() {
    if (!enabled || (_frames.isEmpty && _inputs.isEmpty)) return;
    _emit({'frames': List.of(_frames), 'appInputToFrameMs': List.of(_inputs)});
    _frames.clear();
    _inputs.clear();
  }

  void _emit(Map<String, Object> data) {
    // ignore: avoid_print -- explicit local acceptance build; no personal data.
    print('FROCKBOT_METRICS ${jsonEncode({'schemaVersion': 1, ...data})}');
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) flush();
  }
}
