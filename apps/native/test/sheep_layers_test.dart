import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/ui/sheep_layers.dart';

void main() {
  // Fixtures are what `sheepLayerIds` in packages/plugin-flock/src/shared.ts
  // returns for the same recipes, so a Bot is the same sheep on the web and
  // in the app.
  test(
    'a look stacks background, canonical, then each choice with its parents',
    () {
      expect(
        sheepLayerIds(
          const SheepLook(
            background: 'electric-blue',
            upper: 'ranger-fedora-feather',
            middle: 'rose-heart-sunglasses',
            lower: 'lower-neutral',
          ),
        ),
        [
          'background-electric-blue',
          'canonical',
          'forest-ranger-fedora',
          'ranger-fedora-feather',
          'rose-heart-sunglasses',
        ],
      );
    },
  );

  test('the plain look is the background and the canonical sheep', () {
    expect(sheepLayerIds(SheepLook.plain), [
      'background-hot-pink',
      'canonical',
    ]);
  });

  test('an unknown background falls back to the first one', () {
    expect(
      sheepLayerIds(
        const SheepLook(
          background: 'colour-from-the-future',
          upper: 'upper-neutral',
          middle: 'middle-neutral',
          lower: 'lower-neutral',
        ),
      ),
      ['background-hot-pink', 'canonical'],
    );
  });

  test('a layer the app does not know is skipped, not drawn as a hole', () {
    expect(
      sheepLayerIds(
        const SheepLook(
          background: 'hot-pink',
          upper: 'hat-from-the-future',
          middle: 'middle-neutral',
          lower: 'lower-neutral',
        ),
      ),
      ['background-hot-pink', 'canonical'],
    );
  });
}
