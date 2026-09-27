# Connector marks

Connected-app marks (one per app in `app/connect/apps.generated.ts`, named
by its slug) are each app's own brand mark, rasterised to 192 or 128 px. An
app whose published logo is empty has none, and the host draws a letter tile.

Catalog model marks are resized from [Lobe Icons](https://github.com/lobehub/lobe-icons)
`@lobehub/icons-static-png` 1.94.0 (MIT). Refresh with
`python3 scripts/sync-connector-icons.py`. Brands remain their owners';
the files identify the provider on the Marketplace card.
