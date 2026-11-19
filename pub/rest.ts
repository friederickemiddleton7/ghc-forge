// REST v3: repositories, contents, commits, branches, issues, comments, labels, pulls and merges.
import { buildTree, hashObject, parseCommit, parseTree } from './gitobj.ts';
import {
  commentJson,
  diffTrees,
  isTreeMode,
  issueJson,
  labelJson,
  newIssueNumber,
  pullJson,
  repoJson,
  store,
} from './store.ts';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loginFromToken(token) {
  let value = String(token || '').trim();
  if (!value) return '';
  if (value.includes(' ')) value = value.split(' ').pop();
  if (/^Bearer$/i.test(value)) return '';
  for (const prefix of ['mf_', 'ghp_', 'mfs_', 'token-']) if (value.startsWith(prefix)) value = value.slice(prefix.length);
  // An opaque shop token (shpat_ + hex) carries no login: the store's viewer is the demo user.
  if (/^shpat_[0-9a-f]{8,}$/i.test(value)) return 'adaiversen';
  const colon = value.lastIndexOf(':');
  if (colon >= 0) value = value.slice(colon + 1);
  return value;
}

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function commitJson(repo, sha) {
  const obj = repo.read(sha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.content);
  const authorLine = commit.author || '';
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d+)$/.exec(authorLine) || [];
  const name = m[1] || repo.owner;
  const email = m[2] || `${repo.owner}@forge.local`;
  const epoch = m[3] ? Number(m[3]) : 0;
  const iso = new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
  return {
    sha,
    node_id: sha,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      author: { name, email, date: iso },
      committer: { name, email, date: iso },
    },
    author: { login: repo.owner, id: 1, type: 'User' },
    committer: { login: repo.owner, id: 1, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function commitChain(repo, tip, limit = 100) {
  const out = [];
  let current = tip;
  const seen = new Set();
  while (current && out.length < limit && !seen.has(current)) {
    seen.add(current);
    const json = commitJson(repo, current);
    if (!json) break;
    out.push(json);
    const obj = repo.read(current);
    if (!obj || obj.type !== 'commit') break;
    const parents = parseCommit(obj.content).parents;
    current = parents[0];
  }
  return out;
}

function authorOf(login, body) {
  const who = body && typeof body === 'object' && body.author && typeof body.author.name === 'string' ? body.author : null;
  const name = who && who.name ? who.name : login;
  const email = who && typeof who.email === 'string' && who.email ? who.email : `${login}@forge.local`;
  return `${name} <${email}> ${Math.floor(Date.now() / 1000)} +0000`;
}

function makeCommit(repo, { tree, parents, message, login, body }) {
  const author = authorOf(login, body);
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${author}`, '', message);
  const content = Buffer.from(lines.join('\n'), 'utf8');
  return repo.writeObject('commit', content);
}

function requireRepo(owner, name) {
  const repo = store.get(owner, name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}

function requireIssue(repo, number) {
  const issue = repo.issues.find((i) => i.number === Number(number));
  if (!issue) throw new HttpError(404, 'Not Found');
  return issue;
}

function requirePull(repo, number) {
  const pull = repo.pulls.find((p) => p.number === Number(number));
  if (!pull) throw new HttpError(404, 'Not Found');
  return pull;
}

function pageOf(items, query) {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') || 30) || 30));
  const page = Math.max(1, Number(query.get('page') || 1) || 1);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), perPage, page, total: items.length };
}

function linkHeader(url, { perPage, page, total }, origin = 'http://forge.local') {
  if (total <= perPage) return null;
  const last = Math.max(1, Math.ceil(total / perPage));
  const make = (p) => {
    const u = new URL(url, 'http://x');
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return `<${origin}${u.pathname}${u.search}>`;
  };
  const parts = [];
  if (page < last) parts.push(`${make(page + 1)}; rel="next"`, `${make(last)}; rel="last"`);
  if (page > 1) parts.push(`${make(1)}; rel="first"`, `${make(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

function readBody(ctx) {
  const raw = ctx.body.toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

function contentEntry(repo, path, sha) {
  const obj = repo.read(sha);
  const content = obj ? obj.content : Buffer.alloc(0);
  return {
    name: path.split('/').pop(),
    path,
    sha,
    size: content.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    download_url: null,
    type: 'file',
    content: b64(content),
    encoding: 'base64',
  };
}

/** Apply a flat map change and commit it on a branch. Returns {commit, blobSha, created}. */
function commitChange(repo, { branch, path, contentBuf, message, login, body, remove, expectedSha }) {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) || null;
  const treeSha = tip ? repo.treeOf(tip) : null;
  const flat = treeSha ? repo.flatten(treeSha) : new Map();
  const existing = flat.get(path);
  if (expectedSha !== undefined && expectedSha !== null) {
    if (!existing) throw new HttpError(404, 'Not Found');
    if (existing.sha !== expectedSha) throw new HttpError(409, 'sha does not match');
  }
  let created = false;
  let blobSha = null;
  if (remove) {
    if (!existing) throw new HttpError(404, 'Not Found');
    flat.delete(path);
  } else {
    blobSha = repo.writeObject('blob', contentBuf);
    created = !existing;
    flat.set(path, { sha: blobSha, mode: existing ? existing.mode : '100644' });
  }
  const newTree = repo.writeTreeFrom(flat);
  const commit = makeCommit(repo, {
    tree: newTree,
    parents: tip ? [tip] : [],
    message,
    login,
    body,
  });
  repo.refs.set(ref, commit);
  if (!tip) {
    if (!repo.refs.has('HEAD')) repo.refs.set('HEAD', commit);
    const commitObj = repo.read(commit);
    if (commitObj) repo.defaultBranch = branch;
  }
  return { commit, blobSha, created };
}

function mergeBase(repo, a, b) {
  const seen = new Set();
  const stack = [a];
  while (stack.length) {
    const sha = stack.pop();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.read(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.content).parents) stack.push(parent);
  }
  let current = b;
  while (current) {
    if (seen.has(current)) return current;
    const obj = repo.read(current);
    if (!obj || obj.type !== 'commit') return null;
    current = parseCommit(obj.content).parents[0];
  }
  return null;
}

function conflictsBetween(repo, baseTip, headTip) {
  const mb = mergeBase(repo, baseTip, headTip);
  const base = repo.flatten(repo.treeOf(baseTip));
  const head = repo.flatten(repo.treeOf(headTip));
  const ancestor = mb ? repo.flatten(repo.treeOf(mb)) : new Map();
  for (const [path, entry] of head) {
    const b = base.get(path);
    const a = ancestor.get(path);
    if (!b) continue;
    if (b.sha === entry.sha) continue;
    if (a && a.sha !== b.sha && a.sha !== entry.sha) return path;
  }
  return null;
}

export function restRoutes(ctx) {
  const { method, path, query } = ctx;
  const seg = path.split('/').filter(Boolean); // ['api','v3',...]
  const rest = seg.slice(2);
  const url = path + (query.toString() ? `?${query}` : '');

  if (rest.length === 0) {
    return {
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        repositories_url: '/api/v3/repositories',
        user_url: '/api/v3/users/{user}',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3' },
    };
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    return { body: { installed_version: 'gitforge 1.0.0', verifiable_password_authentication: false, hooks: [], git: [] } };
  }

  if (rest[0] === 'rate_limit') {
    return { body: { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 } } };
  }

  if (rest[0] === 'user') {
    const login = ctx.login;
    if (rest.length === 1) {
      return { body: { login, id: 1, node_id: 'U_1', name: login, type: 'User', site_admin: false, public_repos: store.listOwner(login).length, html_url: `https://forge.local/${login}`, url: `/api/v3/users/${login}` } };
    }
    if (rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listOwner(login);
        const page = pageOf(repos, query);
        const header = linkHeader(`/api/v3/user/repos${query.toString() ? `?${query}` : ''}`, page, ctx.origin);
        return { body: page.items.map(repoJson), headers: header ? { link: header } : {} };
      }
      if (method === 'POST') {
        const body = readBody(ctx);
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new HttpError(422, 'Repository creation failed: name is invalid');
        const owner = typeof body.owner === 'string' && body.owner ? body.owner : login;
        if (owner.toLowerCase() !== login.toLowerCase()) throw new HttpError(404, 'Not Found');
        const repo = store.create(owner, name);
        if (!repo) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
        repo.private = body.private === true;
        repo.description = typeof body.description === 'string' ? body.description : '';
        if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
        return { status: 201, body: repoJson(repo) };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'users' && rest.length === 2) {
    return { body: { login: rest[1], id: 2, type: 'User', name: rest[1], html_url: `https://forge.local/${rest[1]}` } };
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw new HttpError(404, 'Not Found');
  const owner = rest[1];
  const name = rest[2];
  const repo = requireRepo(owner, name);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') {
      if (repo.owner.toLowerCase() !== ctx.login.toLowerCase()) throw new HttpError(404, 'Not Found');
      return { body: repoJson(repo) };
    }
    if (method === 'PATCH') {
      if (repo.owner.toLowerCase() !== ctx.login.toLowerCase()) throw new HttpError(404, 'Not Found');
      const body = readBody(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
        store.remove(repo.owner, repo.name);
        repo.name = body.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      return { body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      if (repo.owner.toLowerCase() !== ctx.login.toLowerCase()) throw new HttpError(404, 'Not Found');
      store.remove(repo.owner, repo.name);
      return { status: 204 };
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1) {
      const branches = repo.branchRefs().map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false }));
      return { body: branches };
    }
    const found = repo.branchRefs().find((b) => b.name === decodeURIComponent(tail[1]));
    if (!found) throw new HttpError(404, 'Branch not found');
    return { body: { name: found.name, commit: { sha: found.sha }, protected: false } };
  }

  if (tail[0] === 'commits') {
    if (tail.length === 1) {
      const ref = query.get('sha') || query.get('ref');
      let tip = null;
      if (ref) {
        tip = repo.refs.get(`refs/heads/${ref}`) || repo.refs.get(ref) || (repo.read(ref) ? ref : null);
      } else {
        tip = repo.tip();
      }
      const chain = tip ? commitChain(repo, tip, 100) : [];
      const page = pageOf(chain, query);
      const header = linkHeader(url, page);
      return { body: page.items, headers: header ? { link: header } : {} };
    }
    const sha = tail[1];
    const json = commitJson(repo, sha);
    if (!json) throw new HttpError(404, 'Not Found');
    return { body: json };
  }

  if (tail[0] === 'git') {
    if (tail[1] === 'refs') {
      if (method === 'POST') {
        const body = readBody(ctx);
        let ref = typeof body.ref === 'string' ? body.ref : '';
        if (!ref) throw new HttpError(422, 'ref is required');
        if (!ref.startsWith('refs/')) ref = ref.startsWith('heads/') || ref.startsWith('tags/') ? `refs/${ref}` : `refs/heads/${ref}`;
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!sha || !repo.read(sha)) throw new HttpError(422, 'sha is required');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, node_id: `R_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs${ref.slice(4)}`, object: { sha, type: repo.read(sha).type, url: '' } } };
      }
      const refs = [...repo.refs].map(([ref, sha]) => ({ ref, node_id: `R_${ref}`, object: { sha, type: repo.read(sha) ? repo.read(sha).type : 'commit' } }));
      return { body: refs };
    }
    if (tail[1] === 'commits' && tail.length === 3) {
      const json = commitJson(repo, tail[2]);
      if (!json) throw new HttpError(404, 'Not Found');
      return { body: json };
    }
    if (tail[1] === 'trees' && tail.length === 3) {
      const obj = repo.read(tail[2]);
      if (!obj || obj.type !== 'tree') throw new HttpError(404, 'Not Found');
      const tree = parseTree(obj.content).map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: isTreeMode(entry.mode) ? 'tree' : 'blob',
        sha: entry.sha,
        size: undefined,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isTreeMode(entry.mode) ? 'trees' : 'blobs'}/${entry.sha}`,
      }));
      return { body: { sha: tail[2], url: '', tree, truncated: false } };
    }
    if (tail[1] === 'blobs' && tail.length === 3) {
      const obj = repo.read(tail[2]);
      if (!obj) throw new HttpError(404, 'Not Found');
      return { body: { sha: tail[2], size: obj.content.length, content: b64(obj.content), encoding: 'base64' } };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).map(decodeURIComponent).join('/');
    const ref = query.get('ref');
    const branch = ref ? (repo.refs.has(`refs/heads/${ref}`) ? ref : ref) : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`) || (repo.read(branch) ? branch : null);
    const treeSha = tip ? repo.treeOf(tip) : null;

    if (method === 'GET') {
      if (!treeSha) throw new HttpError(404, 'Not Found');
      if (!path) {
        const entries = parseTree(repo.read(treeSha).content).map((entry) => ({
          name: entry.name,
          path: entry.name,
          sha: entry.sha,
          size: repo.read(entry.sha) ? repo.read(entry.sha).content.length : 0,
          type: isTreeMode(entry.mode) ? 'dir' : 'file',
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
        }));
        return { body: entries };
      }
      const found = repo.lookup(treeSha, path);
      if (!found) throw new HttpError(404, 'Not Found');
      if (found.type === 'tree') {
        const entries = parseTree(repo.read(found.sha).content).map((entry) => ({
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.sha,
          size: repo.read(entry.sha) ? repo.read(entry.sha).content.length : 0,
          type: isTreeMode(entry.mode) ? 'dir' : 'file',
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
        }));
        return { body: entries };
      }
      return { body: contentEntry(repo, path, found.sha) };
    }

    if (method === 'PUT') {
      const body = readBody(ctx);
      const message = typeof body.message === 'string' && body.message ? body.message : 'Update file';
      const encoded = typeof body.content === 'string' ? body.content : '';
      const contentBuf = Buffer.from(encoded.replace(/\n/g, ''), 'base64');
      const targetBranch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
      const result = commitChange(repo, {
        branch: targetBranch,
        path,
        contentBuf,
        message,
        login: ctx.login,
        body,
        remove: false,
        expectedSha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      const entry = contentEntry(repo, path, result.blobSha);
      return {
        status: result.created ? 201 : 200,
        body: { content: entry, commit: { sha: result.commit, node_id: result.commit, message, author: { name: ctx.login, email: `${ctx.login}@forge.local`, date: new Date().toISOString() }, committer: { name: ctx.login, email: `${ctx.login}@forge.local`, date: new Date().toISOString() }, tree: { sha: repo.treeOf(result.commit) }, parents: [] } },
      };
    }

    if (method === 'DELETE') {
      const body = readBody(ctx);
      const message = typeof body.message === 'string' && body.message ? body.message : 'Delete file';
      const targetBranch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
      const result = commitChange(repo, {
        branch: targetBranch,
        path,
        contentBuf: null,
        message,
        login: ctx.login,
        body,
        remove: true,
        expectedSha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      return { body: { content: null, commit: { sha: result.commit, message, tree: { sha: repo.treeOf(result.commit) } } } };
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = readBody(ctx);
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (!labelName) throw new HttpError(422, 'name is required');
      const existing = repo.labels.find((l) => l.name === labelName);
      if (existing) return { status: 201, body: labelJson(repo, labelName) };
      repo.labels.push({ id: 300000 + repo.labels.length, name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' });
      return { status: 201, body: labelJson(repo, labelName) };
    }
    if (method === 'GET') return { body: repo.labels.map((l) => labelJson(repo, l.name)) };
    throw new HttpError(404, 'Not Found');
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = readBody(ctx);
        const title = typeof body.title === 'string' ? body.title : '';
        if (!title) throw new HttpError(422, 'title is required');
        const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
        for (const labelName of labels) {
          if (!repo.labels.some((l) => l.name === labelName)) throw new HttpError(422, `Validation Failed: label ${labelName} does not exist`);
        }
        const issue = {
          id: (repo.nextIssueId = (repo.nextIssueId || 100000) + 1),
          number: newIssueNumber(repo),
          title,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          labels,
          user: { login: ctx.login, id: 1, type: 'User' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          closedAt: null,
        };
        repo.issues.push(issue);
        if (typeof body.assignee === 'string') issue.assignee = body.assignee;
        return { status: 201, body: issueJson(repo, issue) };
      }
      if (method === 'GET') {
        const state = query.get('state') || 'open';
        const sort = query.get('sort') || 'created';
        const direction = (query.get('direction') || 'desc').toLowerCase();
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        list = [...list].sort((a, b) => {
          let value;
          if (sort === 'created') value = a.number - b.number;
          else if (sort === 'updated') value = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
          else value = a.number - b.number;
          return direction === 'asc' ? value : -value;
        });
        const page = pageOf(list, query);
        const header = linkHeader(url, page);
        return { body: page.items.map((i) => issueJson(repo, i)), headers: header ? { link: header } : {} };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    const issue = requireIssue(repo, tail[1]);
    if (tail.length === 2) {
      if (method === 'GET') {
        const version = `${issue.updatedAt}|${(repo.comments.get(issue.number) || []).length}|${issue.state}`;
        if (issue._cache && issue._cache.version === version) return { text: issue._cache.text };
        const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
        issue._cache = { version, text };
        return { text };
      }
      if (method === 'PATCH') {
        const body = readBody(ctx);
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string') {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
        }
        if (Array.isArray(body.labels)) {
          for (const labelName of body.labels) {
            if (!repo.labels.some((l) => l.name === labelName)) throw new HttpError(422, `Validation Failed: label ${labelName} does not exist`);
          }
          issue.labels = body.labels.filter((l) => typeof l === 'string');
        }
        issue.updatedAt = new Date().toISOString();
        return { body: issueJson(repo, issue) };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    if (tail[2] === 'comments') {
      const list = repo.comments.get(issue.number) || [];
      if (method === 'POST') {
        const body = readBody(ctx);
        const comment = {
          id: ++repo.nextComment,
          body: typeof body.body === 'string' ? body.body : '',
          user: { login: ctx.login, id: 1, type: 'User' },
          createdAt: new Date().toISOString(),
        };
        list.push(comment);
        repo.comments.set(issue.number, list);
        issue.updatedAt = new Date().toISOString();
        return { status: 201, body: commentJson(repo, issue.number, comment) };
      }
      if (method === 'GET') {
        const page = pageOf(list, query);
        return { body: page.items.map((c) => commentJson(repo, issue.number, c)) };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    throw new HttpError(404, 'Not Found');
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = readBody(ctx);
        const title = typeof body.title === 'string' ? body.title : '';
        const headRaw = typeof body.head === 'string' ? body.head : '';
        const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const headRef = headRaw.includes(':') ? headRaw.split(':').pop() : headRaw;
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRaw}`);
        if (!headRef) throw new HttpError(422, 'head is required');
        if (!headSha) throw new HttpError(422, 'Validation Failed: head ref does not exist');
        if (!baseSha) throw new HttpError(422, 'Validation Failed: base ref does not exist');
        const pull = {
          id: 500000 + repo.pulls.length,
          number: repo.nextPull++,
          title: title || headRef,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          user: { login: ctx.login, id: 1, type: 'User' },
          head: headRef,
          headSha,
          base: baseRaw,
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
        pull.files = diffTrees(repo, repo.treeOf(baseSha), repo.treeOf(headSha));
        pull.additions = pull.files.reduce((sum, f) => sum + f.additions, 0);
        pull.deletions = pull.files.reduce((sum, f) => sum + f.deletions, 0);
        pull.conflict = conflictsBetween(repo, baseSha, headSha);
        repo.pulls.push(pull);
        return { status: 201, body: pullJson(repo, pull) };
      }
      if (method === 'GET') {
        const state = query.get('state') || 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        const page = pageOf(list, query);
        const header = linkHeader(url, page);
        return { body: page.items.map((p) => pullJson(repo, p)), headers: header ? { link: header } : {} };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    const pull = requirePull(repo, tail[1]);
    if (tail.length === 2) {
      if (method === 'GET') return { body: pullJson(repo, pull) };
      if (method === 'PATCH') {
        const body = readBody(ctx);
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (typeof body.state === 'string') {
          pull.state = body.state;
          pull.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
        }
        pull.updatedAt = new Date().toISOString();
        return { body: pullJson(repo, pull) };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    if (tail[2] === 'files') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return { body: pull.files };
    }
    if (tail[2] === 'merge') {
      if (method !== 'PUT') throw new HttpError(405, 'Method Not Allowed');
      if (pull.merged) return { body: { sha: pull.mergeSha, merged: true, message: 'Pull Request successfully merged' } };
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (!baseTip || !headTip) throw new HttpError(404, 'Not Found');
      const conflict = conflictsBetween(repo, baseTip, headTip);
      if (conflict) throw new HttpError(405, 'Pull Request is not mergeable');
      const flat = repo.flatten(repo.treeOf(baseTip));
      for (const [path, entry] of repo.flatten(repo.treeOf(headTip))) flat.set(path, entry);
      const tree = repo.writeTreeFrom(flat);
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
      const commit = makeCommit(repo, { tree, parents: [baseTip], message, login: ctx.login, body: {} });
      repo.refs.set(`refs/heads/${pull.base}`, commit);
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeSha = commit;
      pull.state = 'closed';
      pull.closedAt = pull.mergedAt;
      pull.baseSha = commit;
      // the merged branch keeps its head; the pull reports the merge
      return { body: { sha: commit, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (tail[2] === 'commits') {
      const chain = commitChain(repo, pull.headSha, 100);
      return { body: chain };
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

export { HttpError, loginFromToken };