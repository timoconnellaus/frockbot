/// The card suites, driven against the built app instead of the headless test
/// engine: a real macOS Runner, the bundled Inter face, real rasterisation and
/// real gesture dispatch. Same assertions, so a promise that only the test
/// harness kept — a font the harness fakes, a layout the harness measures —
/// fails here.
///
///   flutter test -d macos integration_test/cards_live.dart
///
/// The component suites only: `cards_test.dart` settles a fake transport on
/// pumped time, which a live engine's real clock never reaches.
library;

import 'package:integration_test/integration_test.dart';

import '../test/cards_data_test.dart' as data;
import '../test/cards_example_test.dart' as example;
import '../test/cards_input_test.dart' as input;
import '../test/cards_links_test.dart' as links;
import '../test/cards_media_test.dart' as media;
import '../test/cards_rich_text_test.dart' as rich_text;
import '../test/cards_structure_test.dart' as structure;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  structure.main();
  data.main();
  rich_text.main();
  media.main();
  input.main();
  links.main();
  example.main();
}
