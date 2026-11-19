// MCP over streamable HTTP: JSON-RPC 2.0, initialize, tools/list and tools/call on the same store.
import { store } from './store.ts';

const REVISION = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function toolsList() {
  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'repository name' }, private: { type: 'boolean', description: 'private repository' } },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Read one repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Open an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List the issues of a repository.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from one branch into another.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];
}

function repoSummary(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function argOf(args, name) {
  if (!args || typeof args !== 'object') return undefined;
  if (name in args) return args[name];
  const found = Object.keys(args).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : args[found];
}

function callTool(name, args) {
  const short = String(name).toLowerCase().replace(/^.*__/, '');
  const owner = argOf(args, 'owner');
  const repoName = argOf(args, 'repo');
  if (short === 'create_repo') {
    const createName = argOf(args, 'name');
    if (typeof createName !== 'string' || !createName) return { error: 'name is required' };
    const login = argOf(args, 'owner') || args.__login;
    const repo = store.create(String(login || ''), createName);
    if (!repo) return { error: 'repository already exists' };
    repo.private = argOf(args, 'private') === true;
    return { result: repoSummary(repo) };
  }
  if (short === 'get_repo') {
    const fullName = argOf(args, 'full_name');
    const ownerName = typeof owner === 'string' ? owner : typeof fullName === 'string' ? fullName.split('/')[0] : '';
    const name = typeof repoName === 'string' ? repoName : typeof fullName === 'string' ? fullName.split('/')[1] : '';
    const repo = store.get(ownerName, name);
    if (!repo) return { error: 'Not Found' };
    return { result: repoSummary(repo) };
  }
  if (short === 'create_issue') {
    const repo = store.get(String(owner), String(repoName));
    if (!repo) return { error: 'Not Found' };
    const title = argOf(args, 'title');
    if (typeof title !== 'string' || !title) return { error: 'title is required' };
    const issue = {
      id: 900000 + repo.issues.length,
      number: repo.nextNumber++,
      title,
      body: typeof argOf(args, 'body') === 'string' ? argOf(args, 'body') : '',
      state: 'open',
      labels: [],
      user: { login: String(owner) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    };
    repo.issues.push(issue);
    return { result: { id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body } };
  }
  if (short === 'list_issues') {
    const repo = store.get(String(owner), String(repoName));
    if (!repo) return { error: 'Not Found' };
    const state = argOf(args, 'state');
    const issues = repo.issues.filter((i) => !state || state === 'all' || i.state === state);
    return { result: { issues: issues.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state, body: i.body })) } };
  }
  if (short === 'create_pull_request') {
    const repo = store.get(String(owner), String(repoName));
    if (!repo) return { error: 'Not Found' };
    const head = String(argOf(args, 'head') || '');
    const base = String(argOf(args, 'base') || repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { error: 'head or base branch does not exist' };
    const pull = {
      id: 700000 + repo.pulls.length,
      number: repo.nextPull++,
      title: String(argOf(args, 'title') || head),
      body: typeof argOf(args, 'body') === 'string' ? argOf(args, 'body') : '',
      state: 'open',
      user: { login: String(owner) },
      head,
      headSha,
      base,
      baseSha,
      merged: false,
      mergeable: true,
      mergedAt: null,
      mergeSha: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      files: [],
    };
    repo.pulls.push(pull);
    return { result: { id: pull.id, number: pull.number, title: pull.title, state: pull.state, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } } };
  }
  if (short === 'merge_pull_request') {
    const repo = store.get(String(owner), String(repoName));
    if (!repo) return { error: 'Not Found' };
    const number = Number(argOf(args, 'pull_number'));
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { error: 'Not Found' };
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeSha = pull.headSha;
    return { result: { merged: true, sha: pull.mergeSha, number: pull.number } };
  }
  return { unknown: true };
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function handleOne(message, login) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return rpcErr(message && message.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') return rpcErr(id, -32600, 'Invalid Request');
  if (method === 'initialize') {
    return rpcOk(id, {
      protocolVersion: REVISION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gitforge', version: '1.0.0' },
      instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'server/discover') {
    return rpcOk(id, { supportedVersions: SUPPORTED, serverInfo: { name: 'gitforge', version: '1.0.0' }, capabilities: { tools: {} } });
  }
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') {
    return rpcOk(id, { tools: toolsList() });
  }
  if (method === 'tools/call') {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const args = params && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
    if (!name) return rpcErr(id, -32602, 'Invalid params: name is required');
    const known = toolsList().find((tool) => tool.name === name || name.toLowerCase().endsWith(`__${tool.name}`));
    if (!known) return rpcErr(id, -32601, `Unknown tool: ${name}`);
    const missing = (known.inputSchema.required || []).filter((key) => argOf(args, key) === undefined || argOf(args, key) === '');
    if (missing.length) return rpcErr(id, -32602, `Invalid params: missing ${missing.join(', ')}`);
    const outcome = callTool(name, { ...args, __login: login });
    if (outcome.unknown) return rpcErr(id, -32601, `Unknown tool: ${name}`);
    if (outcome.error) {
      return rpcOk(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
    }
    return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(outcome.result) }] });
  }
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

export function handleMcp({ token, login, body, method, headers }) {
  if (method !== 'POST') {
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }
  if (!token) {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } } };
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  const replies = [];
  for (const message of batch) {
    const reply = handleOne(message, login);
    if (reply !== null) replies.push(reply);
  }
  if (replies.length === 0) {
    return { status: 202, body: {}, headers: {} };
  }
  const sessionHeader = headers && typeof headers['mcp-session-id'] === 'string' ? headers['mcp-session-id'] : '';
  const outHeaders = sessionHeader ? { 'mcp-session-id': sessionHeader } : {};
  return { status: 200, body: Array.isArray(parsed) ? replies : replies[0], headers: outHeaders };
}