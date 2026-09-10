// Tests for the output formatter: CSV projection, limits, byte cap, filters.
import {
  DEFAULT_LIMIT,
  MAX_RESPONSE_BYTES,
  capSize,
  cellValue,
  filterList,
  filterListByTerm,
  formatList,
  formatObject,
  getPath,
  mapList,
  resolveColumns,
  stripHtml,
  toCsv,
  unwrapList,
} from '../src/utils/format.js';

describe('format helpers', () => {
  it('unwrapList handles bare arrays and Results/value envelopes', () => {
    expect(unwrapList([1, 2])).toEqual([1, 2]);
    expect(unwrapList({ Results: [1], Metadata: {} })).toEqual([1]);
    expect(unwrapList({ value: [1] })).toEqual([1]);
    expect(unwrapList({ id: 1 })).toBeUndefined();
    expect(unwrapList('x')).toBeUndefined();
  });

  it('getPath walks dotted paths, arrays, .length and is case-insensitive per segment', () => {
    const rec = { location: { City: 'Tulsa' }, assignedLicenses: [{ skuId: 'a' }, { skuId: 'b' }], Tenants: [{ label: 'X' }] };
    expect(getPath(rec, 'location.city')).toBe('Tulsa');
    expect(getPath(rec, 'assignedLicenses.length')).toBe(2);
    expect(getPath(rec, 'Tenants.0.label')).toBe('X');
    expect(getPath(rec, 'nope.deeper')).toBeUndefined();
  });

  it('cellValue joins scalar arrays with ; and JSON-encodes nested structures', () => {
    expect(cellValue(['a', 'b'])).toBe('a;b');
    expect(cellValue([{ a: 1 }])).toBe('[{"a":1}]');
    expect(cellValue({ a: 1 })).toBe('{"a":1}');
    expect(cellValue(null)).toBe('');
    expect(cellValue(true)).toBe('true');
  });

  it('toCsv quotes cells containing commas, quotes or newlines', () => {
    const csv = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }], ['a', 'b', 'c']);
    expect(csv).toBe('a,b,c\n"x,y","he said ""hi""","line1\nline2"');
  });

  it('resolveColumns keeps only default columns that have data, else falls back to scalar keys', () => {
    const rows = [{ a: 1, b: null, nested: { x: 1 } }, { a: 2, b: '' }];
    expect(resolveColumns(rows, ['a', 'b', 'missing'])).toEqual(['a']);
    expect(resolveColumns(rows, ['missing'])).toEqual(['a', 'b']);
    expect(resolveColumns(rows, ['missing'], ['b'])).toEqual(['b']);
  });
});

describe('formatList', () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: i, name: `user${i}`, extra: { deep: i } }));

  it('emits CSV with the curated columns and a footer when rows are cut', () => {
    const out = formatList(rows, ['name', 'id']);
    const lines = out.split('\n');
    expect(lines[0]).toBe('name,id');
    expect(lines[1]).toBe('user0,0');
    expect(lines.length).toBe(1 + DEFAULT_LIMIT + 1);
    expect(lines[lines.length - 1]).toMatch(/^# showing 100 of 150 rows/);
  });

  it('honours limit and fields', () => {
    const out = formatList(rows, ['name'], { limit: 2, fields: ['id', 'extra.deep'] });
    expect(out.split('\n').slice(0, 3)).toEqual(['id,extra.deep', '0,0', '1,1']);
  });

  it('returns compact JSON when format=json, projecting fields when given', () => {
    const out = formatList(rows.slice(0, 2), ['name'], { format: 'json', fields: ['id'] });
    expect(JSON.parse(out.split('\n')[0])).toEqual([{ id: 0 }, { id: 1 }]);
    const full = formatList(rows.slice(0, 1), ['name'], { format: 'json' });
    expect(JSON.parse(full)).toEqual([rows[0]]);
  });

  it('reports empty lists cheaply', () => {
    expect(formatList([], ['a'])).toBe('# no rows');
    expect(formatList({ Results: [], Metadata: { Count: 0 } }, ['a'])).toBe('# no rows');
  });

  it('enforces the byte cap with a truncation footer', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: 'x'.repeat(200) }));
    const out = formatList(big, ['id', 'blob'], { limit: 5000 });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(out).toMatch(/# response truncated at 32 KB \(5000 rows total\)/);
  });
});

describe('formatObject', () => {
  it('drops requested keys case-insensitively and stays compact', () => {
    const out = formatObject({ id: 1, AssignedPlans: [1, 2], keep: true }, ['assignedPlans']);
    expect(out).toBe('{"id":1,"keep":true}');
  });

  it('caps oversized objects', () => {
    const out = formatObject({ blob: 'x'.repeat(50_000) });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

describe('capSize', () => {
  it('returns text unchanged when under the cap', () => {
    expect(capSize('abc', 10)).toBe('abc');
  });
  it('cuts at the last newline that fits', () => {
    const text = Array.from({ length: 50 }, (_, i) => `row${i}`).join('\n');
    const out = capSize(text, 120);
    expect(out.endsWith('lower limit')).toBe(true);
    expect(out.split('\n').slice(0, -1).every((l) => /^row\d+$/.test(l))).toBe(true);
  });
});

describe('client-side filters', () => {
  const env = { Results: [{ n: 'Alice' }, { n: 'Bob' }], Metadata: { Count: 2 } };

  it('filterListByTerm keeps envelope and Metadata.Count in sync', () => {
    expect(filterListByTerm(env, 'ali')).toEqual({ Results: [{ n: 'Alice' }], Metadata: { Count: 1 } });
    expect(filterListByTerm(env, undefined)).toBe(env);
  });

  it('filterList and mapList work on bare arrays and envelopes', () => {
    expect(filterList([1, 2, 3], (v) => (v as number) > 1)).toEqual([2, 3]);
    expect(mapList({ value: [1, 2] }, (v) => (v as number) * 2)).toEqual({ value: [2, 4] });
    expect(mapList('x', (v) => v)).toBe('x');
  });
});

describe('envelope and rich-text edge cases', () => {
  it('unwrapList turns a single-object Results envelope into a one-row list', () => {
    expect(unwrapList({ Results: { Identity: 'x' } })).toEqual([{ Identity: 'x' }]);
  });

  it('formatList drops empty rows and falls back to JSON when no column resolves', () => {
    expect(formatList([{}], ['a'])).toBe('# no rows');
    expect(formatList([1, 2], ['a'])).toBe('[1,2]');
  });

  it('resolveColumns dedupes case-variant duplicates and cellValue trims', () => {
    expect(resolveColumns([{ Status: 'ok' }], ['Status', 'status'])).toEqual(['Status']);
    expect(cellValue('All\n')).toBe('All');
  });

  it('stripHtml turns an Outlook auto-reply body into plain text', () => {
    const html = '﻿<html><head><style>p{}</style></head><body><p>Out of&nbsp;office.</p><p>Back <b>Monday</b>.</p></body></html>';
    expect(stripHtml(html)).toBe('Out of office.\nBack Monday.');
    expect(stripHtml(42)).toBe(42);
  });
});
