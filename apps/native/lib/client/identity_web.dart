import 'package:web/web.dart' as web;

/// Who the Worker says is looking, read from the document it rendered.
///
/// The gateway stamps the session onto `<body>` before the app is downloaded,
/// so the browser knows whether anyone is signed in on the first frame rather
/// than after a round trip — which is the difference between painting the
/// shell and flashing the sign-in door at someone who is already signed in.
/// `anonymous` is the gateway's own name for nobody, and the mode says so too.
String? bootstrapUserIdV1() {
  final body = web.document.body;
  if (body == null) return null;
  if (body.getAttribute('data-frockbot-auth-mode') == 'anonymous') return null;
  final userId = body.getAttribute('data-frockbot-user-id');
  return userId == null || userId.isEmpty || userId == 'anonymous'
      ? null
      : userId;
}
