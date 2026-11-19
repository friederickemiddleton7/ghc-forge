// The forge's own store: repositories, their objects, refs, issues, labels and pulls. In memory only.
import { buildTree, hashObject, parseCommit, parseTag, parseTree } from './gitobj.ts';

let nextRepoId = 1000;

/** Git writes a subtree's mode as "40000"; accept both spellings. */
export function isTreeMode(mode) {
  return mode === '40000' || mode === '040000';
}

/** The GraphQL global id for a node: base64("<04:Kind><id>"), stable across reads. */
export function globalId(kind, id) {
  return Buffer.from(`04:${kind}${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(value) {
  try {
    const text = Buffer.from(String(value), 'base64').toString('utf8');
    const m = /^04:([A-Za-z]+)(\d+)$/.exec(text);
    if (!m) return null;
    return { kind: m[1], id: Number(m[2]) };
  } catch {
    return null;
  }
}
let nextCommentId = 200000;
let nextLabelId = 300000;

export class Repo {
  constructor(owner, name) {
    this.id = nextRepoId++;
    this.owner = owner;
    this.name = name;
    this.description = '';
    this.private = false;
    this.defaultBranch = 'main';
    this.objects = new Map();
    this.refs = new Map();
    this.issues = [];
    this.labels = [];
    this.pulls = [];
    this.comments = new Map();
    this.createdAt = new Date().toISOString();
    this.nextNumber = 1;
    this.nextPull = 1;
    this.nextComment = nextCommentId;
  }

  read(sha) {
    const obj = this.objects.get(sha);
    if (!obj) return null;
    return obj;
  }

  write(sha, type, content) {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, content });
    return sha;
  }

  writeObject(type, content) {
    const sha = hashObject(type, content);
    return this.write(sha, type, content);
  }

  tip(ref) {
    return this.refs.get(ref || `refs/heads/${this.defaultBranch}`) || null;
  }

  branchRefs() {
    const out = [];
    for (const [name, sha] of this.refs) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha });
    }
    return out;
  }

  /** The tree sha of a commit-ish, or null. */
  treeOf(sha) {
    const obj = this.read(sha);
    if (!obj) return null;
    if (obj.type === 'commit') return parseCommit(obj.content).tree;
    if (obj.type === 'tree') return sha;
    if (obj.type === 'tag') return this.treeOf(parseTag(obj.content).object);
    return null;
  }

  /** Flat path -> {sha, mode} map of a tree. */
  flatten(treeSha, prefix = '', out = new Map()) {
    const obj = this.read(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.content)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isTreeMode(entry.mode)) this.flatten(entry.sha, path, out);
      else if (entry.mode === '160000') out.set(path, { sha: entry.sha, mode: entry.mode });
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** Build trees for a flat path map; returns the root tree sha. */
  writeTreeFrom(flat) {
    const root = {};
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        node[parts[i]] = node[parts[i]] || { children: {} };
        node = node[parts[i]].children;
      }
      node[parts[parts.length - 1]] = { sha: entry.sha, mode: entry.mode || '100644' };
    }
    const build = (node) => {
      const entries = [];
      for (const name of Object.keys(node).sort()) {
        const value = node[name];
        if (value.children) entries.push({ mode: '40000', name, sha: build(value.children) });
        else entries.push({ mode: value.mode, name, sha: value.sha });
      }
      return this.writeObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Follow a path inside a tree: {type: 'blob'|'tree', sha}. */
  lookup(treeSha, path) {
    const parts = path.split('/').filter(Boolean);
    let current = treeSha;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.read(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.content).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        return { type: isTreeMode(entry.mode) ? 'tree' : 'blob', sha: entry.sha, mode: entry.mode };
      }
      current = entry.sha;
    }
    return { type: 'tree', sha: current };
  }
}

export class Store {
  constructor() {
    this.repos = new Map();
    this.users = new Map();
  }

  key(owner, name) {
    return `${owner}/${name}`.toLowerCase();
  }

  get(owner, name) {
    return this.repos.get(this.key(owner, name)) || null;
  }

  create(owner, name) {
    const existing = this.get(owner, name);
    if (existing) return null;
    const repo = new Repo(owner, name);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  remove(owner, name) {
    return this.repos.delete(this.key(owner, name));
  }

  listOwner(owner) {
    const out = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    return out.sort((a, b) => a.id - b.id);
  }
}

export const store = new Store();

export function newIssueNumber(repo) {
  return repo.nextNumber++;
}

export function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: issue.user,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) || []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    locked: false,
    author_association: 'OWNER',
  };
}

export function labelJson(repo, name) {
  const found = repo.labels.find((l) => l.name === name);
  return { id: found ? found.id : 0, name, color: found ? found.color : 'ededed', default: false };
}

export function repoJson(repo) {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: 1,
    language: 'TypeScript',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    has_downloads: true,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

export function pullFiles(repo, pull) {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) || pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) || pull.baseSha;
  return diffTrees(repo, baseSha ? repo.treeOf(baseSha) : null, headSha ? repo.treeOf(headSha) : null);
}

export function pullJson(repo, pull) {
  const files = pullFiles(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: pull.user,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, repo: repoJson(repo) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    commits: 1,
    additions: pull.additions || 0,
    deletions: pull.deletions || 0,
    changed_files: files.length,
    files,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function linesOf(obj) {
  if (!obj) return 0;
  const text = obj.content.toString('utf8');
  if (!text) return 0;
  return text.split('\n').length;
}

/** The files a pull request changes: path -> status/additions/deletions from two trees. */
export function diffTrees(repo, baseTree, headTree) {
  const base = baseTree ? repo.flatten(baseTree) : new Map();
  const head = headTree ? repo.flatten(headTree) : new Map();
  const files = [];
  for (const [path, entry] of head) {
    const before = base.get(path);
    if (!before) {
      const added = linesOf(repo.read(entry.sha));
      files.push({ filename: path, status: 'added', additions: added, deletions: 0, changes: added, sha: entry.sha, patch: '' });
    } else if (before.sha !== entry.sha) {
      const a = linesOf(repo.read(before.sha));
      const b = linesOf(repo.read(entry.sha));
      files.push({ filename: path, status: 'modified', additions: Math.max(0, b - a), deletions: Math.max(0, a - b), changes: Math.abs(b - a), sha: entry.sha, patch: '' });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) {
      const removed = linesOf(repo.read(entry.sha));
      files.push({ filename: path, status: 'removed', additions: 0, deletions: removed, changes: removed, sha: entry.sha, patch: '' });
    }
  }
  return files;
}

export function commentJson(repo, issueNumber, comment) {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: comment.user,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}