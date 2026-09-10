#!/usr/bin/env node
// Lint the compiled tool definitions for the read-only / token-efficiency
// contract of this server. Run after `npm run build`:
//   node scripts/lint-tool-definitions.mjs
// Exits 1 when any tool:
//   - has a name suggesting a write (create/edit/set/reset/revoke/offboard/...)
//   - lacks annotations.readOnlyHint === true or has destructiveHint !== false
//   - declares CSV columns but does not expose fields / limit / format inputs
//   - references an unknown property in `required` or `rules.oneOf`

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const distPath = resolve(process.cwd(), 'dist/mcp/tool.definitions.js');

let mod;
try {
  mod = require(distPath);
} catch (err) {
  console.error(`Cannot load ${distPath}. Run "npm run build" first.\n${err.message}`);
  process.exit(2);
}

const WRITE_VERBS = /(create|edit|set_|reset|revoke|offboard|disable|enable|delete|remove|add_|run_|exec_|assign|update|patch|put_)/;

let violations = 0;
const fail = (name, msg) => {
  violations += 1;
  console.error(`${name}: ${msg}`);
};

const seen = new Set();
for (const def of mod.TOOL_DEFINITIONS) {
  if (seen.has(def.name)) fail(def.name, 'duplicate tool name');
  seen.add(def.name);
  if (!/^cipp_[a-z0-9_]+$/.test(def.name)) fail(def.name, 'name must be cipp_<snake_case>');
  if (WRITE_VERBS.test(def.name)) fail(def.name, 'name suggests a write operation; this server is read-only');
  if (def.annotations?.readOnlyHint !== true) fail(def.name, 'annotations.readOnlyHint must be true');
  if (def.annotations?.destructiveHint !== false) fail(def.name, 'annotations.destructiveHint must be false');
  const props = def.inputSchema?.properties ?? {};
  if (Array.isArray(def.columns)) {
    for (const key of ['fields', 'limit', 'format']) {
      if (!(key in props)) fail(def.name, `list tool missing "${key}" input`);
    }
  }
  for (const req of def.inputSchema?.required ?? []) {
    if (!(req in props)) fail(def.name, `required "${req}" is not a declared property`);
  }
  for (const group of def.rules?.oneOf ?? []) {
    for (const key of group) if (!(key in props)) fail(def.name, `rules.oneOf references unknown "${key}"`);
  }
  if (!def.description || def.description.length < 20) fail(def.name, 'description too short');
}

if (violations > 0) {
  console.error(`\n${violations} violation(s).`);
  process.exit(1);
}
console.log(`All ${mod.TOOL_DEFINITIONS.length} tools satisfy the read-only / token-efficiency contract.`);
