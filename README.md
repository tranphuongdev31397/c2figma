# HTML → Figma visual importer

Reusable, dependency-free starter project for turning standalone HTML designs into editable Figma visual scaffolds.

## Direct import into Figma

Build the plugin once:

```bash
npm run plugin
```

In Figma Desktop, import `dist/html-figma-importer/manifest.json` once via **Plugins → Development → Import plugin from manifest…**. Run that plugin, choose an HTML file in its UI, then click **Tạo design trong Figma**. The parsed HTML is converted into editable layers directly; no per-design ZIP download is needed.

For a ready-to-install package, run `npm run plugin:package`. This writes `web/downloads/html-figma-importer.zip`, which can be served by Vercel and downloaded from the web app.

## CLI fallback

```bash
npm test
npm run import -- "/path/to/design.html" --out dist/design
```

The generated `dist/design/manifest.json` remains available for a standalone per-design plugin.

## No-command flow

Double-click `web/index.html`, drag any standalone HTML into the page, then click **Tải plugin Figma (.zip)**. This browser-only fallback remains available; the direct Figma plugin is the shorter workflow.

## Deploy to Vercel

This project is a static site. In Vercel, import the GitHub repository with no build command and no output directory override. `vercel.json` routes `/` to `web/index.html` and `/guide` to the in-app user guide. Before pushing changes to the web download, run `npm run plugin:package` so `web/downloads/html-figma-importer.zip` is current.

## What is reusable

- Extracts page title, CSS custom properties, headings, buttons, labels and status/badge text.
- Generates a Figma plugin with a 1440×900 editable screen, sidebar, header and content rows.
- No dependency or build step.

The current employee design remains the visual reference. Arbitrary future HTML files get a safe scaffold first; add a small mapping in `src/template.js` when a new page has unique layout patterns. This keeps the importer predictable instead of pretending every DOM can become good Figma layers automatically.
