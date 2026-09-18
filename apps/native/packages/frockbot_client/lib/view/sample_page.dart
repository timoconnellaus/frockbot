import 'package:flutter/material.dart';

import '../client/auth.dart' show developmentAuth;
import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'action.dart';
import 'document.dart';
import 'embed.dart';

/// A representative document, so the renderer can be looked at on a device
/// before any plugin produces one. Reachable only from a `FROCKBOT_DEV_AUTH`
/// build; [developmentAuth] is what the shipped app is missing.
const sampleViewDocumentV1 = <String, Object?>{
  'schemaVersion': 1,
  'surfaceId': 'renderer-sample',
  'revision': 1,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'title': 'Deploy target',
    'children': [
      {
        'type': 'text',
        'text': 'A plugin described this whole panel. The host drew every part of it.',
      },
      {
        'type': 'field',
        'field': {
          'id': 'region',
          'label': 'Region',
          'kind': 'select',
          'value': 'syd',
          'editable': true,
          'hint': 'Where this Applet runs.',
          'choices': [
            {'label': 'Sydney', 'value': 'syd'},
            {'label': 'Frankfurt', 'value': 'fra'},
          ],
        },
      },
      {
        'type': 'field',
        'field': {
          'id': 'notify',
          'label': 'Tell me when it finishes',
          'kind': 'boolean',
          'value': true,
          'editable': true,
        },
      },
      {'type': 'text', 'text': 'Recent deploys', 'style': 'heading'},
      {
        'type': 'list',
        'empty': 'No deploys yet.',
        'rows': [
          {
            'id': 'syd-1',
            'selected': true,
            'actionId': 'open-deploy',
            'node': {
              'type': 'text',
              'text': 'Sydney · 2 minutes ago',
              'style': 'label',
            },
          },
          {
            'id': 'fra-1',
            'actionId': 'open-deploy',
            'node': {
              'type': 'text',
              'text': 'Frankfurt · yesterday',
              'style': 'label',
            },
          },
        ],
      },
      {
        'type': 'embed',
        'kind': 'frame',
        'source': appletViewerFrameV1,
        'label': 'Applet preview',
      },
      {
        'type': 'action',
        'actionId': 'deploy',
        'label': 'Deploy',
        'style': 'primary',
        'input': {'confirm': true},
      },
    ],
  },
  'actions': [
    {
      'id': 'deploy',
      'schema': {
        'type': 'object',
        'properties': {
          'region': {'type': 'string', 'maxLength': 64},
          'notify': {'type': 'boolean'},
          'confirm': {'type': 'boolean'},
        },
        'required': ['region'],
        'additionalProperties': false,
      },
    },
    {
      'id': 'open-deploy',
      'schema': {
        'type': 'object',
        'properties': <String, Object?>{},
        'required': <String>[],
        'additionalProperties': false,
      },
    },
  ],
};

class ViewSamplePage extends StatefulWidget {
  final LocalStore store;
  final String userId;
  const ViewSamplePage({super.key, required this.store, required this.userId});

  @override
  State<ViewSamplePage> createState() => _ViewSamplePageState();
}

class _ViewSamplePageState extends State<ViewSamplePage> {
  late final document = wire.ViewDocument.fromJson(sampleViewDocumentV1);
  late final controller = ViewController(
    store: widget.store,
    userId: widget.userId,
    surfaceId: 'renderer-sample',
    revision: 1,
    // No route carries a view action yet; the sample proves the assembled
    // input, not the wire.
    dispatch: (command) async => {
      'commandId': command['commandId'],
      'status': 'applied',
    },
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('View sample')),
    body: SafeArea(
      top: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: ViewDocumentView(
                document: document,
                controller: controller,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
