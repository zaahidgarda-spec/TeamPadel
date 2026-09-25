// Deliberately minimal: this exists to catch one specific class of bug —
// two things accidentally given the same name — not to enforce a style
// guide. `no-redeclare` is the one that actually matters: it's exactly what
// would have caught the duplicate `shortPlayerName` function (one taking a
// player object, one taking a string) that silently broke the Court
// Schedule poster in production. `no-unused-vars` is the same idea one step
// removed — a leftover/renamed thing nobody reads anymore.
//
// `no-undef` is intentionally left off for public/app.js: it's one large
// classic script (no bundler, no modules), so every top-level function is a
// script-global calling dozens of others — enabling no-undef there without
// a full browser/global whitelist would drown the two rules that matter in
// false positives. src/*.js (plain Node/CommonJS) gets it, since that
// global set is small and known.
const nodeGlobals = {
  require: "readonly", module: "writable", exports: "writable", process: "readonly",
  __dirname: "readonly", __filename: "readonly", console: "readonly", Buffer: "readonly",
  setInterval: "readonly", clearInterval: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
  global: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly",
  setImmediate: "readonly", clearImmediate: "readonly", AbortController: "readonly",
};

module.exports = [
  {
    files: ["src/**/*.js", "server.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: nodeGlobals },
    rules: {
      "no-redeclare": "error",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["public/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script" },
    rules: {
      "no-redeclare": "error",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
