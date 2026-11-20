# Third-party notices

looot tables uses the [MIT license](LICENSE). Third-party materials retain their own licenses and notices.

## Upstream project

looot tables started as a fork of Enrichable, an MIT-licensed project by Context.dev, imported at its commit 640e58e. The original copyright notice, "Copyright (c) 2026 Enrichable contributors", is kept in [LICENSE](LICENSE) as the MIT license requires.

## Bundled code and fonts

| Material | Location | Source and notice |
| --- | --- | --- |
| IronCalc formula helper metadata | `src/lib/formula-catalog/functions.json` | MIT; the [catalog README](src/lib/formula-catalog/README.md) records the exact upstream commit. Preserve [LICENSE-MIT](src/lib/formula-catalog/LICENSE-MIT) and its served copy at `public/licenses/ironcalc-formula-catalog.txt`. |
| shadcn/ui calendar adaptation | `src/components/ui/calendar.tsx` | MIT; [notice](third-party/shadcn-ui.LICENSE), [upstream](https://github.com/shadcn-ui/ui). |
| ReUI sortable adaptation | `src/components/ui/sortable.tsx` | Copyright 2025 Keenthemes Inc.; MIT; [notice](third-party/reui.LICENSE), [upstream](https://reui.io/components/sortable). |
| shadcn color picker adaptation | `src/components/ui/color-picker.tsx` | Copyright 2025 nightspite; MIT; [notice](third-party/shadcn-color-picker.LICENSE), [upstream](https://github.com/nightspite/shadcn-color-picker). |
| Rethink Sans document fonts | `public/fonts/document/` | Copyright 2022 The Rethink Sans Project Authors; SIL Open Font License 1.1; [notice](public/fonts/document/OFL.txt), [upstream](https://github.com/hans-thiessen/Rethink-Sans). |

The UI also uses Rethink Sans through `next/font/google`. Next.js retrieves and bundles this font during a production build. Its SIL Open Font License notice is included at [Rethink-Sans.OFL.txt](third-party/Rethink-Sans.OFL.txt). Preserve this notice when redistributing generated assets; npm package licenses do not replace font notices.

## Package dependencies

Dependencies and exact resolved versions are recorded in `package-lock.json`. Each package retains its own license, including IronCalc (`@ironcalc/wasm`, MIT OR Apache-2.0). Keep the dependencies' included notices with redistributed packages. This file lists directly bundled materials; it is not a substitute for the dependency license files.

The production dependency audit also identified libvips binaries brought in by Sharp with `LGPL-3.0-or-later` metadata; `@img/sharp-wasm32` declares `Apache-2.0 AND LGPL-3.0-or-later AND MIT`. Review the upstream notices and source/distribution requirements before publishing packaged binaries or container images ([Sharp installation and prebuilt binaries](https://sharp.pixelplumbing.com/install/), [libvips](https://github.com/libvips/libvips)). The `png-js` package omits a license field in its package metadata, but its included `LICENSE` is MIT, copyright 2017 Devon Govett.

## Company and provider assets

`public/companies/` and `public/providers/` contain company/provider names and logos used in previews and integrations. These are third-party brand assets, not original artwork of this project. The project's MIT license does not grant rights to third-party trademarks or imply endorsement.

Forks that redistribute these assets are responsible for confirming they have permission to do so. Attribution alone does not establish permission.
