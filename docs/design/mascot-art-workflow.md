# Concept art to seven clean SVG parts

This is the production procedure for the FrockBot bold-sticker characters. The result is a character that looks right assembled **and** consists of complete, clean pieces suitable for later animation. A high image-match score alone is not acceptance.

The working example is [the SVG lab](../../output/flock-svg-rig/README.md), with [current parts and measurements](../../output/flock-svg-rig/parts/README.md). Its browser inspector is `http://127.0.0.1:8794/parts.html` when the local server is running. Animation is a later phase.

## 1. Approve the concept and the anatomy

Generate or draw front-facing, full-body artwork with generous space around the silhouette. Use broad flat colour regions, smooth heavy outlines, two capsule eyes and clear feet. Avoid textures, gradients, tiny fur strands, cast shadows and accessories that obscure attachment points. Inspect at both avatar size and high magnification.

Use the approved [bold-sticker card](../../output/flock-svg-style-cards/02-bold-sticker.png) as the style reference. The [expanded character card](../../output/flock-svg-style-cards/04-expanded-flock-distinct-silhouettes.png) is new concept artwork, not a set of completed vectors. Its [generation prompt](../../output/flock-svg-style-cards/04-expanded-flock-distinct-silhouettes.prompt.txt) records the requested design constraints.

Preserve species-specific silhouettes. Fox, goat, cow, cat and rabbit should read through their body proportions, ears and limbs, rather than sharing sheep fleece. Use wool scallops only where the design calls for wool.

Agree on which features move before tracing. The current contract is:

| Part ID                   | Ownership                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `fur`                     | All wool/hair/body colour, the filled dark face, fixed horns, markings and any fixed tail |
| `eye-left`, `eye-right`   | One complete light capsule each; no surrounding face or dark matte                        |
| `ear-left`, `ear-right`   | The complete ear, its outline and inset colour, including its hidden attachment           |
| `foot-left`, `foot-right` | A complete foot and a long leg shaft extending inside the body                            |

Left and right mean the viewer's left and right. The outer `character` group holds these seven controls. The face stays with the fur; eyes can move independently. A tail or horn that needs independent motion requires a deliberate change to the contract.

**Check exceptions before locking the artwork.** The new Chill and Nudge concepts do not show a separate ear pair. They currently support five visible pieces under this scheme. Either approve a design with ears or explicitly accept that exception; do not invent drawable ears, label empty groups as finished assets, or cut arbitrary wool pieces merely to reach seven. Nudge is the orange blob only, without the loop or accessory behind it. The seated fox, cat and rabbit concepts also show front and rear limbs: decide which pair becomes the two foot controls and which remains fixed in the body, or approve more controls before splitting. Do not silently discard visible anatomy to meet the seven-part count.

## 2. Freeze the reference

1. Save the approved source PNG and its generation provenance. Do not overwrite a prior approved concept.
2. Record its SHA-256 and each character's crop rectangle in a source manifest. Use integer coordinates in source-image pixels: left, top, right, bottom, with right/bottom exclusive.
3. Crop each character without its label, neighbours or card heading. Preserve the full silhouette and some empty margin.
4. Create a foreground mask and inspect it over the reference. Include all dark outlines, feet and ears. Preserve real holes and negative spaces. Exclude the background, labels and ground shadow.
5. Freeze the source, crops and masks before comparing candidates. If approval changes the reference, start a new reference set rather than silently moving the target.

The existing set uses `source.json`, `assets/concept-card.png`, and `{name}-reference.png` / `{name}-mask.png` under `assets/`. A dark closed outline permits an exterior flood fill as an initial mask, but this needs visual checking: off-white fur, enclosed background holes, disconnected details and shadows can defeat simple thresholding. The current mask initializer in `scripts/trace.py` is a starting aid, not a general segmentation guarantee. There is no complete automatic crop-preparation command in this lab.

## 3. Build a smooth likeness master

Produce the unsplit SVG first, so likeness and anatomy can be reviewed separately.

- Reduce the raster to a small deliberate palette. Seven colours worked for the original three characters; this is a palette size, unrelated to the seven anatomical parts.
- Build overlapping colour regions, darkest first. Independent abutting traces can leave hairline gaps.
- Remove isolated raster noise from candidate regions and fit smooth cubic Bézier curves. Do not smooth, blur or recolour the locked comparison reference.
- Trace the outside silhouette separately. A silhouette clip is acceptable in this **intermediate master**. The final separated assets must contain their own complete geometry.
- Inspect the silhouette, internal contours, eye shape and thick outline at several scales. Repair jitter, flat corners, tiny islands and accidental cut-ins before proceeding.
- Keep actual vector paths. Embedding the reference PNG inside an SVG is not vector conversion.

The working method is `scripts/trace_clean.py`: deterministic palette clustering, cumulative colour masks, a 3×3 median cleanup on candidate colour masks, and Potrace cubic fitting at tolerance 0.3. Its paths arrive in a scaled, flipped coordinate system; resolve the SVG transforms into the character's viewBox coordinates before anatomical geometry work. Do not apply the existing coordinate conversion blindly to an SVG from another exporter.

Render each candidate at the native crop dimensions, compare it, and preserve its revision. After approval, copy the selected SVGs to the master `svg/` directory and make a scoped Git checkpoint. The existing pre-split checkpoint is `ad85697c70`. Keep those masters unchanged during the split.

## 4. Rebuild anatomy, not cutouts

Draw a simple ownership and stacking map first. Feet go behind the body. Ears can be behind the body, as in Pixel and Guardian, or in front, as in Sunny. Eyes go last. The final SVG should have seven sibling groups, each containing only its own geometry.

### Fur/body: remove every attachment remnant

The original whole-character silhouette contains the ears and feet. It therefore cannot be reused as the fur outline.

1. Find the actual main wool/hair colour contours and identify the body components deliberately. Pixel has two substantial pink outer components; choosing only the largest loses its upper hair.
2. Form a continuous body silhouette from those contours. Fill the face area in the dark base. Include fixed horns or other fixed features in this group.
3. Rebuild the outside ink edge around the body contours with smooth rounded geometry. The current characters use a nine-unit outward expansion at their roughly 500×615 native size. Choose the outline width for the artwork; nine is not a universal constant.
4. Do not intersect that rebuilt edge with the original ear/foot silhouette. That operation can put the old attachment stubs back into the fur.
5. Remove leftover ear and foot colour components, including their antialiased fringes, from the body's colour layers. Removing only their main black shape leaves gray slivers behind.
6. Preserve the fixed face and internal fur lines. Fill the wool behind foreground ears, as with Sunny, so hiding an ear reveals continuous yellow wool rather than a hole or a dark ear-shaped patch.

Region boxes may help locate a component. They must not become the final cut boundary. Selecting the largest component _after_ clipping a box can select a piece of the body instead of the intended ear; inspect the full component, its bounds and its ownership.

### Eyes: complete capsules

Draw smooth closed capsules with continuous joins and the intended width, height and spacing. Remove the previous eyes from the body down to its solid face fill. Do not carry along a rectangular black background, edge fringe or fragments of another colour. Tracing only the lightest raster palette can produce chopped capsule corners; rebuild the curve when necessary.

### Ears: complete leaves and hidden roots

Retain or redraw the visible ear silhouette and its inset colour. Continue the ear underneath the body to a smooth, closed attachment shape. Keep the entire inset inside its outline. The hidden root should not end at an arbitrary crop edge. Put the pivot inside that buried root and inspect the ear without the body covering it.

### Feet: long buried legs

Preserve the visible sole and resting position, then continue the shaft substantially upward inside the fur. A cropped hoof with a small cap is insufficient: lifting, rocking or moving the body will expose the cap or a gap.

- Make each shaft one smooth, closed shape with a rounded upper end.
- Extend upward, rather than making the character visibly taller at rest.
- Put the leg before the fur in drawing order. Its upper section is hidden by real body geometry.
- Raise the pivot to the buried joint, rather than rotating around the visible ankle or sole.
- Keep the foot's inset colour entirely inside its outline.

In the current set, the shafts extend roughly 60–70 additional viewBox units upward. The completed feet/legs are about 135–152 units tall, and their pivots are at y=475. These dimensions are examples for this artwork, not defaults for every new animal.

## 5. Inspect the pieces independently

Use a checkerboard and a plain contrasting background. The inspector must show the original master, the assembly, all seven individual pieces and a larger selected-piece view. Provide hide/show controls and a view that fades the fur to reveal the buried legs.

Accept the geometry only when these checks pass:

- **Fur alone:** a continuous deliberate outline, with no foot cuffs, gray slivers, ear fragments, rectangular bites, spikes or leftover outlines from removed features.
- **Eyes hidden:** the face remains solid. **Foreground ears hidden:** their backing fur remains filled.
- **Each attachment alone:** a complete, closed, smoothly joined shape. No clipped tops, stray islands, neighbouring colours or bitmap tiles.
- **Assembly:** correct stacking, no holes or accidental seams, and the intended resting likeness.
- **Faded fur:** long shafts and their high pivots are visible inside the body.
- **Enlarged view:** curves remain smooth; fitting thousands of noisy points does not count as finished vector work.

Resolve visual defects even when the image-comparison score is high. Resting overlap can conceal badly constructed pieces.

## 6. Check overlap in static poses

Before making an animation, test the intended travel and rotation around the stored pivots. Keep the body fixed, move each leg, and verify that its upper attachment remains buried. Also inspect the visible result for collisions, odd silhouette changes and undesirable contact with nearby features.

The current `scripts/check_leg_overlap.py` tests each of six legs in nine combinations: rotation −12°, 0° or +12° with vertical offsets −20, 0 or +20. It intersects the upper leg cap with the body and requires zero exposed cap area, within numerical tolerance. It also checks that the feet are long enough and appear before the fur in drawing order. Results are saved in `parts/overlap.json`.

That is evidence for those **54 sampled static poses**, not proof of every intermediate pose, a finished gait, ear motion, lateral travel or body deformation. Broaden the check when the intended movement changes. No animation timeline is needed for this geometry review.

## 7. Measure likeness separately from construction quality

Measure two comparisons and label them clearly:

1. **Candidate versus locked raster concept:** the original likeness target.
2. **Split assembly versus approved SVG master:** how much the anatomy work changed the approved resting artwork.

The lab uses the minimum of RGB agreement, local RGB SSIM and edge F1. SSIM uses 11×11 windows. Edges use the fixed RGB Sobel threshold of 40 and a one-source-pixel match tolerance. The measurement domain is the union of reference foreground and candidate foreground; empty background earns no credit. Silhouette overlap is reported separately.

Keep native dimensions, alignment, masks, thresholds and reference bytes fixed. Do not register, blur or change the scoring method to make a candidate pass. The concept target is greater than 95% on all three components. This is a defined measurement, not a universal percentage of artistic accuracy. Keep blank, shifted and recoloured negative controls to check that the metric detects meaningful failure.

If cleanup changes the score, report the new score honestly and inspect the difference map. Do not retain a visible remnant just to preserve a pixel-match score.

## 8. Export and verify the handoff

For every character, deliver:

- An assembled SVG with the seven named groups, stable IDs, `data-part` values and pivots.
- Seven standalone SVGs with complete paths and tight padded viewBoxes. Preserve the assembly coordinate system in those viewBoxes so placement is recoverable.
- A JSON manifest containing part names, drawing order, bounds, pivots, source hash and individual filenames.
- An isolated-parts contact sheet, resting comparison and overlap results.
- A current downloadable archive and browser inspector.

Final parts must not depend on clipping masks, external images, embedded rasters, scripts or animation elements. Validate unique IDs, expected part names, nonempty bounds, closed attachment paths, contained insets, source hashes and standalone exports. Re-render the files actually being delivered. Verify that the measured SVG hash matches the downloaded SVG and rebuild the archive after the final edit.

## Current toolchain and commands

Run from the repository root. Dependencies are Python 3.12 with `fonttools`, `skia-pathops`, Pillow and NumPy; Potrace; and Node with Sharp. The current geometry imports use `/private/tmp/flock-parts-deps`, and rendering points to the local bundled Sharp runtime. Set up equivalent dependencies and update those paths on another machine.

For a **new candidate of the existing three masters**, after the reference crops and masks exist, choose an unused revision name:

```sh
python3 output/flock-svg-rig/scripts/trace_clean.py --version review-master-01 --colors 7
node output/flock-svg-rig/scripts/render.cjs review-master-01
python3 output/flock-svg-rig/scripts/measure.py review-master-01 'Master review 01'
```

The following rebuilds the current separated assets from the approved masters:

```sh
/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 output/flock-svg-rig/scripts/split_parts.py
node output/flock-svg-rig/scripts/render_parts.cjs
python3 output/flock-svg-rig/scripts/validate_parts.py
/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 output/flock-svg-rig/scripts/check_leg_overlap.py
python3 output/flock-svg-rig/scripts/parts_atlas.py
```

To measure a new split revision, copy its three assembled SVGs and corresponding fresh `-render.png` files into a new `versions/<revision>/` directory, then call `scripts/measure.py <revision> '<label>'`. Do not reuse an old revision name for a new approved state. Update the notes and archive to the new measurement. `parts/validation.json` is the master comparison, not the concept comparison.

To serve the inspector, if its server is not already running:

```sh
python3 -m http.server 8794 --bind 127.0.0.1 --directory output/flock-svg-rig
```

### Extending this to new characters

The scripts currently name Guardian, Pixel and Sunny explicitly and contain artwork-specific palette indices, contours, region boxes, ear geometry, foot curves and pivots. They are **not** a general one-command separator. For each new character, prepare its reference data, define its actual anatomy, extend the character lists and geometry configuration, and repeat all visual and overlap checks. Use a separate reference set for the expanded concept card so the approved original reference stays intact.

Keep colours, markings and fixed features inside their owning part. In particular, fox/cat tails and goat/cow horns remain in `fur` under the seven-control contract. Do not reuse the original sheep's palette indices or anatomical coordinates merely because the new artwork has the same style.
