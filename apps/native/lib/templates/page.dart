/// Bot templates: packing a Bot up, and unpacking someone else's.
///
/// Two hosts over `ViewDocumentView`, because the server projects two
/// documents (`app/bot-template/templates-document.ts`): what this Bot has
/// been packed into is per-Bot, and what this account has imported is not.
/// They share one page and a tab apiece — the export section in Bot settings,
/// the import section under Advanced.
///
/// Which Bot a pack is of is never in the document: it is the Bot the host is
/// showing, and the host names it when it turns the press into a command.
library;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/states.dart';
import '../view/surface.dart';

/// The kinds `TEMPLATE_ACTION_KINDS_V1` declares.
const templateActionKindsV1 = <String>{
  'pack-template',
  'set-visibility',
  'revoke-share',
  'plan-import',
  'apply-import',
};

/// The field the import form carries.
const templateLinkFieldV1 = 'template.link';

String? templateActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return templateActionKindsV1.contains(kind) ? kind : null;
}

/// The share id a pasted link names.
///
/// A person copies whatever the other person sent them, which is a URL far
/// more often than a bare id, so both are read: the last path segment of a
/// URL, or the trimmed text as it stands.
String templateShareIdV1(String pasted) {
  final text = pasted.trim();
  final url = Uri.tryParse(text);
  if (url == null || !url.hasScheme || url.pathSegments.isEmpty) return text;
  return Uri.decodeComponent(url.pathSegments.last);
}

/// The template command an action becomes.
///
/// `commandId` is the idempotency key throughout, and for a plan it is also
/// the `importId` the apply names — which is why re-planning the same link
/// under the same id is a read rather than a second import.
Map<String, Object?> templateCommandV1(
  Map<String, Object?> command,
  String? botId,
) {
  final input = ((command['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  final meta = {'schemaVersion': 1, 'commandId': command['commandId']};
  switch (templateActionKindV1(command)) {
    case 'pack-template':
      if (botId == null) {
        throw const FormatException('Open a Bot to pack it as a template.');
      }
      return {...meta, 'type': 'template/stage', 'botId': botId};
    case 'set-visibility':
      // The press carries every share's select, so `field` says which of them
      // is this share's answer.
      final chosen = input[input['field']];
      if (chosen is! String) {
        throw const FormatException('Choose who can read this template.');
      }
      return {
        ...meta,
        'type': 'template/set-visibility',
        'shareId': input['shareId'],
        'visibility': chosen,
      };
    case 'revoke-share':
      return {...meta, 'type': 'template/revoke', 'shareId': input['shareId']};
    case 'plan-import':
      final shareId = templateShareIdV1(
        input[templateLinkFieldV1] as String? ?? '',
      );
      if (shareId.isEmpty) {
        throw const FormatException('Paste a template link first.');
      }
      return {...meta, 'type': 'template/plan-import', 'shareId': shareId};
    case 'apply-import':
      return {
        ...meta,
        'type': 'template/apply-import',
        'importId': input['importId'],
      };
    default:
      throw const FormatException('That action is not a template command.');
  }
}

/// One of the two template surfaces. They differ by route and surface id and
/// by nothing else, so they are one controller.
class TemplatesController extends ViewSurfaceController {
  final NativeApi api;
  final String path;

  /// The Bot a pack is of, when this surface is showing one.
  final String? botId;

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  @override
  final String surfaceId;

  TemplatesController(
    this.api, {
    required this.path,
    required this.surfaceId,
    this.botId,
  });

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('$path?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Template surface mismatch');
      }
      _document = next;
    } catch (_) {
      _message =
          'Couldn’t load your templates. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final answer = await api.request(
      path,
      body: templateCommandV1(command, botId),
    );
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    // The import route answers with the record itself rather than a receipt
    // envelope, so the status it carries is the import's and not the
    // command's. Either way the read that follows is the authority.
    return {
      'commandId': command['commandId'],
      'status': receipt['status'] == 'failed' ? 'rejected' : 'applied',
    };
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// Both halves, a tab apiece.
class TemplatesPage extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;

  /// The Bot a pack would be of. Absent when no Bot is open, which is a state
  /// the Share tab names rather than a button that refuses.
  final String? botId;
  final String? botName;
  const TemplatesPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.botId,
    this.botName,
  });

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    initialIndex: botId == null ? 1 : 0,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('Bot templates'),
        bottom: const TabBar(
          tabs: [
            Tab(text: 'Share a Bot'),
            Tab(text: 'Use a template'),
          ],
        ),
      ),
      body: TabBarView(
        children: [
          if (botId == null)
            _ChooseTemplateBot(api: api, store: store, userId: userId)
          else
            ViewSurfacePage(
              title: 'Share ${botName ?? 'this Bot'}',
              store: store,
              userId: userId,
              documentId: TemplateIds.shareDocument,
              refreshId: TemplateIds.shareRefresh,
              chrome: false,
              controller: TemplatesController(
                api,
                path: '/api/bot-templates',
                surfaceId: 'bot-templates',
                botId: botId,
              ),
            ),
          ViewSurfacePage(
            title: 'Import',
            store: store,
            userId: userId,
            documentId: TemplateIds.importDocument,
            refreshId: TemplateIds.importRefresh,
            chrome: false,
            controller: TemplatesController(
              api,
              path: '/api/bot-template-imports',
              surfaceId: 'bot-template-imports',
            ),
          ),
        ],
      ),
    ),
  );
}

class _ChooseTemplateBot extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  const _ChooseTemplateBot({
    required this.api,
    required this.store,
    required this.userId,
  });
  @override
  State<_ChooseTemplateBot> createState() => _ChooseTemplateBotState();
}

class _ChooseTemplateBotState extends State<_ChooseTemplateBot> {
  late Future<wire.BotDirectory> directory = _load();
  Future<wire.BotDirectory> _load() async =>
      wire.BotDirectory.fromJson(await widget.api.request('/api/bots'));
  @override
  Widget build(BuildContext context) => FutureBuilder<wire.BotDirectory>(
    future: directory,
    builder: (context, result) {
      if (result.hasError) {
        return FrockEmptyState(
          icon: Icons.cloud_off,
          title: 'Bots couldn’t load',
          detail: 'Check your connection and try again.',
          action: 'Try again',
          onAction: () => setState(() => directory = _load()),
        );
      }
      if (!result.hasData) {
        return const FrockLoading(label: 'Loading your Bots');
      }
      if (result.data!.bots.isEmpty) {
        return const Center(
          child: Text('Create a Bot first, then share it as a template.'),
        );
      }
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Choose a Bot to share its instructions, skills and routines.',
          ),
          for (final bot in result.data!.bots)
            ListTile(
              title: Text(bot.initialName),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => TemplatesPage(
                    api: widget.api,
                    store: widget.store,
                    userId: widget.userId,
                    botId: bot.botId.value,
                    botName: bot.initialName,
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}
