import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';

/// Admin: the one deployment-wide decision this app can make — whether anyone
/// new may sign up.
///
/// It is not a document surface. The deployment policy is not a User's
/// settings: it belongs to the deployment, is refused for anyone who is not an
/// admin, and carries its own revision, so it reads and writes its own route
/// rather than borrowing the settings projection.
class AdminPage extends StatefulWidget {
  final NativeApi api;
  const AdminPage({super.key, required this.api});

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> {
  Map<String, Object?>? policy;
  bool busy = false;
  bool refused = false;
  String? message;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final answer = await widget.api.request('/api/admin/policy');
      if (mounted) {
        setState(() {
          policy = ((answer as Map?) ?? const {}).cast<String, Object?>();
          refused = false;
        });
      }
    } on RequestFailure catch (failure) {
      if (mounted) {
        setState(() {
          policy = null;
          refused = failure.refused;
          message = failure.refused
              ? 'This account isn’t an admin of this deployment.'
              : 'Couldn’t reach FrockBot. Check your connection and try again.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          policy = null;
          message =
              'Couldn’t reach FrockBot. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> setSignups(bool open) async {
    final current = policy;
    if (current == null || busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final answer = await widget.api.request(
        '/api/admin/policy',
        body: {
          'schemaVersion': 1,
          'type': 'deployment/set-signups',
          'open': open,
          'revision': current['revision'],
        },
      );
      if (mounted) {
        setState(
          () => policy = ((answer as Map?) ?? const {}).cast<String, Object?>(),
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => message = 'That change didn’t stick. Refresh and try again.',
        );
      }
      await load();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = policy;
    final signups = ((current?['signups'] as Map?) ?? const {})['open'] == true;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Site administration'),
        actions: [
          identified(
            AdminIds.refresh,
            IconButton(
              tooltip: 'Refresh the deployment policy',
              onPressed: busy ? null : load,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: current == null
            ? busy
                  ? const FrockLoading(label: 'Loading the deployment policy')
                  : FrockEmptyState(
                      icon: refused
                          ? Icons.lock_outline_rounded
                          : Icons.cloud_off_rounded,
                      title: refused ? 'Admin only' : 'Admin couldn’t load',
                      detail: message ?? 'Check your connection and try again.',
                      action: 'Try again',
                      onAction: load,
                    )
            : ListView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 680),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          identified(
                            AdminIds.signups,
                            SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              title: const Text('Allow new signups'),
                              subtitle: Text(
                                signups
                                    ? 'Anyone with the link can create an account.'
                                    : 'Only people who already have an account can sign in.',
                              ),
                              value: signups,
                              onChanged: busy ? null : setSignups,
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            current['updatedBy'] == 'deployment-default'
                                ? 'Default setting'
                                : 'Last changed by ${current['updatedBy'] ?? 'an administrator'}.',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          if (message != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 16),
                              child: Semantics(
                                liveRegion: true,
                                child: Text(message!),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
