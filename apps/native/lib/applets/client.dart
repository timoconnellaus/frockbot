/// The client half of the Applet routes.
///
/// A port of `app/shell/client/applets-client.ts`: the backend is the
/// authority for every one of these reads, and this is only the typed seam
/// between the transport and what the canvas draws. A route absent from a
/// deployment reads as "no Applets" rather than as an error over the
/// conversation.
///
/// Four of the six answers have no generated decoder, because they are views
/// the browser client owns rather than wire shapes the native protocol
/// declares. They are decoded by hand here, exactly: an unexpected shape is a
/// `FormatException` rather than a half-read Applet.
library;

import 'package:flutter/foundation.dart' show debugPrint;

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

/// `--dart-define=FROCKBOT_APPLET_TIMING=true` prints one line per hop of
/// the open path — the open read, the viewer, the frame's load, and what the
/// page reports of its own socket, hello and first render — so a slow open is
/// read hop by hop rather than guessed at. Off, it costs a constant-folded
/// branch, and the page is not asked to report anything.
const appletTimingLogV1 = bool.fromEnvironment('FROCKBOT_APPLET_TIMING');

/// When the current open began. One clock for the canvas and the frame it
/// holds, so the page's hops line up with the host's.
final appletOpenClockV1 = Stopwatch();

/// One hop of the open path, in milliseconds since the open began.
void appletTimingV1(String hop, {String detail = ''}) {
  if (!appletTimingLogV1) return;
  debugPrint(
    'applet-timing $hop ${appletOpenClockV1.elapsedMilliseconds}ms'
    '${detail.isEmpty ? '' : ' $detail'}',
  );
}

String _applet(String appletId) => Uri.encodeComponent(appletId);
String _bot(String botId) => Uri.encodeComponent(botId);

/// One text file of an Applet's source, as the canvas draws it.
class AppletSourceFile {
  final String path;
  final String text;
  final String generationId;
  final String? changedAt;
  const AppletSourceFile({
    required this.path,
    required this.text,
    required this.generationId,
    this.changedAt,
  });
}

class AppletSource {
  final String appletId;
  final List<AppletSourceFile> files;
  final bool truncated;
  const AppletSource({
    required this.appletId,
    required this.files,
    required this.truncated,
  });

  factory AppletSource.fromJson(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    return AppletSource(
      appletId: json['appletId']! as String,
      truncated: json['truncated']! as bool,
      files: [
        for (final entry in (json['files']! as List).cast<Map>())
          AppletSourceFile(
            path: entry['path']! as String,
            text: entry['text']! as String,
            generationId: entry['generationId']! as String,
            changedAt: entry['changedAt'] as String?,
          ),
      ],
    );
  }
}

/// The outcome the Applet authority last recorded for a check or a build.
class AppletBuild {
  final String status;
  final String? command;
  final String? summary;
  final List<String> diagnostics;
  const AppletBuild({
    required this.status,
    this.command,
    this.summary,
    this.diagnostics = const [],
  });

  factory AppletBuild.fromJson(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    final status = json['status'];
    if (status != 'unknown' && status != 'passed' && status != 'failed') {
      throw const FormatException('Unknown build status');
    }
    return AppletBuild(
      status: status! as String,
      command: json['command'] as String?,
      summary: json['summary'] as String?,
      diagnostics: [
        for (final line in (json['diagnostics'] as List?) ?? const [])
          line! as String,
      ],
    );
  }
}

/// Where the canvas reads an Applet's live UI from.
class AppletUi {
  final String uiUrl;
  final String? generationId;
  const AppletUi({required this.uiUrl, this.generationId});

  factory AppletUi.fromJson(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    final uiUrl = json['uiUrl']! as String;
    final url = Uri.parse(uiUrl);
    // The page origin is anonymous and separate from the app's. A `uiUrl` that
    // is not an absolute page URL is not one this host will frame.
    if (!url.isAbsolute || url.host.isEmpty || url.userInfo.isNotEmpty) {
      throw const FormatException('Invalid Applet UI url');
    }
    return AppletUi(
      uiUrl: uiUrl,
      generationId: json['generationId'] as String?,
    );
  }
}

/// The viewer credential, the socket it opens and the page it opens over.
class AppletViewer {
  final String appletId;
  final String generationId;
  final String uiUrl;
  final String token;
  final String socketUrl;
  final DateTime expiresAt;
  const AppletViewer({
    required this.appletId,
    required this.generationId,
    required this.uiUrl,
    required this.token,
    required this.socketUrl,
    required this.expiresAt,
  });

  /// The viewer as the open route answers it. Only for a focus that carries
  /// one: an unpublished Applet has an id and nothing to frame.
  static AppletViewer? fromOpen(wire.AppletOpenFocus focus) {
    final generationId = focus.generationId?.value;
    final uiUrl = focus.uiUrl;
    final token = focus.token;
    final socketUrl = focus.socketUrl;
    final expiresAt = focus.expiresAt?.value;
    if (generationId == null ||
        uiUrl == null ||
        token == null ||
        socketUrl == null ||
        expiresAt == null) {
      return null;
    }
    return AppletViewer(
      appletId: focus.appletId,
      generationId: generationId,
      uiUrl: AppletUi.fromJson({'uiUrl': uiUrl}).uiUrl,
      token: token,
      socketUrl: socketUrl,
      expiresAt: DateTime.parse(expiresAt),
    );
  }

  /// The `init` the Applet SDK waits for. The token is the only credential an
  /// Applet page ever holds, and it names one User, one Applet and one
  /// generation for fifteen minutes.
  Map<String, Object?> init(Map<String, String> themeTokens) =>
      _message('init', themeTokens);

  /// The same shape as `init`, for a page that is already running: a fresh
  /// credential it adopts by reconnecting in place, with no document rebuilt.
  Map<String, Object?> refresh(Map<String, String> themeTokens) =>
      _message('refresh', themeTokens);

  Map<String, Object?> _message(
    String type,
    Map<String, String> themeTokens,
  ) => {
    'schemaVersion': 1,
    'type': type,
    'themeTokens': themeTokens,
    'applet': {
      'socketUrl': socketUrl,
      'token': token,
      'generationId': generationId,
      'tokenTransport': 'subprotocol-v1',
      // The page reports its own hops only when the host is keeping the log.
      if (appletTimingLogV1) 'timing': true,
    },
  };

  /// What makes this viewer the same document as another: the generation
  /// and the page. The credential is not part of it — a re-minted token
  /// reaches the running page as a `refresh`, never as a rebuilt frame.
  String get documentIdentity => '$generationId|$uiUrl';

  /// When the credential should be re-minted: this close to its expiry.
  DateTime get refreshAt => expiresAt.subtract(appletViewerRefreshV1);
}

class AppletsApi {
  final NativeApi api;
  const AppletsApi(this.api);

  Future<List<wire.AppletSummary>> list() async =>
      wire.AppletDirectory.fromJson(await api.request('/api/applets')).applets;

  /// The canvas's one read: the directory, the Session's focus, and for the
  /// focused Applet the generation, its page and a viewer credential. What
  /// used to be four to seven requests in series, and the only request the
  /// frame waits on.
  Future<wire.AppletOpenView> open(String botId) async =>
      wire.AppletOpenView.fromJson(
        await api.request('/api/bots/${_bot(botId)}/applets/open'),
      );

  Future<void> delete(String appletId) async {
    await api.request(
      '/api/applets/${_applet(appletId)}/delete',
      body: {'schemaVersion': 1},
    );
  }

  Future<AppletUi> ui(String appletId) async => AppletUi.fromJson(
    await api.request('/api/applets/${_applet(appletId)}/ui'),
  );

  Future<wire.AppletViewerToken> token(String appletId) async =>
      wire.AppletViewerToken.fromJson(
        await api.request('/api/applets/${_applet(appletId)}/token'),
      );

  /// The canvas's two Workspace-backed reads are Bot-scoped in the URL and
  /// User-scoped in what they answer: the Applets root belongs to the User,
  /// and the Bot in the path only names the Durable Object holding the
  /// Workspace binding. Reading them wakes no Computer.
  Future<AppletSource> source(String botId, String appletId) async =>
      AppletSource.fromJson(
        await api.request(
          '/api/bots/${_bot(botId)}/applets/${_applet(appletId)}/source',
          limit: 2000000,
        ),
      );

  Future<AppletBuild> build(String botId, String appletId) async =>
      AppletBuild.fromJson(
        await api.request(
          '/api/bots/${_bot(botId)}/applets/${_applet(appletId)}/build',
        ),
      );

  Future<String?> focus(String botId) async =>
      _focusOf(await api.request('/api/bots/${_bot(botId)}/applets/focus'));

  /// Records the Session's focused Applet and returns what the backend
  /// recorded, never what the tap asked for: a focus the backend refused reads
  /// back as the focus it kept.
  ///
  /// The route takes exactly one key and refuses anything else, so the command
  /// is `{appletId}` and carries no schema version — which is why this is not
  /// a `SettingsChangeCommand`-shaped write like the rest.
  Future<String?> setFocus(String botId, String? appletId) async => _focusOf(
    await api.request(
      '/api/bots/${_bot(botId)}/applets/focus',
      body: {'appletId': appletId},
    ),
  );

  static String? _focusOf(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    final appletId = json['appletId'];
    if (appletId != null && appletId is! String) {
      throw const FormatException('Invalid Applet focus');
    }
    return appletId as String?;
  }
}

/// Directories under an Applet's root that hold machine output, not source.
const appletSourceArtefactDirectoriesV1 = <String>{
  'dist',
  'build',
  'node_modules',
  '.wrangler',
  '.frockbot-generations',
  '.git',
  '.cache',
  '.turbo',
  '.vite',
  'coverage',
};

/// True when an Applet-relative path lies in a machine-output directory,
/// matched as a segment at any depth.
bool appletSourceArtefactPathV1(String path) {
  final segments = path.split('/');
  return segments
      .take(segments.isEmpty ? 0 : segments.length - 1)
      .any(appletSourceArtefactDirectoriesV1.contains);
}

/// The Applet's own files, with machine output left out.
List<AppletSourceFile> appletSourceFilesV1(AppletSource? source) => [
  for (final file in source?.files ?? const <AppletSourceFile>[])
    if (!appletSourceArtefactPathV1(file.path)) file,
];

/// The file the canvas opens on while a Bot is writing an Applet: the one that
/// changed most recently, falling back to a Bot's own first file so a store
/// with no timestamps still opens on something a person recognises.
String? mostRecentlyChangedFileV1(AppletSource? source) {
  final files = appletSourceFilesV1(source);
  if (files.isEmpty) return null;
  const preferred = ['applet.json', 'server.ts', 'ui.tsx'];
  int rank(String path) {
    final index = preferred.indexOf(path);
    return index < 0 ? preferred.length : index;
  }

  final ordered = [...files]
    ..sort((left, right) {
      final leftAt = left.changedAt ?? '';
      final rightAt = right.changedAt ?? '';
      if (leftAt != rightAt) return rightAt.compareTo(leftAt);
      final byRank = rank(left.path).compareTo(rank(right.path));
      return byRank != 0 ? byRank : left.path.compareTo(right.path);
    });
  return ordered.first.path;
}

/// A stable identity for the source the canvas is showing.
///
/// The canvas follows the Turn: a Turn that writes source lands the reader on
/// the code. "Wrote source" has to be a fact about the files, though, not
/// about the store having been re-read — every poll assigns a fresh view, so a
/// watcher on the object itself fired on Turns that touched no file at all and
/// yanked the reader off the live Applet.
String appletSourceFingerprintV1(AppletSource? source) {
  if (source == null) return '';
  final lines = [
    for (final file in appletSourceFilesV1(source))
      '${file.path}@${file.generationId}@${file.changedAt ?? ''}',
  ]..sort();
  return lines.join('\n');
}

/// Re-mint the viewer credential once it is this close to expiring.
const appletViewerRefreshV1 = Duration(minutes: 3);

/// Whether a read of this Applet is the first one, and so may draw a skeleton.
///
/// A skeleton is for an empty panel. The canvas re-reads the source on a
/// cadence while a Turn runs, and showing the loading state on each of those
/// replaced a live Applet — mid-use, mid-scroll — with grey bars twice a
/// minute.
bool appletCanvasIsFirstReadV1({
  required String appletId,
  String? viewerAppletId,
  String? sourceAppletId,
}) => viewerAppletId != appletId && sourceAppletId != appletId;

/// Whether the viewer credential already in hand still opens this Applet.
///
/// The published generation is what the open Applet *is*: while it is
/// unchanged and the credential has life left in it, nothing is re-fetched and
/// the frame keeps running.
bool appletViewerStillCurrentV1({
  AppletViewer? held,
  required String appletId,
  required String generationId,
  DateTime? now,
  Duration refreshWithin = appletViewerRefreshV1,
}) {
  if (held == null) return false;
  if (held.appletId != appletId) return false;
  if (held.generationId != generationId) return false;
  return held.expiresAt.difference(now ?? DateTime.now()) >= refreshWithin;
}
