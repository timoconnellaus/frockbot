# The flock — character studio

Eleven individually rigged vector characters: Pixel, Guardian, Sunny, Chill,
Nudge, Fox, Dog, Goat, Cow, Cat and Rabbit. The cast and Dog's one-ear-up design
are approved and integrated locally into the Flutter app for product review.

## Try the cast

Serve the repository's `output` directory and open `/flock-rive-animation/`.
The current local URL is http://127.0.0.1:8795/flock-rive-animation/.

The thumbnail switcher preserves activity and feeling. Each character starts
with its own original palette; swatches and the colour picker change the current
instance. Both preview sizes run the same native `.riv` file independently.
The artwork has a transparent background, including a soft ground shadow.

| Character | Motion and anatomy                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pixel     | Original seven-part rig: small ear flicks, breathing and a light bounce.                                                                                                                    |
| Guardian  | Seven parts; smaller, slower gestures and a grounded celebration.                                                                                                                           |
| Sunny     | Seven parts; buoyant breathing and an energetic celebration.                                                                                                                                |
| Chill     | Five parts; continuous body, eyes and feet. Flowing sway and hover wobble.                                                                                                                  |
| Nudge     | Five parts; body bounce and encouraging lean. No rear loop or accessory.                                                                                                                    |
| Fox       | Eleven parts; seated body, head, haunches, forepaws, ears, eyes and tail.                                                                                                                   |
| Dog       | Eleven parts; one raised ear and one folded ear, separate head, tail, forepaws and rear haunches. A seated pose with an alert ear twitch, delayed folded-ear flick, head tilt and tail wag. |
| Goat      | Nine parts; planted hooves, head nods, ears, eyes and a small tail flick.                                                                                                                   |
| Cow       | Eleven parts; planted hooves, slow sway, tail with following tip, and horns.                                                                                                                |
| Cat       | Ten parts; seated body, head, ears, eyes, tail, feet and whiskers.                                                                                                                          |
| Rabbit    | Ten parts; seated body, head, ears, eyes, haunches and tapping hind feet.                                                                                                                   |

## Runtime contract

Each character's `rig/contract.json` is the authority for names and defaults.
The artboard, state machine and view model use the capitalized character name.
All characters share these properties:

- `activity`: 0 idle, 1 thinking, 2 working, 3 needs attention, 4 success, 5 still activity.
- `emotion`: 0 neutral, 1 excited, 2 sad, 3 tired, 4 curious, 5 content, 6 surprised, 7 uncertain.
- `lookX`, `lookY`: normalized gaze from −1 to 1. The host smooths pointer movement.
- `hovered`: entering plays a greeting once; leaving re-arms it.
- `primary`, `shade`, `eyeColor`: colour properties. Markings and outlines retain their colours.
- `reducedMotion`: holds a still neutral pose, overriding animated expressions.

The preview temporarily selects success plus excited for 2.6 seconds, then
restores the previous activity and emotion. The Flutter adapter must implement
that restoration too. Ambient movement currently repeats every eight seconds.
Playback uses the local official Rive canvas runtime 2.42.1 from the Pixel folder.

## From concept to separated artwork

1. Freeze the source image and record its SHA-256 and crop coordinates in
   `source.json`. Seven new animals use the expanded silhouette concept card.
   Dog uses the selected **D — one ear up** design from the eyes-only dog study;
   its source override and crop are recorded separately. Guardian and Sunny use
   the already approved separated SVGs.
2. Choose anatomical parts for the intended movement. Seated feet pivot at the
   heel; ears pivot at their root; heads pivot at the neck; tails pivot at the rump.
   Do not add empty parts to enforce a uniform count.
3. Draw complete closed silhouettes, including the anatomy hidden behind the
   body. Keep body outlines free of leftover ear or foot pixels. Draw markings
   as clean vector shapes owned by the part they belong to. The new non-wool
   animals use deliberately drawn Bézier outlines and markings; Chill and Nudge
   also use smoothed colour-region tracing for their continuous bodies.
4. Keep every part in the same 457 × 615 coordinate system. Record its pivot,
   bounds, drawing order, palette role and completion status in the character
   JSON. Assemble the SVG and inspect it at large and avatar sizes.
5. Extract standalone part SVGs without changing their geometry. Extend hidden
   roots far enough that the intended rotations do not reveal cuts. Preserve
   painter order, especially seated haunches, forepaws and overlapping ears.
6. Convert each SVG curve into native Rive vertices. Parent transforms separate
   body activity, emotion, head movement, eye expression, gaze, blinking and
   appendages. Standing feet sit outside upper-body breathing transforms.
7. Use a species motion profile. Check rest, extreme gestures, activity/emotion
   combinations, pointer gaze, hover, recolouring and still mode in the actual
   Rive renderer. Review the contact sheets and studio before artistic sign-off.

The new eight designs are cleaned vector interpretations of the concept.
No claim of 95% concept-art likeness is made for them. Rive-to-SVG conversion
agreement is a separate, narrower measurement.

## Rebuild and verify

Authoring sources are `scripts/prepare_art.py`, `scripts/prepare_dog.py`, `scripts/normalize_existing.py`
and `scripts/build_rig.py`. Generated `scene.rml` files are editable, but a rebuild
replaces them. The approved source SVGs are read without modification.

Dependencies: Python with Pillow, NumPy, FontTools and skia-pathops; Potrace;
official Rive CLI 1.0.3 at `~/.rive/bin/rive`. The current machine also loads
FontTools and pathops from `/private/tmp/flock-parts-deps`; install those packages
normally on another machine. SVG reference PNGs are rendered with Sharp.

```sh
python3 output/flock-rive-animation/scripts/prepare_art.py
python3 output/flock-rive-animation/scripts/normalize_existing.py
python3 output/flock-rive-animation/scripts/build_all.py
node output/flock-rive-animation/scripts/render_svg.cjs
python3 output/flock-rive-animation/scripts/verify_renders.py
python3 output/flock-rive-animation/scripts/package_cast.py
```

Native screenshots require access to macOS graphics. `build-report.json` records
Rive inspection results. `verification.json` records real render checks, with
contact sheets under each character's `rig/build/verification/`. The neutral
agreement score compares source SVG pixels with a native Rive screenshot against
the same background. It measures conversion fidelity, not motion quality,
concept likeness or every possible transition. Flutter device playback remains
untested.

The downloadable ZIP contains all eleven runtime assets, SVGs, contracts and
editable Rive scene sources. The original Pixel project remains separate.

### Dog review

The one-ear-up concept and corrected line work are approved. `prepare_art.py` invokes the dedicated dog
builder, so a full rebuild preserves this choice. To rebuild and check only Dog:

```sh
python3 output/flock-rive-animation/scripts/prepare_dog.py
python3 output/flock-rive-animation/scripts/build_all.py dog
node output/flock-rive-animation/scripts/render_svg.cjs
python3 output/flock-rive-animation/scripts/verify_renders.py dog
```

The dog check covers all 32 activity/emotion combinations; `verification.json`
records current resting RGB agreement between its separated SVG and Rive render.
That is conversion fidelity; concept likeness and the quality of motion remain
visual review decisions. The studio includes the selected concept for reference.
