import 'package:flutter/material.dart';

import 'canvas.dart';
import '../client/transport.dart';
import '../shell/semantics.dart';

class AppletPicker extends StatefulWidget {
  final AppletCanvasController controller;
  const AppletPicker({super.key, required this.controller});

  @override
  State<AppletPicker> createState() => _AppletPickerState();
}

class _AppletPickerState extends State<AppletPicker> {
  /// Applets a confirmed delete has already taken off this list, ahead of the
  /// round trip and the re-read behind it. The confirmation is the decision,
  /// and a delete the backend no longer has anything to do is already treated
  /// as the outcome the row asked for, so the row going now says the same
  /// thing sooner. A delete that genuinely failed puts its row back.
  final Set<String> removed = {};
  String? error;

  @override
  void initState() {
    super.initState();
    widget.controller.load();
  }

  Future<void> remove(String id, String name) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete $name?'),
        content: const Text(
          'This permanently deletes its data and versions for all your Bots. This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      removed.add(id);
      error = null;
    });
    try {
      final controller = widget.controller;
      try {
        await controller.applets.delete(id);
      } on RequestFailure catch (failure) {
        // An Applet the backend no longer has is the outcome this row asked
        // for. Only a delete that might still succeed is worth retrying.
        if (failure.status != 404) rethrow;
      }
      await controller.load();
      // The re-read is the authority on what is left, so the prediction it
      // confirms stops standing in for one.
      if (mounted) setState(() => removed.remove(id));
    } catch (_) {
      if (mounted) {
        setState(() {
          removed.remove(id);
          error = 'Couldn’t delete this Applet. Try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final listed = [
        for (final applet in controller.directory)
          if (!removed.contains(applet.appletId)) applet,
      ];
      return AlertDialog(
        title: const Text('Applets'),
        content: SizedBox(
          width: 440,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (error != null) Text(error!),
                if (controller.loading && listed.isEmpty)
                  const LinearProgressIndicator(),
                if (!controller.loading &&
                    controller.directoryFailure == null &&
                    listed.isEmpty)
                  const Text('No Applets yet. Ask a Bot to build one.'),
                if (controller.directoryFailure != null)
                  TextButton(
                    onPressed: controller.retry,
                    child: const Text('Couldn’t load Applets · Retry'),
                  ),
                // A delete in flight is a row that is already gone, so no other
                // row waits on it: choosing or deleting a different Applet
                // never depended on this one's round trip.
                for (final applet in listed)
                  Row(
                    children: [
                      Expanded(
                        child: identified(
                          'applet-choice-${applet.appletId}',
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(applet.displayName),
                            onTap: () =>
                                Navigator.pop(context, applet.appletId),
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Delete ${applet.displayName}',
                        onPressed: () =>
                            remove(applet.appletId, applet.displayName),
                        icon: const Icon(Icons.delete_outline),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      );
    },
  );
}
