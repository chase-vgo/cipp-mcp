// End-to-end handler tests with a mocked CIPP API: validation, client-side
// filters, CSV output and the raw read-only tools.
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { CippToolHandler } from '../src/handlers/tool.handler.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text } as unknown as Response;
}

type Route = (url: URL, init: RequestInit) => unknown;

function mockCipp(routes: Record<string, Route>) {
  const fetchMock = jest.fn((url: string, init: RequestInit) => {
    const u = new URL(url);
    const fn = u.pathname.split('/api/')[1];
    const route = routes[fn];
    if (!route) return Promise.reject(new Error(`unexpected CIPP call: ${fn}`));
    return Promise.resolve(jsonResponse(route(u, init)));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('CippToolHandler', () => {
  let handler: CippToolHandler;

  beforeEach(() => {
    const svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
    handler = new CippToolHandler(svc, logger);
  });

  afterEach(() => jest.restoreAllMocks());

  it('advertises tools without the server-private columns/rules fields', () => {
    const tools = handler.getToolDefinitions() as unknown as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(40);
    for (const t of tools) {
      expect(t).not.toHaveProperty('columns');
      expect(t).not.toHaveProperty('rules');
      expect((t.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
    }
  });

  it('rejects an unfiltered list_users call before touching CIPP', async () => {
    const fetchMock = mockCipp({});
    await expect(handler.handleToolCall('cipp_list_users', { tenantFilter: 'c.com' })).rejects.toThrow(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects AllTenants on heavy tools', async () => {
    mockCipp({});
    await expect(
      handler.handleToolCall('cipp_list_mailboxes', { tenantFilter: 'AllTenants', type: 'SharedMailbox' })
    ).rejects.toThrow(/AllTenants/);
  });

  it('list_users translates a search into graphFilter and returns curated CSV', async () => {
    const fetchMock = mockCipp({
      ListUsers: () => [
        {
          id: '1',
          displayName: 'Alice',
          userPrincipalName: 'alice@c.com',
          accountEnabled: true,
          assignedLicenses: [{}, {}],
          assignedPlans: new Array(30).fill({ big: true }),
        },
      ],
    });
    const res = await handler.handleToolCall('cipp_list_users', {
      tenantFilter: 'c.com',
      searchField: 'displayName',
      searchValue: "O'Brien",
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('graphFilter')).toBe("startswith(displayName,'O''Brien')");
    const text = res.content[0].text;
    expect(text.split('\n')[0]).toBe('displayName,userPrincipalName,id,accountEnabled,assignedLicenses.length');
    expect(text.split('\n')[1]).toBe('Alice,alice@c.com,1,true,2');
    expect(text).not.toContain('assignedPlans');
  });

  it('list_tenants hides excluded tenants by default and supports search', async () => {
    mockCipp({
      ListTenants: () => [
        { displayName: 'Contoso', defaultDomainName: 'contoso.com', Excluded: false, customerId: 'a' },
        { displayName: 'Fabrikam', defaultDomainName: 'fabrikam.com', Excluded: true, customerId: 'b' },
        { displayName: 'Tailspin', defaultDomainName: 'tailspin.com', Excluded: false, customerId: 'c' },
      ],
    });
    const all = (await handler.handleToolCall('cipp_list_tenants', {})).content[0].text;
    expect(all).toContain('Contoso');
    expect(all).not.toContain('Fabrikam');
    const one = (await handler.handleToolCall('cipp_list_tenants', { search: 'tail' })).content[0].text;
    expect(one.split('\n')).toHaveLength(2);
    expect(one).toContain('tailspin.com');
  });

  it('list_mfa_users unregisteredOnly filters client-side', async () => {
    mockCipp({
      ListMFAUsers: () => [
        { UPN: 'a@c.com', AccountEnabled: true, isLicensed: true, MFARegistration: false },
        { UPN: 'b@c.com', AccountEnabled: true, isLicensed: true, MFARegistration: true },
        { UPN: 'svc@c.com', AccountEnabled: false, isLicensed: true, MFARegistration: false },
      ],
    });
    const text = (await handler.handleToolCall('cipp_list_mfa_users', { tenantFilter: 'c.com', unregisteredOnly: true }))
      .content[0].text;
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('a@c.com');
  });

  it('list_groups with groupId returns the nested members list, or groupInfo without members/owners', async () => {
    const fetchMock = mockCipp({
      ListGroups: (u) => {
        expect(u.searchParams.get('groupID')).toBe('g1');
        return {
          groupInfo: { id: 'g1', displayName: 'Sales', '@odata.context': 'x' },
          members: [{ id: 'u1', displayName: 'Alice', userPrincipalName: 'alice@c.com', mail: 'alice@c.com', '@odata.type': '#microsoft.graph.user' }],
          owners: [],
          allowExternal: true,
        };
      },
    });
    const members = (await handler.handleToolCall('cipp_list_groups', { tenantFilter: 'c.com', groupId: 'g1', members: true })).content[0].text;
    expect(members).toBe('displayName,userPrincipalName,mail,id\nAlice,alice@c.com,alice@c.com,u1');
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('members')).toBe('true');
    const info = (await handler.handleToolCall('cipp_list_groups', { tenantFilter: 'c.com', groupId: 'g1' })).content[0].text;
    expect(JSON.parse(info)).toEqual({ id: 'g1', displayName: 'Sales' });
  });

  it('get_tenant_alignment scopes client-side because CIPP ignores tenantFilter', async () => {
    const fetchMock = mockCipp({
      ListTenantAlignment: () => [
        { tenantFilter: 'a.com', standardName: 'S', alignmentScore: 90 },
        { tenantFilter: 'b.com', standardName: 'S', alignmentScore: 50 },
      ],
    });
    const text = (await handler.handleToolCall('cipp_get_tenant_alignment', { tenantFilter: 'B.com' })).content[0].text;
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has('tenantFilter')).toBe(false);
    expect(text.split('\n')).toEqual(['tenantFilter,standardName,alignmentScore', 'b.com,S,50']);
  });

  it('list_logs always sends Filter=true and the chosen filters', async () => {
    const fetchMock = mockCipp({ ListLogs: () => [] });
    await handler.handleToolCall('cipp_list_logs', { severity: 'Error', days: 3 });
    const q = new URL(fetchMock.mock.calls[0][0] as string).searchParams;
    expect(q.get('Filter')).toBe('true');
    expect(q.get('Severity')).toBe('Error');
    expect(q.get('Days')).toBe('3');
  });

  it('graph_request bounds the page and uses select as the column set', async () => {
    const fetchMock = mockCipp({
      ListGraphRequest: () => [{ displayName: 'A', userPrincipalName: 'a@c.com', other: 1 }],
    });
    const text = (
      await handler.handleToolCall('cipp_graph_request', {
        tenantFilter: 'c.com',
        endpoint: '/users',
        select: 'displayName, userPrincipalName',
        top: 5,
      })
    ).content[0].text;
    const q = new URL(fetchMock.mock.calls[0][0] as string).searchParams;
    expect(q.get('Endpoint')).toBe('users');
    expect(q.get('$top')).toBe('5');
    expect(q.get('NoPagination')).toBe('true');
    expect(q.get('$select')).toBe('displayName, userPrincipalName');
    expect(text).toBe('displayName,userPrincipalName\nA,a@c.com');
  });

  it('exo_request refuses non-read cmdlets and posts TenantFilter/Cmdlet/cmdParams/Select', async () => {
    const fetchMock = mockCipp({ ListExoRequest: () => ({ Results: [{ Identity: 'x', Alias: 'y' }] }) });
    await expect(
      handler.handleToolCall('cipp_exo_request', { tenantFilter: 'c.com', cmdlet: 'Set-Mailbox', select: 'Identity' })
    ).rejects.toThrow(/only Get-\* and Search-\*/);
    expect(fetchMock).not.toHaveBeenCalled();

    const text = (
      await handler.handleToolCall('cipp_exo_request', {
        tenantFilter: 'c.com',
        cmdlet: 'Get-Mailbox',
        cmdParams: { Identity: 'x' },
        select: 'Identity,Alias',
      })
    ).content[0].text;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      TenantFilter: 'c.com',
      Cmdlet: 'Get-Mailbox',
      cmdParams: { Identity: 'x' },
      Select: 'Identity,Alias',
    });
    expect(text).toBe('Identity,Alias\nx,y');
  });

  it('bec_check polls with GUID until the result is ready', async () => {
    let calls = 0;
    jest.useFakeTimers();
    const fetchMock = mockCipp({
      ExecBECCheck: () => {
        calls += 1;
        return calls < 3 ? { Waiting: true } : { Results: { SuspectUserMailboxRules: [] } };
      },
    });
    const promise = handler.handleToolCall('cipp_bec_check', {
      tenantFilter: 'c.com',
      userId: 'guid-1',
      userName: 'a@c.com',
    });
    await jest.advanceTimersByTimeAsync(10_000);
    const res = await promise;
    jest.useRealTimers();
    expect(calls).toBe(3);
    const last = new URL(fetchMock.mock.calls[2][0] as string).searchParams;
    expect(last.get('GUID')).toBe('guid-1');
    expect(res.content[0].text).toContain('SuspectUserMailboxRules');
  });
});
