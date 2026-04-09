/**
 * HTML template generators for the docs dashboard, Swagger UI, and ReDoc pages.
 * Uses inline template literals rather than a template engine.
 */

export interface DocsAssetUrls {
  swaggerJsUrl: string;
  swaggerCssUrl: string;
  swaggerFaviconUrl: string;
  redocJsUrl: string;
  redocFaviconUrl: string;
}

export const DEFAULT_ASSET_URLS: DocsAssetUrls = {
  swaggerJsUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js",
  swaggerCssUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css",
  swaggerFaviconUrl: "https://fastapi.tiangolo.com/img/favicon.png",
  redocJsUrl: "https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js",
  redocFaviconUrl: "https://fastapi.tiangolo.com/img/favicon.png",
};

/**
 * Generate the version-picker dashboard HTML.
 * Lists all available API versions with links to docs.
 */
export function renderDocsDashboard(
  versions: string[],
  docsUrl: string,
): string {
  const rows = versions
    .map((v) => {
      const url = `${docsUrl}?version=${encodeURIComponent(v)}`;
      return `
        <li class="table-row">
          <div class="col col-1">${escapeHtml(v)}</div>
          <div class="col col-2"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div>
        </li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenAPI Contracts</title>
  <meta name="robots" content="noindex">
  <link href="https://fonts.googleapis.com/css?family=Lato" rel="stylesheet">
  <style>
    body { font-family: "Lato", sans-serif; background-color: #f4f4f4; color: #333; margin: 0; padding: 0; }
    .container { max-width: 800px; margin: 50px auto; padding: 20px; background-color: #fff; box-shadow: 0 0 10px rgba(0,0,0,0.1); border-radius: 5px; }
    h2 { font-size: 32px; margin: 0 0 20px; text-align: center; color: #3498db; }
    .responsive-table li { border-radius: 5px; padding: 20px; display: flex; justify-content: space-between; margin-bottom: 20px; background-color: #ecf0f1; box-shadow: 0 2px 5px rgba(0,0,0,0.1); list-style: none; }
    .responsive-table .table-header { background-color: #3498db; font-size: 16px; text-transform: uppercase; letter-spacing: 0.03em; color: #fff; }
    .responsive-table .col-1, .responsive-table .col-2 { flex-basis: 50%; text-align: left; }
    .responsive-table .col-1 { font-weight: bold; }
    .responsive-table .col-2 a { color: black; text-decoration: none; font-weight: bold; }
    ul { padding: 0; margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <h2>OpenAPI Contracts</h2>
    <ul class="responsive-table">
      <li class="table-header">
        <div class="col col-1">Version</div>
        <div class="col col-2">URL</div>
      </li>
      ${rows}
    </ul>
  </div>
</body>
</html>`;
}

/**
 * Generate the Swagger UI HTML for a specific version.
 */
export function renderSwaggerUI(
  openApiUrl: string,
  title: string,
  assets: DocsAssetUrls,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Swagger UI</title>
  <link rel="icon" type="image/png" href="${escapeHtml(assets.swaggerFaviconUrl)}">
  <link rel="stylesheet" href="${escapeHtml(assets.swaggerCssUrl)}">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${escapeHtml(assets.swaggerJsUrl)}"></script>
  <script>
    SwaggerUIBundle({
      url: "${escapeJs(openApiUrl)}",
      dom_id: "#swagger-ui",
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: "StandaloneLayout"
    });
  </script>
</body>
</html>`;
}

/**
 * Generate the ReDoc HTML for a specific version.
 */
export function renderRedocUI(
  openApiUrl: string,
  title: string,
  assets: DocsAssetUrls,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - ReDoc</title>
  <link rel="icon" type="image/png" href="${escapeHtml(assets.redocFaviconUrl)}">
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url="${escapeHtml(openApiUrl)}"></redoc>
  <script src="${escapeHtml(assets.redocJsUrl)}"></script>
</body>
</html>`;
}

/**
 * Escape HTML entities to prevent XSS in template output.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Escape a string for safe use in a JavaScript string literal.
 */
function escapeJs(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
