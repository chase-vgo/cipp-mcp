// Tests for tool-call argument validation.
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { validateArgs } from '../src/utils/validate.js';
import { McpToolDefinition, TOOL_DEFINITIONS, findToolDefinition } from '../src/mcp/tool.definitions.js';

const sample: McpToolDefinition = {
  name: 'sample',
  description: 'test',
  inputSchema: {
    type: 'object',
    properties: {
      tenantFilter: { type: 'string' },
      userId: { type: 'string' },
      searchField: { type: 'string', enum: ['displayName', 'mail'] },
      searchValue: { type: 'string' },
      limit: { type: 'integer' },
      flag: { type: 'boolean' },
      fields: { type: 'array', items: { type: 'string' } },
    },
    required: ['tenantFilter'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  rules: { oneOf: [['userId'], ['searchField', 'searchValue']], rejectAllTenants: ['tenantFilter'] },
};

describe('validateArgs', () => {
  it('rejects missing required arguments', () => {
    expect(() => validateArgs(sample, { userId: 'x' })).toThrow(McpError);
    expect(() => validateArgs(sample, { userId: 'x' })).toThrow(/tenantFilter/);
  });

  it('treats empty strings and nulls as absent', () => {
    expect(() => validateArgs(sample, { tenantFilter: '', userId: 'x' })).toThrow(/tenantFilter/);
    expect(() => validateArgs(sample, { tenantFilter: 'c.com', userId: null })).toThrow(/filter is required/);
  });

  it('enforces oneOf filter groups and names them in the error', () => {
    expect(() => validateArgs(sample, { tenantFilter: 'c.com' })).toThrow(
      /Provide one of: userId \| searchField \+ searchValue/
    );
    expect(() => validateArgs(sample, { tenantFilter: 'c.com', searchField: 'mail' })).toThrow(/filter is required/);
    expect(validateArgs(sample, { tenantFilter: 'c.com', searchField: 'mail', searchValue: 'a' })).toMatchObject({
      searchField: 'mail',
    });
  });

  it('rejects AllTenants where forbidden, case-insensitively', () => {
    expect(() => validateArgs(sample, { tenantFilter: 'alltenants', userId: 'x' })).toThrow(/AllTenants/);
  });

  it('enforces enums and coerces numeric / boolean strings', () => {
    expect(() => validateArgs(sample, { tenantFilter: 'c.com', searchField: 'nope', searchValue: 'a' })).toThrow(
      /searchField/
    );
    const out = validateArgs(sample, { tenantFilter: 'c.com', userId: 'x', limit: '25', flag: 'true' });
    expect(out.limit).toBe(25);
    expect(out.flag).toBe(true);
  });

  it('strips unknown arguments', () => {
    const out = validateArgs(sample, { tenantFilter: 'c.com', userId: 'x', bogus: 1 });
    expect(out).not.toHaveProperty('bogus');
  });
});

describe('TOOL_DEFINITIONS invariants', () => {
  it('every tool is read-only, uniquely named, and list tools expose fields/limit/format', () => {
    const names = new Set<string>();
    for (const def of TOOL_DEFINITIONS) {
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
      expect(def.name).toMatch(/^cipp_[a-z0-9_]+$/);
      expect(def.name).not.toMatch(/create|edit|set_|reset|revoke|offboard|disable|delete|remove|add_|run_/);
      expect(def.annotations.readOnlyHint).toBe(true);
      expect(def.annotations.destructiveHint).toBe(false);
      if (def.columns) {
        for (const key of ['fields', 'limit', 'format']) {
          expect(def.inputSchema.properties).toHaveProperty(key);
        }
      }
      for (const req of def.inputSchema.required ?? []) {
        expect(def.inputSchema.properties).toHaveProperty(req);
      }
      for (const group of def.rules?.oneOf ?? []) {
        for (const key of group) expect(def.inputSchema.properties).toHaveProperty(key);
      }
    }
  });

  it('heavy list tools require a filter', () => {
    for (const name of ['cipp_list_users', 'cipp_list_mailboxes', 'cipp_list_groups', 'cipp_list_devices', 'cipp_list_logs']) {
      const def = findToolDefinition(name)!;
      expect(def.rules?.oneOf?.length).toBeGreaterThan(0);
      expect(() => validateArgs(def, { tenantFilter: 'c.com' })).toThrow(/filter is required/);
    }
  });
});
