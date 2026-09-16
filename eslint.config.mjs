import boundaries from "eslint-plugin-boundaries";
import prettierConfig from "eslint-config-prettier";
import tsParser from "@typescript-eslint/parser";

/**
 * Mechanically enforced dependency boundaries (eslint-plugin-boundaries v5).
 *
 * Dependency direction (one-way, no cycles):
 *
 *   contracts  <-  packages  <-  services  <-  apps
 *
 * Stratifit Media (public app) may consume public-safe shared contracts and
 * authorized public-facing services, but must never directly access internal
 * production infrastructure: compute, AI model internals, workflow runtimes,
 * database, storage, or the production engine — anything RunPod/ComfyUI/
 * worker-specific. Future public-safe services (audience, social graph,
 * likes, comments, follows, sharing, messaging, notifications, search,
 * recommendations, analytics) are NOT restricted by this rule: new public-safe
 * elements can be added to `public-package`/`public-service` without touching
 * the Media rule.
 */

const elementTypes = [
  { type: "contracts", pattern: "packages/contracts/**", mode: "full" },
  // Internal production infrastructure — forbidden to the public app.
  {
    type: "internal-package",
    pattern: "packages/{ai,compute,workflows,database,storage}/**",
    mode: "full",
  },
  // Public-safe shared packages (identity rules, UI primitives).
  { type: "public-package", pattern: "packages/{ui,auth,permissions,events}/**", mode: "full" },
  // Production domain — internal only. Publishing must NOT import it.
  { type: "internal-service", pattern: "services/production-engine/**", mode: "full" },
  // Public-safe domain services (published-content read API today).
  { type: "public-service", pattern: "services/publishing-engine/**", mode: "full" },
  { type: "control-app", pattern: "apps/stratifit-control/**", mode: "full" },
  { type: "media-app", pattern: "apps/stratifit-media/**", mode: "full" },
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.config.mjs",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": elementTypes,
      // Resolve workspace bare specifiers (e.g. @stratifit/compute -> its source
      // entry) so the element-type rules can classify them. The resolver works
      // via tsconfig paths/workspace node_modules links.
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["tsconfig.base.json", "apps/*/tsconfig.json", "packages/*/tsconfig.json", "services/*/tsconfig.json"],
        },
      },
      // Patterns in "boundaries/elements" are matched relative to this root.
      "boundaries/root-path": import.meta.dirname,
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // contracts depend on nothing internal.
            { from: "contracts", allow: ["contracts"] },
            // Internal infrastructure packages may use contracts and other packages.
            {
              from: "internal-package",
              allow: ["contracts", "internal-package", "public-package"],
            },
            // Public-safe packages may use contracts and each other.
            {
              from: "public-package",
              allow: ["contracts", "public-package", "internal-package"],
            },
            // Production engine (internal): may use all packages; never the reverse.
            {
              from: "internal-service",
              allow: ["contracts", "internal-package", "public-package", "internal-service"],
            },
            // Public-safe services: contracts + packages, but NOT the production
            // engine (publishing stays separate from production).
            {
              from: "public-service",
              allow: ["contracts", "public-package", "internal-package", "public-service"],
            },
            // Control (internal app) may access authorized internal capabilities.
            {
              from: "control-app",
              allow: [
                "contracts",
                "internal-package",
                "public-package",
                "internal-service",
                "public-service",
                "control-app",
              ],
            },
            // Media (public app): blocklist of internal production infrastructure.
            // Self-imports are allowed; disallow takes precedence over allow.
            {
              from: "media-app",
              allow: ["contracts", "public-package", "public-service", "media-app"],
              disallow: ["internal-package", "internal-service"],
              message:
                "Stratifit Media must not access internal production infrastructure (compute, AI, workflows, database, storage, production-engine).",
            },
          ],
        },
      ],
      "boundaries/external": "off",
    },
  },
  prettierConfig,
];
