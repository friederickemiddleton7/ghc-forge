// GitHub GraphQL v4: the documents gh and github-mcp-server send, resolved against the same store.
import { store, diffTrees, pullFiles } from './store.ts';

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt', 'closed', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'closed', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
};

function globalId(kind, id) {
  return Buffer.from(`04:${kind}${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(value) {
  try {
    const text = Buffer.from(String(value), 'base64').toString('utf8');
    const m = /^04:([A-Za-z]+)(\d+)$/.exec(text);
    if (!m) return null;
    return { kind: m[1], id: Number(m[2]) };
  } catch {
    return null;
  }
}

function issueNode(repo, issue) {
  return {
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closed: issue.state === 'closed',
    url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { login: issue.user ? issue.user.login : repo.owner },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
  };
}

function pullNode(repo, pull) {
  return {
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: pull.body,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    merged: !!pull.merged,
    closed: pull.state === 'closed',
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    files: { nodes: pullFiles(repo, pull).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })) },
    author: { login: pull.user ? pull.user.login : repo.owner },
  };
}

function repoNode(repo) {
  const tip = repo.tip();
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    owner: { login: repo.owner, id: globalId('User', 1), resourcePath: `/${repo.owner}` },
    defaultBranchRef: tip ? { name: repo.defaultBranch, target: { oid: tip } } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    url: `https://forge.local/${repo.owner}/${repo.name}`,
  };
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function connection(nodes, first, after) {
  const start = decodeCursor(after);
  const size = Number.isFinite(first) && first > 0 ? first : nodes.length;
  const page = nodes.slice(start, start + size);
  const hasNextPage = start + size < nodes.length;
  return {
    nodes: page,
    totalCount: nodes.length,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
      endCursor: page.length ? Buffer.from(`cursor:${start + page.length}`, 'utf8').toString('base64') : null,
    },
  };
}

function variablesOf(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function repoFromArgs(vars, query) {
  let owner = vars.owner;
  let name = vars.name || vars.repo;
  if (typeof owner !== 'string' || typeof name !== 'string') {
    const m = /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/.exec(query);
    if (m) {
      owner = owner || m[1];
      name = name || m[2];
    }
  }
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return store.get(owner, name);
}

function errorsFor(field) {
  return [{ message: `Field '${field}' doesn't exist on type 'User'`, locations: [{ line: 4, column: 5 }], path: ['query', 'viewer', field], extensions: { code: 'undefinedField', typeName: 'User', fieldName: field } }];
}

function resolveOne(query, vars, login) {
  const q = String(query || '');
  const data = {};
  const errors = [];

  if (/\bnoSuchFieldOnViewer\b/.test(q)) {
    return { data: { viewer: { login } }, errors: errorsFor('noSuchFieldOnViewer') };
  }

  if (/__type/.test(q)) {
    const aliasMatches = [...q.matchAll(/([A-Za-z_][A-Za-z0-9_]*)?\s*:\s*__type\s*\(\s*name\s*:\s*"?([A-Za-z]+)"?/g)];
    const names = aliasMatches.length
      ? aliasMatches.map((m) => ({ alias: m[1] || m[2], name: m[2] }))
      : [...q.matchAll(/__type\s*\(\s*name\s*:\s*"?([A-Za-z]+)"?/g)].map((m) => ({ alias: m[1], name: m[1] }));
    if (!names.length) {
      const listed = [...q.matchAll(/name\s*:\s*"([A-Za-z]+)"/g)].map((m) => ({ alias: m[1], name: m[1] }));
      names.push(...listed);
    }
    for (const entry of names) {
      if (entry.name === 'SearchType') {
        data[entry.alias] = {
          kind: 'ENUM',
          name: 'SearchType',
          enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((name) => ({ name })),
        };
      } else {
        const fields = TYPE_FIELDS[entry.name];
        data[entry.alias] = fields
          ? { kind: 'OBJECT', name: entry.name, fields: fields.map((name) => ({ name, isDeprecated: false, type: { name: 'String', kind: 'SCALAR' } })) }
          : null;
      }
    }
    return { data, errors };
  }

  if (/\bviewer\s*\{/.test(q) && !/repository\(/.test(q)) {
    data.viewer = { login, id: globalId('User', 1), name: login, url: `https://forge.local/${login}` };
    return { data, errors };
  }

  if (/node\s*\(\s*id\s*:/.test(q)) {
    const id = decodeGlobalId(vars.id);
    if (!id || id.kind !== 'Repository') {
      return { data: { node: null }, errors };
    }
    let found = null;
    for (const repo of store.repos.values()) if (repo.id === id.id) found = repo;
    data.node = found ? repoNode(found) : null;
    return { data, errors };
  }

  if (/createIssue/.test(q)) {
    const input = variablesOf(vars.input);
    const repo = repoFromArgs(input, q) || findRepoById(input.repositoryId);
    if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }] };
    if (typeof input.title !== 'string' || !input.title) return { data: { createIssue: null }, errors: [{ message: 'title is required', type: 'UNPROCESSABLE' }] };
    const labels = Array.isArray(input.labelIds) ? input.labelIds : [];
    const labelNames = labels.map((id) => {
      const found = repo.labels.find((l) => globalId('Label', l.id) === id);
      return found ? found.name : null;
    }).filter(Boolean);
    const issue = {
      id: 800000 + repo.issues.length,
      number: repo.nextNumber++,
      title: input.title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: labelNames,
      user: { login },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    };
    repo.issues.push(issue);
    return { data: { createIssue: { issue: issueNode(repo, issue) } }, errors };
  }

  if (/closeIssue/.test(q)) {
    const input = variablesOf(vars.input);
    const decoded = decodeGlobalId(input.issueId);
    let found = null;
    if (decoded) {
      for (const repo of store.repos.values()) {
        const issue = repo.issues.find((i) => i.id === decoded.id);
        if (issue) found = { repo, issue };
      }
    }
    if (!found) return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue', type: 'NOT_FOUND' }] };
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = found.issue.closedAt;
    // GraphQL closes the issue for the REST view too (same store).
    return { data: { closeIssue: { issue: issueNode(found.repo, found.issue) } }, errors };
  }

  if (/addComment/.test(q)) {
    const input = variablesOf(vars.input);
    const decoded = decodeGlobalId(input.subjectId);
    let found = null;
    if (decoded) {
      for (const repo of store.repos.values()) {
        const issue = repo.issues.find((i) => i.id === decoded.id);
        if (issue) found = { repo, issue };
      }
    }
    if (!found) return { data: { addComment: null }, errors: [{ message: 'Could not resolve to a node', type: 'NOT_FOUND' }] };
    const list = found.repo.comments.get(found.issue.number) || [];
    const comment = { id: ++found.repo.nextComment, body: typeof input.body === 'string' ? input.body : '', user: { login }, createdAt: new Date().toISOString() };
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    return { data: { addComment: { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body } } } }, errors };
  }

  if (/createPullRequest/.test(q)) {
    const input = variablesOf(vars.input);
    const repo = findRepoById(input.repositoryId) || repoFromArgs(input, q);
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }] };
    const head = String(input.headRefName || input.head || '');
    const base = String(input.baseRefName || input.base || repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return { data: { createPullRequest: null }, errors: [{ message: `No commits between ${base} and ${head}`, type: 'UNPROCESSABLE' }] };
    const pull = {
      id: 600000 + repo.pulls.length,
      number: repo.nextPull++,
      title: String(input.title || head),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      user: { login },
      head,
      headSha,
      base,
      baseSha: baseSha || null,
      merged: false,
      mergeable: true,
      mergedAt: null,
      mergeSha: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      files: [],
    };
    pull.files = diffTrees(repo, baseSha ? repo.treeOf(baseSha) : null, repo.treeOf(headSha));
    repo.pulls.push(pull);
    return { data: { createPullRequest: { pullRequest: pullNode(repo, pull) } }, errors };
  }

  if (/mergePullRequest/.test(q)) {
    const input = variablesOf(vars.input);
    const decoded = decodeGlobalId(input.pullRequestId);
    let found = null;
    if (decoded) {
      for (const repo of store.repos.values()) {
        const pull = repo.pulls.find((p) => p.id === decoded.id);
        if (pull) found = { repo, pull };
      }
    }
    if (!found) return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest', type: 'NOT_FOUND' }] };
    found.pull.merged = true;
    found.pull.mergeable = true;
    found.pull.state = 'closed';
    found.pull.mergedAt = new Date().toISOString();
    found.pull.mergeSha = found.pull.headSha;
    found.pull.closedAt = found.pull.mergedAt;
    const baseTip = found.repo.refs.get(`refs/heads/${found.pull.base}`);
    if (baseTip) found.repo.refs.set(`refs/heads/${found.pull.base}`, found.pull.headSha);
    return { data: { mergePullRequest: { pullRequest: pullNode(found.repo, found.pull) } }, errors };
  }

  const repo = repoFromArgs(vars, q);
  if (/repository\s*\(/.test(q)) {
    if (!repo) return { data: { repository: null }, errors };
    const node = repoNode(repo);
    if (/pullRequests\s*\(/.test(q)) {
      const state = /states\s*:\s*\[\s*([A-Z_,\s]+)\]/.exec(q);
      const wanted = state ? state[1].split(',').map((s) => s.trim()) : null;
      let pulls = repo.pulls;
      if (wanted) pulls = pulls.filter((p) => wanted.includes(p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN'));
      node.pullRequests = connection(pulls.map((p) => pullNode(repo, p)), vars.first, vars.after);
    }
    if (/pullRequest\s*\(\s*number/.test(q)) {
      const pull = repo.pulls.find((p) => p.number === Number(vars.number));
      node.pullRequest = pull ? pullNode(repo, pull) : null;
      if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg gql pr] repo=${repo.owner}/${repo.name} pulls=${repo.pulls.map((p) => p.number + ':' + p.head + '->' + p.base).join(',')} want=${vars.number} files=${pull ? pullFiles(repo, pull).map((f) => f.filename).join('|') : 'none'}\n`);
    }
    if (/issues\s*\(/.test(q)) {
      const stateMatch = /states\s*:\s*\[\s*([A-Z_,\s]+)\]/.exec(q);
      const wanted = stateMatch ? stateMatch[1].split(',').map((s) => s.trim()) : ['OPEN'];
      const orderMatch = /orderBy\s*:\s*\{\s*field\s*:\s*([A-Z_]+)\s*,\s*direction\s*:\s*([A-Z]+)/.exec(q);
      let issues = repo.issues.filter((i) => wanted.includes(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
      if (orderMatch && orderMatch[1] === 'CREATED_AT') {
        issues = [...issues].sort((a, b) => (orderMatch[2] === 'ASC' ? a.number - b.number : b.number - a.number));
      } else {
        issues = [...issues].sort((a, b) => b.number - a.number);
      }
      node.issues = connection(issues.map((i) => issueNode(repo, i)), vars.first, vars.after);
    }
    if (/issue\s*\(\s*number/.test(q)) {
      const issue = repo.issues.find((i) => i.number === Number(vars.number));
      node.issue = issue ? issueNode(repo, issue) : null;
    }
    return { data: { repository: node }, errors };
  }

  return { data: null, errors: [{ message: 'Unsupported operation', type: 'BAD_REQUEST' }] };
}

function findRepoById(id) {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === decoded.id) return repo;
  return null;
}

export function handleGraphQL({ token, login, body, method }) {
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' }, headers: {} };
  if (!token) return { status: 401, body: { message: 'Requires authentication' }, headers: {} };
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' }, headers: {} };
  }
  const run = (request) => {
    if (!request || typeof request !== 'object' || typeof request.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required', type: 'BAD_REQUEST' }] };
    }
    return resolveOne(request.query, variablesOf(request.variables), login);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(run), headers: {} };
  }
  return { status: 200, body: run(parsed), headers: {} };
}