# Quiz City generated game assets

The runtime files in `generated/` are intentionally not committed. They are selected
from locally licensed source packs by the repository's asset catalogue.

From the repository root:

```bash
npm run assets:check
npm run assets:prepare
```

The first command validates the required pack paths, licenses, JSON, PNG signatures,
and dimensions without writing. The second copies only the approved 1x runtime files and
creates:

- `generated/asset-manifest.json` with hashes, sizes, dimensions, and credits; and
- `generated/THIRD_PARTY_NOTICES.txt` with the required notices.

Use `npm run assets:prepare:optional` only when testing the larger CC0 household
atlases. Those props are not at the Gridwright world scale and are not approved for the
main scene until a visual conversion review passes.

Do not copy the complete source packs into this directory or commit `generated/`. The
Gridwright license permits use in a finished game but prohibits repackaging the assets
as an asset pack.
