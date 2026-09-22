import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "CodeFleet API",
    version: "0.1.0",
    description: "Multi-repository code intelligence API backed by Graphify.",
  },
  tags: [
    { name: "Status", description: "Process and dependency health." },
    { name: "Repositories", description: "Repository index state and graph search." },
  ],
  paths: {
    "/healthz": {
      get: {
        tags: ["Status"],
        summary: "Check process health",
        responses: { "200": { description: "The process can accept requests.", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } },
      },
    },
    "/readyz": {
      get: {
        tags: ["Status"],
        summary: "Check service readiness",
        responses: {
          "200": { description: "SQLite, the data directory, and Graphify are ready.", content: { "application/json": { schema: { $ref: "#/components/schemas/Readiness" } } } },
          "503": { description: "A required dependency is unavailable.", content: { "application/json": { schema: { $ref: "#/components/schemas/Readiness" } } } },
        },
      },
    },
    "/repositories": {
      get: {
        tags: ["Repositories"],
        summary: "List configured repository indexes",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Repository states.", content: { "application/json": { schema: { $ref: "#/components/schemas/RepositoryList" } } } },
          "401": { $ref: "#/components/responses/AuthenticationRequired" },
          "403": { $ref: "#/components/responses/AuthenticationFailed" },
        },
      },
    },
    "/search": {
      post: {
        tags: ["Repositories"],
        summary: "Search repository graphs",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } },
        },
        responses: {
          "200": { description: "At least one repository returned a result.", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } } },
          "400": { $ref: "#/components/responses/InvalidRequest" },
          "401": { $ref: "#/components/responses/AuthenticationRequired" },
          "403": { $ref: "#/components/responses/AuthenticationFailed" },
          "413": { $ref: "#/components/responses/InvalidRequest" },
          "503": { description: "Every selected repository failed.", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchError" } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "API token" },
    },
    responses: {
      InvalidRequest: { description: "The request is invalid.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      AuthenticationRequired: { description: "A Bearer token is required.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      AuthenticationFailed: { description: "The Bearer token is invalid.", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
    },
    schemas: {
      Health: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", const: "ok" } },
      },
      Readiness: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ready", "not_ready"] } },
      },
      Repository: {
        type: "object",
        required: ["id", "branch", "state", "indexedCommit", "indexedAt", "lastError"],
        properties: {
          id: { type: "string" },
          branch: { type: "string" },
          state: { type: "string", enum: ["pending", "syncing", "ready", "degraded", "disabled"] },
          indexedCommit: { type: ["string", "null"] },
          indexedAt: { type: ["string", "null"], format: "date-time" },
          lastError: { type: ["string", "null"] },
        },
      },
      RepositoryList: {
        type: "object",
        required: ["repositories"],
        properties: { repositories: { type: "array", items: { $ref: "#/components/schemas/Repository" } } },
      },
      SearchRequest: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1_000 },
          repositoryIds: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string" } },
        },
      },
      SearchResult: {
        type: "object",
        required: ["repositoryId", "indexedCommit", "indexedAt", "output"],
        properties: {
          repositoryId: { type: "string" },
          indexedCommit: { type: "string" },
          indexedAt: { type: "string", format: "date-time" },
          output: { type: "string" },
        },
      },
      Warning: {
        type: "object",
        required: ["repositoryId", "code", "message"],
        properties: {
          repositoryId: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
      SearchResponse: {
        type: "object",
        required: ["query", "results", "warnings"],
        properties: {
          query: { type: "string" },
          results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
          warnings: { type: "array", items: { $ref: "#/components/schemas/Warning" } },
        },
      },
      Error: {
        type: "object",
        required: ["code", "message", "retryable"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          retryable: { type: "boolean" },
        },
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: { error: { $ref: "#/components/schemas/Error" } },
      },
      SearchError: {
        type: "object",
        required: ["error", "warnings"],
        properties: {
          error: { $ref: "#/components/schemas/Error" },
          warnings: { type: "array", items: { $ref: "#/components/schemas/Warning" } },
        },
      },
    },
  },
} as const;

const require = createRequire(import.meta.url);
const asset = (name: string) => readFileSync(require.resolve(`swagger-ui-dist/${name}`));

export const swaggerUiAssets = new Map<string, Readonly<{ contentType: string; body: Buffer }>>([
  ["/docs/swagger-ui.css", { contentType: "text/css; charset=utf-8", body: asset("swagger-ui.css") }],
  ["/docs/swagger-ui-bundle.js", { contentType: "text/javascript; charset=utf-8", body: asset("swagger-ui-bundle.js") }],
  ["/docs/swagger-ui-standalone-preset.js", { contentType: "text/javascript; charset=utf-8", body: asset("swagger-ui-standalone-preset.js") }],
]);

export const swaggerUiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodeFleet API</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script src="/docs/swagger-ui-standalone-preset.js"></script>
  <script src="/docs/swagger-initializer.js"></script>
</body>
</html>`;

export function swaggerUiInitializer(apiToken: string) {
  return `window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: "StandaloneLayout"
  });
  window.ui.preauthorizeApiKey("bearerAuth", ${JSON.stringify(apiToken)});
};`;
}
