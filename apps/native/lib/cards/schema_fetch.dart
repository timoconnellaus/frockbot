/// Why a card's schemas are never fetched.
///
/// The renderer validates a card's components against the catalog, and the
/// validator resolves a schema it does not hold by *fetching* it: the A2UI
/// catalog `genui` builds declares `$schema` as the JSON Schema meta-schema's
/// URL, so a draw would reach out to `json-schema.org` over the network.
///
/// That fetch is best-effort — it fails and the card still draws — but it is
/// a third-party request on every card the person is shown. On the web the
/// page's own Content Security Policy blocks it and each draw leaves a pair of
/// console errors behind; on the phone and the desktop there is no such policy
/// and the request would actually go out.
///
/// So the fetch is refused here instead, in the one place a card reaches the
/// renderer. The validator already treats an unreachable schema as an error it
/// carries rather than a crash, so refusing it immediately is the answer it
/// would have arrived at anyway, minus the network.
library;

import 'dart:async';

import 'package:http/http.dart' as http;

/// The client the renderer's schema cache finds while a card is being adopted.
class _RefusedSchemaFetch extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    throw StateError(
      'a card draws from the catalog compiled into this app, so the schema at '
      '${request.url} is never fetched',
    );
  }
}

/// Runs [body] with every schema fetch the renderer would make refused.
///
/// The refusal holds for the asynchronous validation the call starts, not only
/// for the call itself: `runWithClient` puts the client on the Zone, and the
/// work `genui` schedules from inside [body] runs in that Zone.
T withoutSchemaFetchesV1<T>(T Function() body) =>
    http.runWithClient(body, _RefusedSchemaFetch.new);
