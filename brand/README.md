# Brand assets

| File | Use |
|---|---|
| `x-banner.png` | X / Twitter header — 1500×500 |
| `x-banner@2x.png` | the same at 3000×1000, for retina |
| `x-banner.svg` | the source. Edit this, not the PNGs |
| `logo-256/512/1024.png` | the mark, transparent background |
| `logo-512-on-ink.png` | the mark on `#060606`, for placement on light surfaces |

The mark itself lives at [`../frontend/public/logo.svg`](../frontend/public/logo.svg) — that
one file is also the favicon and the header mark, so it is the single source
of truth. Everything here is generated from it.

## Regenerating

The banner sets its headline in **Anton** and its label in **Geist Mono**. Both
come from the `@fontsource` packages already installed in `frontend/`, so the
renderer has to be pointed at those files — a plain SVG-to-PNG conversion in a
browser or an online tool will silently fall back to a default face and the
banner will not look like the app.

```bash
npm --prefix frontend install
npx --yes @resvg/resvg-js-cli brand/x-banner.svg brand/x-banner.png --width 1500 --font-file frontend/node_modules/@fontsource/anton/files/anton-latin-400-normal.woff --font-file frontend/node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff
```

## X safe zones

The layout is built around them, and the rendered PNG was checked against them
pixel by pixel:

- **Avatar** — the profile picture covers the bottom-left corner. The bottom-left
  220×220 is empty.
- **Mobile crop** — the top and bottom are cut on narrow screens. Everything sits
  inside `y 70…430`; measured content runs `y 117…377`.
- **Side margins** — content runs `x 349…1406`, leaving 349px left and 94px right.

Move anything and re-check before uploading.
