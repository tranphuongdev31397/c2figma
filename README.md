# HTML → Figma visual importer

Reusable, dependency-free tool for turning standalone HTML designs into editable Figma visual layers.

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

The direct importer is the recommended path because it captures the HTML after it has rendered. The CLI still writes the extracted metadata for inspection.

## No-command flow

Open `web/index.html`, drag any standalone HTML into the page, then click **Tải theo HTML (.zip)**. The ZIP contains the captured scene and a standalone plugin.

## Deploy to Vercel

This project is a static site. In Vercel, import the GitHub repository with no build command and no output directory override. `vercel.json` routes `/` to `web/index.html` and `/guide` to the in-app user guide. Before pushing changes to the web download, run `npm run plugin:package` so `web/downloads/html-figma-importer.zip` is current.

## What is reusable

- Runs the supplied HTML in a sandboxed preview and captures a 1440×900 scene graph.
- Generates editable Figma frames and text layers from the rendered DOM.
- No dependency or build step.

The current employee and warehouse screens are used as parity fixtures. Complex CSS still needs explicit support when it cannot be represented by native Figma frame/text properties.
