/// The client a Card's schema resolution is answered from, and nothing else
/// (ADR 0030).
///
/// The renderer draws a Card by validating it against the catalog's schemas,
/// and the schema stack it uses resolves every `$schema` and `$ref` a schema
/// names. The A2UI common types the renderer registers declare
/// `$schema: https://json-schema.org/draft/2020-12/schema`, so drawing any
/// card would otherwise fetch that document from json-schema.org — a request
/// the deployment's CSP refuses, and one a Catalog compiled into this build
/// never needs, because the draft's documents ship here
/// (`schema_documents.g.dart`).
///
/// So the renderer's own client answers the documents this build carries and
/// refuses everything else without a request. A schema this build does not
/// hold is one it cannot validate against, and reaching the network for it
/// would let a Card make the app fetch a schema of its own choosing — the
/// catalog is compiled in, and that is what keeps a Card data, not code.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'schema_documents.g.dart';

/// Answers the draft 2020-12 documents this build carries, by `$id`, and
/// refuses every other request without touching the network.
class CardSchemaClientV1 extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    final document =
        cardSchemaDocumentsV1[request.url.removeFragment().toString()];
    if (document == null) {
      return Future.error(
        http.ClientException(
          'this build carries no schema for ${request.url}',
          request.url,
        ),
      );
    }
    final bytes = utf8.encode(document);
    return Future.value(
      http.StreamedResponse(
        Stream.value(bytes),
        200,
        contentLength: bytes.length,
        headers: const {'content-type': 'application/schema+json'},
      ),
    );
  }
}

/// The one client schema resolution is given.
final http.Client cardSchemaClientV1 = CardSchemaClientV1();

/// Runs [body] — the renderer's message intake, which is where it validates —
/// with `Client()` resolving to [cardSchemaClientV1].
///
/// `json_schema_builder` asks `package:http` for its own client at the moment
/// it resolves something its registry does not hold, so this zone is what puts
/// the local documents in front of that request. The zone is deliberately the
/// width of the intake and no wider: everything the app draws afterwards goes
/// through clients it already holds.
R withLocalCardSchemasV1<R>(R Function() body) =>
    http.runWithClient<R>(body, () => cardSchemaClientV1);
