# Seven-part sheep artwork

For the complete repeatable workflow, see [Concept art to seven clean SVG parts](../../../docs/design/mascot-art-workflow.md).

The approved, unsplit masters remain at checkpoint `ad85697c70`. This revision replaces the earlier fragmented split with seven complete pieces per character. No animation has been added.

## Review

Open `http://127.0.0.1:8794/parts.html`. The checkpoint and assembled character appear side by side. The **All seven pieces** gallery shows every asset independently. Select a piece to enlarge it, hide/show pieces, or use **Separate pieces** to inspect the overlaps.

Each character has:

- Left and right eyes: smooth closed Bézier capsules.
- Left and right ears: complete closed outlines with an inset colour shape.
- Left and right feet: rounded hidden roots, the approved visible sole curves, and an inset colour shape.
- Fur/body: continuous wool or hair, the filled face, and Guardian’s fixed horns.

Left/right means the viewer’s left/right. Every part has a unique ID, `data-part` name and suggested pivot. The JSON manifest records drawing order, bounds, pivots, inspection offsets and individual SVG filenames. The `character` group moves the whole assembly.

The assembled SVGs contain seven sibling groups with actual closed vector paths. They contain no clipping masks, embedded raster images or duplicated complete characters. Ears and feet extend under the fur. Hiding the eyes reveals a solid face; Sunny’s wool is filled behind its ears. The body outline is rebuilt directly from the wool contours, so it includes no fragments of the original foot or ear outlines. Gray attachment remnants are removed from the fur’s colour layers. Leg shafts extend roughly 60–70 additional units upward into the body, with pivots raised to y=475; their visible soles remain in place.

## Files

- `{character}.svg`: assembled, named groups in their resting positions.
- `{character}.json`: coordinates and layer metadata.
- `{character}/{part}.svg`: each of the seven pieces, with a tight padded viewBox retaining the assembly coordinates.
- `{character}-atlas.svg`: a labelled contact sheet for inspecting the pieces.
- `validation.json`: measured resting comparison against the checkpoint.

## Measured likeness

| Character | Split versus checkpoint | Split versus locked concept |
| --------- | ----------------------: | --------------------------: |
| Guardian  |                  99.12% |                      96.90% |
| Pixel     |                  99.46% |                      96.12% |
| Sunny     |                  99.36% |                      95.09% |

These are the minimum of RGB agreement, local SSIM and edge F1 under the existing fixed comparison. The original concept, crops, foreground masks and scoring method are unchanged. Concept measurements are in `versions/v10-cleanroots/metrics.json`. A likeness score does not establish standalone asset quality or suitability for a particular movement.

Use **See hidden legs** in the inspector to fade the fur and inspect the buried shafts. All six legs have been checked in nine static poses each: rotations of −12°, 0° and +12°, combined with vertical offsets of −20, 0 and +20. Every upper leg cap remains fully covered by the body in those poses; `overlap.json` records the results. This does not validate a complete gait.

Hidden anatomy is inferred from a single front view. The seven pieces are ready for static review; pivot positions and overlap depth should be checked against the chosen movement range when animation begins.

## Reproduce

Python 3.12 dependencies: `fonttools`, `skia-pathops`, Pillow and NumPy. The builder currently finds the geometry dependencies at `/private/tmp/flock-parts-deps`; rendering uses the bundled local Sharp installation.

From the project root:

```sh
/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 output/flock-svg-rig/scripts/split_parts.py
node output/flock-svg-rig/scripts/render_parts.cjs
python3 output/flock-svg-rig/scripts/validate_parts.py
/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 output/flock-svg-rig/scripts/check_leg_overlap.py
```

Validation checks the master hashes, unique IDs, exactly seven named parts, complete closed eye/ear/foot paths, standalone exports and the absence of clipping masks, raster images, scripts and animation. The rest comparison records the actual effect of the redraw. The fixed original-concept target remains above 95% for each character.
