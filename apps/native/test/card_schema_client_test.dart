import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/cards/schema_client.dart';
import 'package:http/http.dart' as http;

/// One document the client holds, read as a response — no network either way.
Future<http.Response> readDocument(http.Client client, String url) async {
  final request = http.Request('GET', Uri.parse(url));
  return http.Response.fromStream(await client.send(request));
}

void main() {
  group('the client a card validates through', () {
    test('answers the draft meta-schema from this build', () async {
      final response = await readDocument(
        cardSchemaClientV1,
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(response.statusCode, 200);
      final document = jsonDecode(response.body) as Map<String, Object?>;
      expect(document['\$id'], 'https://json-schema.org/draft/2020-12/schema');
      // The library reads the declared vocabularies from the meta-schema, so
      // this has to be the real document rather than a placeholder.
      expect(document['\$vocabulary'], isA<Map<String, Object?>>());
    });

    test('answers every document the draft itself refers to', () async {
      final response = await readDocument(
        cardSchemaClientV1,
        'https://json-schema.org/draft/2020-12/schema',
      );
      final document = jsonDecode(response.body) as Map<String, Object?>;
      final base = Uri.parse(document['\$id']! as String);
      final references = [
        for (final entry in document['allOf']! as List<Object?>)
          base.resolve((entry as Map<String, Object?>)['\$ref']! as String),
      ];
      expect(references, isNotEmpty);
      for (final uri in references) {
        final answer = await readDocument(cardSchemaClientV1, '$uri');
        expect(answer.statusCode, 200, reason: uri.toString());
        expect(
          (jsonDecode(answer.body) as Map<String, Object?>)['\$id'],
          uri.toString(),
        );
      }
    });

    test('refuses a schema this build does not carry, without a request', () async {
      // A Card names no schema of its own: the catalog is compiled in, and a
      // document this build does not hold is one it cannot validate against.
      await expectLater(
        readDocument(
          cardSchemaClientV1,
          'https://a2ui.org/specification/v0_9/not_here.json',
        ),
        throwsA(isA<http.ClientException>()),
      );
    });

    test('is the client a schema stack is handed inside the zone', () async {
      // What `json_schema_builder` sees: it asks `package:http` for a client
      // while it resolves, and that call has to land on the local one.
      expect(withLocalCardSchemasV1(() => http.Client()), cardSchemaClientV1);
      // Outside the zone, the app's own clients are untouched: this is a zone
      // around the renderer's intake, not a global replacement.
      expect(identical(http.Client(), cardSchemaClientV1), isFalse);
    });
  });
}
