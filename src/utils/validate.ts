// Input validation for CIPP MCP tool calls.
//
// The MCP SDK does not enforce a tool's inputSchema, so a missing
// `tenantFilter` used to reach CIPP and come back as an empty list. Every
// call is now validated here before dispatch: JSON-Schema `required`, `type`
// and `enum` are enforced through zod, and each tool can add
// "at least one of these filter groups" and "AllTenants not allowed" rules
// so oversized, unfiltered queries are rejected with a helpful message
// instead of flooding the context window.

import { z, ZodTypeAny } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDefinition } from '../mcp/tool.definitions.js';

/** Per-tool rules that JSON Schema alone cannot express. */
export interface ToolRules {
  /**
   * Filter groups. The call must satisfy at least one group, where a group
   * is satisfied when every listed argument is present.
   * e.g. `[['userId'], ['searchField', 'searchValue']]`
   */
  oneOf?: string[][];
  /** Argument names whose value may not be `AllTenants` (case-insensitive). */
  rejectAllTenants?: string[];
}

type JsonSchemaProp = {
  type?: string;
  enum?: string[];
  items?: { type?: string };
};

function schemaForProp(prop: JsonSchemaProp): ZodTypeAny {
  if (prop.enum && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]);
  }
  switch (prop.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      // Accept numeric strings: some clients serialise every argument as text.
      return z.coerce.number();
    case 'boolean':
      return z.preprocess((v) => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        return v;
      }, z.boolean());
    case 'array':
      return z.array(prop.items?.type === 'string' ? z.string() : z.any());
    case 'object':
      return z.record(z.any());
    default:
      return z.any();
  }
}

/** Drop arguments a client sent as null / undefined / empty string so they count as absent. */
function pruneEmpty(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

const schemaCache = new WeakMap<McpToolDefinition, z.ZodObject<Record<string, ZodTypeAny>>>();

function buildSchema(def: McpToolDefinition): z.ZodObject<Record<string, ZodTypeAny>> {
  const cached = schemaCache.get(def);
  if (cached) return cached;
  const required = new Set(def.inputSchema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(def.inputSchema.properties)) {
    const base = schemaForProp(prop as JsonSchemaProp);
    shape[name] = required.has(name) ? base : base.optional();
  }
  // Unknown keys are stripped rather than rejected: clients occasionally add
  // extras, and dropping them is harmless because every CIPP param we send is
  // named explicitly in the service layer.
  const schema = z.object(shape);
  schemaCache.set(def, schema);
  return schema;
}

/**
 * Validate and normalise the arguments for a tool call.
 *
 * @throws {McpError} `InvalidParams` describing exactly what is missing or wrong.
 */
export function validateArgs(
  def: McpToolDefinition,
  rawArgs: Record<string, unknown> | undefined
): Record<string, unknown> {
  const args = pruneEmpty(rawArgs ?? {});
  const parsed = buildSchema(def).safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new McpError(ErrorCode.InvalidParams, `${def.name}: invalid arguments — ${issues}`);
  }
  const clean = parsed.data as Record<string, unknown>;

  const rules = def.rules;
  if (rules?.oneOf && rules.oneOf.length > 0) {
    const satisfied = rules.oneOf.some((group) => group.every((key) => clean[key] !== undefined));
    if (!satisfied) {
      const groups = rules.oneOf.map((g) => g.join(' + ')).join(' | ');
      throw new McpError(
        ErrorCode.InvalidParams,
        `${def.name}: a filter is required to keep the response small. Provide one of: ${groups}.`
      );
    }
  }
  if (rules?.rejectAllTenants) {
    for (const key of rules.rejectAllTenants) {
      const v = clean[key];
      if (typeof v === 'string' && v.toLowerCase() === 'alltenants') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${def.name}: ${key}='AllTenants' is not allowed for this tool because the result would be far too large. ` +
            'Target a single tenant, or use cipp_list_tenants to pick one.'
        );
      }
    }
  }
  return clean;
}
