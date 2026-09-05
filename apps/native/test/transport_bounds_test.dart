import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';

void main() {
  test('JSON transport bounds depth before decoding, including escaped strings and UTF-8', () {
    final sixteen =
        '${List.filled(16, '[').join()}0${List.filled(16, ']').join()}';
    expect(decodeBoundedJson(sixteen), isA<List>());
    expect(() => decodeBoundedJson('[$sixteen]'), throwsFormatException);
    expect(decodeBoundedJson(r'{"text":"[\"{"}'), {'text': '["{'});
    expect(() => decodeBoundedJson('"日"', maxBytes: 4), throwsFormatException);
    expect(() => decodeBoundedJson('}'), throwsFormatException);
  });
}
