# Flock — bold-sticker SVG masters

Final artwork: `svg/guardian.svg`, `svg/pixel.svg`, `svg/sunny.svg`.

Revision 07 replaces noisy traces with smooth cubic Bézier boundaries. Each SVG has a transparent background, a responsive viewBox, named colour groups, accessible title, and actual vector paths. No bitmap, external image, font, or filter is required. These are likeness masters grouped by colour; anatomical layers for animation or a DiceBear parts generator are a separate next step.

| Character | Overall | RGB agreement | Local SSIM | Edge F1 |    Size |
| --------- | ------: | ------------: | ---------: | ------: | ------: |
| Guardian  |  97.57% |        98.97% |     97.57% |  99.81% | 30.5 KB |
| Pixel     |  96.64% |        98.31% |     96.64% |  99.83% | 31.7 KB |
| Sunny     |  95.30% |        98.51% |     95.30% |  99.94% | 22.9 KB |

## Inspect

Serve this directory with `python3 -m http.server 8794 --bind 127.0.0.1`, then open http://127.0.0.1:8794/.

The lab includes side-by-side artwork, a variable-opacity overlay, enlarged detail, transparency checking, difference maps, SVG downloads, and revision history. It reloads the report automatically. Historical failures are preserved.

## Fixed comparison

`assets/concept-card.png` is the locked generated bold-sticker concept, not the earlier inspiration sheet. Its SHA-256 and exact crops are recorded in `source.json`. Reference crops and foreground masks were fixed before refinement. The final trace does not modify them.

The comparison uses the native crop dimensions. It composites both images onto the same warm background, computes metrics over the union of the fixed foreground mask and candidate alpha mask, and excludes the empty card and labels. There is no alignment correction, reference blur, or background credit.

- RGB agreement is 100 × (1 − mean absolute RGB error / 255).
- SSIM uses local 11 × 11 uniform windows, RGB channel averaging, standard constants 0.01 and 0.03, and the foreground union for aggregation.
- Edge F1 uses RGB Sobel gradients, threshold 40, and one-source-pixel matching tolerance.
- Overall is the **minimum** of these three scores. Every component must exceed 95%.
- Silhouette IoU is displayed separately.
- Difference maps amplify RGB error by six.

This is a defined image-comparison score, not a universal percentage of perceptual accuracy. The concept contains subtle raster texture; the final SVGs use clean colour regions. The result closely matches shapes, outlines, colours and features, but is not mathematically pixel-identical.

`metric-controls.json` records sanity checks: a perfect reference scores 100%, a blank image 0%, a 12-pixel displacement 28.76%, and recolouring Pixel cyan 71.56%. These checks alter metric input images only and are excluded from revision history.

## Reproduce the final revision

Dependencies: Python with Pillow and NumPy, Potrace 1.16, Node with Sharp. `render.cjs` currently points to the bundled local Sharp installation; change its import if running elsewhere.

From the project root:

```sh
python3 output/flock-svg-rig/scripts/trace_clean.py --version v7 --colors 7
node output/flock-svg-rig/scripts/render.cjs v7
python3 output/flock-svg-rig/scripts/measure.py v7 '07 · Smooth Bézier outlines'
python3 output/flock-svg-rig/scripts/check_metrics.py
```

The final method clusters foreground colours deterministically, forms overlapping cumulative colour masks, removes isolated boundary noise, and fits cubic Bézier paths with Potrace. A separately fitted silhouette clips all layers. This avoids pinholes between independently traced colour regions.

The VTracer experiments are retained for provenance but are not needed to reproduce the final SVGs.
