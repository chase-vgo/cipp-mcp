// Tests for CippService Standards read tooling.
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function mockFetch(payload: unknown) {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(jsonResponse(payload))
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('CippService standards read tooling', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('listStandardTemplates issues a GET to listStandardTemplates (lowercase l)', async () => {
    const fetchMock = mockFetch([{ GUID: 't1' }]);

    const result = await svc.listStandardTemplates();

    expect(result).toEqual([{ GUID: 't1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toMatch(/\/api\/listStandardTemplates$/);
    expect(init.method).toBe('GET');
  });

  it('listStandardTemplates passes a template id as `id`', async () => {
    const fetchMock = mockFetch([{ GUID: 't1' }]);
    await svc.listStandardTemplates('t1');
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('id')).toBe('t1');
  });

  it('getTenantDrift GETs ListTenantDrift scoped to a tenant when given one', async () => {
    const fetchMock = mockFetch([]);
    await svc.getTenantDrift('contoso.com');
    const parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
  });

  it('getTenantDrift omits tenantFilter when no tenant is given', async () => {
    const fetchMock = mockFetch([]);
    await svc.getTenantDrift();
    const parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(parsed.searchParams.has('tenantFilter')).toBe(false);
  });

  it('getTenantAlignment never sends tenantFilter (CIPP ignores it) and passes summary', async () => {
    const fetchMock = mockFetch([]);
    await svc.getTenantAlignment(false);
    let parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantAlignment$/);
    expect(parsed.searchParams.has('tenantFilter')).toBe(false);
    expect(parsed.searchParams.has('summary')).toBe(false);

    await svc.getTenantAlignment(true);
    parsed = new URL(fetchMock.mock.calls[1][0]);
    expect(parsed.searchParams.get('summary')).toBe('true');
  });

  it('listStandards sends ShowConsolidated only when requested', async () => {
    const fetchMock = mockFetch([]);
    await svc.listStandards('contoso.com');
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has('ShowConsolidated')).toBe(false);
    await svc.listStandards('contoso.com', true);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('ShowConsolidated')).toBe('true');
  });
});
