// Output formatting for CIPP MCP tool results.
//
// Every tool result passes through here so the server returns the smallest
// useful answer: tabular data as CSV with a curated column set, single
// records as compact JSON, a row limit with a truncation footer, and a hard
// byte cap that tells the caller to narrow its filter instead of silently
// flooding the context window.

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type OutputFormat = 'csv' | 'json';

/** Caller-controlled output options shared by every list tool. */
export interface ListOutputOptions {
  /** Column names (dotted paths allowed) that override the tool's curated default. */
  fields?: string[] | undefined;
  /** Maximum rows to return. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number | undefined;
  /** `csv` (default) or `json` when nested structure is needed. */
  format?: OutputFormat | undefined;
}

/** Default row cap applied when a caller does not pass `limit`. */
export const DEFAULT_LIMIT = 100;

/** Hard upper bound on a single tool response, in UTF-8 bytes. */
export const MAX_RESPONSE_BYTES = 32_000;

/** Most columns the auto-discovery fallback will emit when no default column matches. */
const AUTO_COLUMN_CAP = 20;

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

/**
 * Pull the list of records out of a CIPP response. Handles bare arrays and
 * the `{ Results: [...] }` / `{ value: [...] }` envelopes CIPP uses. Returns
 * `undefined` when `data` is not list-shaped.
 */
export function unwrapList(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['Results', 'value']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
      if (obj[key] && typeof obj[key] === 'object') return [obj[key]];
    }
  }
  return undefined;
}

/** True for null/undefined, empty objects and empty arrays: rows that carry no information. */
export function isEmptyRecord(row: unknown): boolean {
  if (row === null || row === undefined) return true;
  if (Array.isArray(row)) return row.length === 0;
  if (typeof row === 'object') return Object.keys(row as Record<string, unknown>).length === 0;
  return false;
}

/** Remove HTML tags and collapse whitespace; used for auto-reply bodies and similar rich-text fields. */
export function stripHtml(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\uFEFF/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Resolve a dotted path against a record. `a.b.c` walks nested objects;
 * a trailing `.length` on an array returns its size. Lookup is exact-case
 * first, then case-insensitive per segment, because CIPP mixes Graph
 * camelCase with Exchange PascalCase.
 */
export function getPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (segment === 'length') return current.length;
      const idx = Number(segment);
      current = Number.isInteger(idx) ? current[idx] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    const obj = current as Record<string, unknown>;
    if (segment in obj) {
      current = obj[segment];
    } else {
      const lower = segment.toLowerCase();
      const match = Object.keys(obj).find((k) => k.toLowerCase() === lower);
      current = match === undefined ? undefined : obj[match];
    }
  }
  return current;
}

/** Render one cell: scalars verbatim, scalar arrays joined with `;`, anything nested as compact JSON. */
export function cellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || v === undefined || typeof v !== 'object')) {
      return value.map((v) => (v === null || v === undefined ? '' : String(v))).join(';');
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * Decide which columns to emit. Explicit `fields` win. Otherwise the curated
 * `defaults` are kept only where at least one row has a value, so a wrong
 * guess about CIPP's field names degrades to fewer columns rather than
 * empty ones. If nothing matches, fall back to the first row's scalar keys.
 */
export function resolveColumns(rows: unknown[], defaults: string[], fields?: string[]): string[] {
  if (fields && fields.length > 0) return dedupeColumns(fields);
  const present = dedupeColumns(defaults).filter((col) =>
    rows.some((row) => {
      const v = getPath(row, col);
      return v !== undefined && v !== null && v !== '';
    })
  );
  if (present.length > 0) return present;
  const first = rows.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as
    | Record<string, unknown>
    | undefined;
  if (!first) return [];
  return Object.entries(first)
    .filter(([, v]) => v === null || typeof v !== 'object')
    .map(([k]) => k)
    .slice(0, AUTO_COLUMN_CAP);
}

/** Drop columns that differ only by case (lookup is case-insensitive, so they would duplicate). */
function dedupeColumns(columns: string[]): string[] {
  const seen = new Set<string>();
  return columns.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvEscape(cell: string): string {
  // RFC 4180: quote when the cell contains a separator, quote, or line break.
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/** Serialise rows to CSV with a header line. Cells are resolved via {@link getPath}. */
export function toCsv(rows: unknown[], columns: string[]): string {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => csvEscape(cellValue(getPath(row, col)))).join(','));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Size management
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Enforce the response byte cap. Text under the cap is returned unchanged.
 * Over the cap, the text is cut at the last line break that fits and a
 * footer explains how to get a smaller answer.
 */
export function capSize(text: string, maxBytes: number = MAX_RESPONSE_BYTES, totalRows?: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const footer =
    `\n# response truncated at ${Math.round(maxBytes / 1000)} KB` +
    (totalRows !== undefined ? ` (${totalRows} rows total)` : '') +
    '; add a filter, reduce fields, or lower limit';
  const budget = maxBytes - byteLength(footer);
  let cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, budget)).toString('utf8');
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > 0) cut = cut.slice(0, lastBreak);
  return cut + footer;
}

// ---------------------------------------------------------------------------
// Public formatters
// ---------------------------------------------------------------------------

/**
 * Format a list-shaped CIPP response. Applies `limit`, projects to the
 * curated or caller-supplied columns, emits CSV (or compact JSON), appends a
 * truncation footer when rows were dropped, and enforces the byte cap.
 */
export function formatList(data: unknown, defaultColumns: string[], opts: ListOutputOptions = {}): string {
  const rows = (unwrapList(data) ?? (data === null || data === undefined ? [] : [data])).filter(
    (r) => !isEmptyRecord(r)
  );
  const total = rows.length;
  if (total === 0) return '# no rows';

  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const shown = rows.slice(0, limit);
  const footer =
    shown.length < total ? `\n# showing ${shown.length} of ${total} rows; narrow the filter or raise limit` : '';

  let body: string;
  if (opts.format === 'json') {
    const projected =
      opts.fields && opts.fields.length > 0
        ? shown.map((row) => {
            const out: Record<string, unknown> = {};
            for (const col of opts.fields!) out[col] = getPath(row, col);
            return out;
          })
        : shown;
    body = JSON.stringify(projected);
  } else {
    const columns = resolveColumns(shown, defaultColumns, opts.fields);
    // Nothing tabular to project (e.g. scalar rows): fall back to compact JSON.
    body = columns.length === 0 ? JSON.stringify(shown) : toCsv(shown, columns);
  }
  return capSize(body + footer, MAX_RESPONSE_BYTES, total);
}

/**
 * Format a single-record CIPP response as compact JSON, optionally dropping
 * bulky keys the caller rarely needs (plan lists, raw blobs, version history).
 */
export function formatObject(data: unknown, dropKeys: string[] = []): string {
  if (data === null || data === undefined) return '# no data';
  let payload: unknown = data;
  if (dropKeys.length > 0 && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    const lowerDrops = dropKeys.map((k) => k.toLowerCase());
    for (const key of Object.keys(copy)) {
      if (lowerDrops.includes(key.toLowerCase())) delete copy[key];
    }
    payload = copy;
  }
  return capSize(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Client-side filtering
// ---------------------------------------------------------------------------

/**
 * Recursively test whether any string/number/boolean value within `record`
 * contains `needle` (already lower-cased). Used for client-side filtering of
 * CIPP list responses where the endpoint has no server-side filter.
 */
export function recordMatches(record: unknown, needle: string): boolean {
  if (record === null || record === undefined) return false;
  if (typeof record === 'string') return record.toLowerCase().includes(needle);
  if (typeof record === 'number' || typeof record === 'boolean') {
    return String(record).toLowerCase().includes(needle);
  }
  if (Array.isArray(record)) return record.some((item) => recordMatches(item, needle));
  if (typeof record === 'object') {
    return Object.values(record as Record<string, unknown>).some((v) => recordMatches(v, needle));
  }
  return false;
}

/**
 * Filter a CIPP list response down to records matching `term` (case-insensitive
 * substring match across all of a record's fields). Preserves the original
 * envelope shape and keeps `Metadata.Count` in sync. Empty `term` and
 * non-list responses are returned unchanged.
 */
export function filterListByTerm<T>(data: T, term: string | undefined): T {
  if (!term) return data;
  const needle = term.toLowerCase();
  return filterList(data, (rec) => recordMatches(rec, needle));
}

/**
 * Filter a CIPP list response with an arbitrary predicate, preserving the
 * envelope (`Results` / `value`) and updating `Metadata.Count`.
 */
export function filterList<T>(data: T, predicate: (rec: unknown) => boolean): T {
  if (Array.isArray(data)) {
    return data.filter(predicate) as unknown as T;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['Results', 'value']) {
      if (Array.isArray(obj[key])) {
        const filtered = (obj[key] as unknown[]).filter(predicate);
        const next: Record<string, unknown> = { ...obj, [key]: filtered };
        const meta = next.Metadata;
        if (meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).Count === 'number') {
          next.Metadata = { ...(meta as Record<string, unknown>), Count: filtered.length };
        }
        return next as T;
      }
    }
  }
  return data;
}

/**
 * Transform every record in a CIPP list response, preserving the envelope
 * (`Results` / `value`). Non-list responses are returned unchanged.
 */
export function mapList<T>(data: T, fn: (rec: unknown) => unknown): T {
  if (Array.isArray(data)) {
    return data.map(fn) as unknown as T;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['Results', 'value']) {
      if (Array.isArray(obj[key])) {
        return { ...obj, [key]: (obj[key] as unknown[]).map(fn) } as T;
      }
    }
  }
  return data;
}

/** True when a record's field (dotted path, case-insensitive) contains `term`. */
export function fieldContains(record: unknown, path: string, term: string): boolean {
  const v = getPath(record, path);
  if (v === undefined || v === null) return false;
  return cellValue(v).toLowerCase().includes(term.toLowerCase());
}
