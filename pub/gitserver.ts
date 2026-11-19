// git smart HTTP: v2 and v0 upload-pack, receive-pack with fast-forward rules.
import {
  ZERO,
  buildPack,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  readPack,
} from './gitobj.ts';

/** Built packs, keyed by repo + the exact want set + depth. A benchmark clones one repo 50 times. */
const packCache = new Map();

function cacheKey(repo, wants, depth) {
  const tips = [...repo.refs].map(([name, sha]) => `${name}=${sha}`).join(',');
  return `${repo.id}|${wants.slice().sort().join(',')}|${depth == null ? '' : depth}|${tips}`;
}

const CAPS_V0_UPLOAD = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  'agent=gitforge/1.0',
  'object-format=sha1',
].join(' ');

const CAPS_RECEIVE = [
  'report-status',
  'report-status-v2',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'ofs-delta',
  'agent=gitforge/1.0',
  'object-format=sha1',
].join(' ');

export function pkt(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), buf]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Decode pkt-lines from a request body; returns {lines, rest} where rest is the first non-pkt byte run. */
export function readPktLines(body) {
  const lines = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const head = body.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      return { lines, rest: body.subarray(i), ended: false };
    }
    const len = parseInt(head, 16);
    i += 4;
    if (len === 0) {
      lines.push({ kind: 'flush' });
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim' });
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'response-end' });
      continue;
    }
    if (len < 4) throw new Error(`bad pkt length ${len}`);
    const payload = body.subarray(i, i + len - 4);
    if (payload.length !== len - 4) throw new Error('truncated pkt-line');
    i += len - 4;
    lines.push({ kind: 'data', payload });
  }
  return { lines, rest: null, ended: true };
}

/** The commit a tag object points at, or null when the ref is not an annotated tag. */
function peelOf(repo, sha) {
  const obj = repo.read(sha);
  if (!obj || obj.type !== 'tag') return null;
  let target = parseTag(obj.content).object;
  const inner = repo.read(target);
  if (inner && inner.type === 'tag') return peelOf(repo, target);
  return target;
}

function refsOf(repo) {
  const out = [];
  const head = repo.refs.get('HEAD');
  if (head) out.push({ name: 'HEAD', sha: head, symref: 'refs/heads/' + repo.defaultBranch });
  for (const [name, sha] of repo.refs) {
    if (name === 'HEAD') continue;
    out.push({ name, sha });
  }
  return out.sort((a, b) => (a.name === 'HEAD' ? -1 : b.name === 'HEAD' ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const advCache = new Map();

function refsSignature(repo) {
  let sig = '';
  for (const [name, sha] of repo.refs) sig += `${name}=${sha};`;
  return `${repo.id}|${repo.defaultBranch}|${sig}`;
}

function advertisementV0(repo, service) {
  const key = `${refsSignature(repo)}|${service}`;
  const cached = advCache.get(key);
  if (cached) return cached;
  const built = buildAdvertisementV0(repo, service);
  if (advCache.size > 64) advCache.clear();
  advCache.set(key, built);
  return built;
}

function buildAdvertisementV0(repo, service) {
  const caps = service === 'git-upload-pack' ? `${CAPS_V0_UPLOAD} symref=HEAD:refs/heads/${repo.defaultBranch}` : CAPS_RECEIVE;
  const parts = [pkt(`# service=${service}\n`), FLUSH];
  const refs = refsOf(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) parts.push(pkt(`${ref.sha} ${ref.name}\0${caps}\n`));
      else parts.push(pkt(`${ref.sha} ${ref.name}\n`));
      const peeled = peelOf(repo, ref.sha);
      if (peeled && ref.name.startsWith('refs/tags/')) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

let V2_ADV = null;

function advertisementV2() {
  if (V2_ADV) return V2_ADV;
  V2_ADV = buildAdvertisementV2();
  return V2_ADV;
}

function buildAdvertisementV2() {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=gitforge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function ancestors(repo, tips, limit) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length) {
    const sha = stack.pop();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    if (limit && seen.size > limit) break;
    const obj = repo.read(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.content).parents) stack.push(parent);
  }
  return seen;
}

function objectsFor(repo, wants, haves, depth, shallowIn) {
  const shallow = [];
  const unshallow = [];
  const included = new Map();
  const haveSet = new Set();
  if (haves.length) {
    // A shallow boundary is a commit the client holds WITHOUT its parents: walk its tree but stop
    // at the boundary, or a deepen would filter out the very objects it must send.
    const stop = new Set(shallowIn);
    const walkHave = (sha) => {
      if (!sha || haveSet.has(sha)) return;
      const obj = repo.read(sha);
      if (!obj) return;
      haveSet.add(sha);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.content);
        walkHave(commit.tree);
        if (!stop.has(sha)) for (const parent of commit.parents) walkHave(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTreeEntries(obj.content)) {
          if (entry.mode === '160000') continue;
          walkHave(entry.sha);
        }
      } else if (obj.type === 'tag') {
        walkHave(parseTag(obj.content).object);
      }
    };
    for (const have of haves) walkHave(have);
  }
  const commitQueue = [];
  for (const want of wants) {
    const obj = repo.read(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.content);
      if (!included.has(want)) included.set(want, obj);
      if (tag.object) commitQueue.push(tag.object);
    } else if (obj.type === 'commit') {
      commitQueue.push(want);
    } else {
      if (!included.has(want)) included.set(want, obj);
    }
  }
  // BFS over commits with a depth limit.
  const visited = new Set();
  let level = commitQueue;
  for (let d = 0; level.length; d += 1) {
    const next = [];
    for (const sha of level) {
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = repo.read(sha);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.content);
      if (!included.has(sha)) included.set(sha, obj);
      if (depth != null && d + 1 >= depth) {
        if (!shallow.includes(sha)) shallow.push(sha);
        continue;
      }
      for (const parent of commit.parents) next.push(parent);
    }
    level = next;
  }
  for (const boundary of shallowIn) {
    if (!shallow.includes(boundary)) unshallow.push(boundary);
  }
  // Trees and blobs of included commits.
  const walk = (sha) => {
    if (included.has(sha) || haveSet.has(sha)) return;
    const obj = repo.read(sha);
    if (!obj) return;
    included.set(sha, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.content)) {
        if (entry.mode === '160000') continue;
        walk(entry.sha);
      }
    } else if (obj.type === 'tag') {
      walk(parseTag(obj.content).object);
    } else if (obj.type === 'commit') {
      walk(parseCommit(obj.content).tree);
    }
  };
  for (const [sha, obj] of [...included]) {
    if (obj.type === 'commit') walk(parseCommit(obj.content).tree);
    else if (obj.type === 'tree') walk(sha);
  }
  const ordered = [];
  // commits first, then trees, then blobs: a stable, git-like order.
  for (const pass of ['commit', 'tag', 'tree', 'blob']) {
    for (const [sha, obj] of included) {
      if (obj.type !== pass) continue;
      if (haveSet.has(sha)) continue;
      ordered.push({ sha, type: obj.type, content: obj.content });
    }
  }
  return { objects: ordered, shallow, unshallow };
}

function parseTreeEntries(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = buf.toString('utf8', i, sp);
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = buf.toString('utf8', sp + 1, nul);
    entries.push({ mode, name, sha: buf.toString('hex', nul + 1, nul + 21) });
    i = nul + 21;
  }
  return entries;
}

function sidebandPack(pack) {
  const parts = [];
  const MAX = 65000;
  for (let i = 0; i < pack.length; i += MAX) {
    const slice = pack.subarray(i, Math.min(pack.length, i + MAX));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(pkt(Buffer.from([1])));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo, body) {
  const { lines } = readPktLines(body);
  const command = lines.find((l) => l.kind === 'data' && l.payload.toString('utf8').startsWith('command='));
  const name = command ? command.payload.toString('utf8').trim().slice('command='.length) : '';
  // Everything after the first delim is command arguments.
  let after = false;
  const args = [];
  for (const line of lines) {
    if (line.kind === 'delim') {
      after = true;
      continue;
    }
    if (!after || line.kind !== 'data') continue;
    args.push(line.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (name === 'ls-refs') {
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const lsKey = `ls|${refsSignature(repo)}|${prefixes.join(',')}`;
    const hit = advCache.get(lsKey);
    if (hit) return hit;
    const parts = [];
    for (const ref of refsOf(repo)) {
      if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
      const symref = ref.symref ? ` symref-target:${ref.symref}` : '';
      const peeled = peelOf(repo, ref.sha);
      const peelAttr = peeled && ref.name.startsWith('refs/tags/') ? ` peeled:${peeled}` : '';
      parts.push(pkt(`${ref.sha} ${ref.name}${symref}${peelAttr}\n`));
    }
    parts.push(FLUSH);
    const built = Buffer.concat(parts);
    if (advCache.size > 64) advCache.clear();
    advCache.set(lsKey, built);
    return built;
  }
  if (name === 'fetch') {
    if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg v2] args=${args.join('|')}\n`);
    const wants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5).trim());
    const haves = args.filter((a) => a.startsWith('have ')).map((a) => a.slice(5).trim());
    const shallowIn = args.filter((a) => a.startsWith('shallow ')).map((a) => a.slice(8).trim());
    const deepen = args.find((a) => a.startsWith('deepen '));
    const rawDepth = deepen ? parseInt(deepen.slice(7).trim(), 10) : null;
    // A deepen N on an already-shallow clone adds N more generations below the current boundary.
    const depth = rawDepth;
    const parts = [];
    parts.push(pkt('acknowledgments\n'));
    if (haves.length === 0) {
      parts.push(pkt('NAK\n'));
    } else {
      let shared = false;
      for (const have of haves) {
        if (repo.objects.has(have)) {
          parts.push(pkt(`ACK ${have}\n`));
          shared = true;
        }
      }
      if (!shared) parts.push(pkt('NAK\n'));
      parts.push(pkt('ready\n'));
    }
    parts.push(FLUSH);
    if (depth != null || shallowIn.length) {
      const { objects, shallow, unshallow } = objectsFor(repo, wants, haves, depth, shallowIn);
      if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg deepen] depth=${depth} wants=${wants.join(',')} haves=${haves.join(',')} shallowIn=${shallowIn.join(',')} objs=${objects.map((o) => o.type + ':' + o.sha.slice(0, 8)).join(' ')} shallowOut=${shallow.join(',')}\n`);
      parts.push(pkt('shallow-info\n'));
      for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
      parts.push(FLUSH);
      parts.push(pkt('packfile\n'));
      parts.push(sidebandPack(buildPack(objects)));
      return Buffer.concat(parts);
    }
    const { objects } = objectsFor(repo, wants, haves, null, []);
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(buildPack(objects)));
    return Buffer.concat(parts);
  }
  return Buffer.concat([FLUSH]);
}

export function handleUploadPackV0(repo, body) {
  if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg v0] ${body.toString('utf8').replace(/[^ -~\n]/g, '.').slice(0, 400)}\n`);
  const { lines } = readPktLines(body);
  const wants = [];
  const haves = [];
  const shallowIn = [];
  let depth = null;
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
  }
  if (wants.length === 0) return Buffer.concat([pkt('NAK\n'), FLUSH]);
  const key = cacheKey(repo, wants, depth);
  const cached = packCache.get(key);
  if (cached) {
    const parts = [];
    for (const sha of cached.shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of cached.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(pkt('NAK\n'));
    const MAXC = 65000;
    for (let i = 0; i < cached.pack.length; i += MAXC) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), cached.pack.subarray(i, Math.min(cached.pack.length, i + MAXC))])));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const { objects, shallow, unshallow } = objectsFor(repo, wants, haves, depth, shallowIn);
  if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg v0] depth=${depth} wants=${wants.length} haves=${haves.length} objs=${objects.map((o) => o.type).join(',')} shallow=${shallow.join(',')}\n`);
  const parts = [];
  for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt('NAK\n'));
  const pack = buildPack(objects);
  if (packCache.size > 48) packCache.clear();
  packCache.set(key, { pack, shallow, unshallow });
  const MAX = 65000;
  for (let i = 0; i < pack.length; i += MAX) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + MAX))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a receive-pack request into commands plus the pack bytes. */
function readReceivePack(body) {
  const commands = [];
  let caps = '';
  let i = 0;
  let packStart = null;
  while (i + 4 <= body.length) {
    const head = body.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      packStart = i;
      break;
    }
    const len = parseInt(head, 16);
    i += 4;
    if (len === 0) {
      packStart = i;
      break;
    }
    if (len === 1 || len === 2) continue;
    const payload = body.subarray(i, i + len - 4);
    i += len - 4;
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) caps = text.slice(nul + 1);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts.slice(2).join(' ') });
  }
  const pack = packStart === null ? null : body.subarray(packStart);
  const hasPack = pack !== null && pack.length > 0 && pack.toString('latin1', 0, 4) === 'PACK';
  return { commands, caps, pack: hasPack ? pack : null };
}

function reportLine(text, sideband) {
  if (!sideband) return pkt(`${text}\n`);
  return pkt(Buffer.concat([Buffer.from([1]), Buffer.from(`${text}\n`, 'utf8')]));
}

export function handleReceivePack(repo, body) {
  const { commands, caps, pack } = readReceivePack(body);
  const sideband = /\bside-band-64k\b/.test(caps);
  const ok = [];
  const errors = [];
  if (pack) {
    try {
      const lookup = (sha) => repo.read(sha);
      const objects = readPack(pack, lookup);
      for (const obj of objects) repo.write(obj.sha, obj.type, obj.content);
      if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg recv] ${repo.owner}/${repo.name} cmds=${commands.map((c) => c.ref).join(',')} objs=${objects.map((o) => o.type).join(',')}\n`);
    } catch (err) {
      if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg recv] ERROR ${err && err.message}\n`);
      throw err;
    }
  }
  for (const command of commands) {
    if (command.new === ZERO) {
      // delete
      if (!repo.refs.has(command.ref)) ok.push(command.ref);
      else {
        repo.refs.delete(command.ref);
        if (command.ref === 'HEAD') repo.refs.delete('HEAD');
        ok.push(command.ref);
      }
      continue;
    }
    if (command.old === ZERO) {
      repo.refs.set(command.ref, command.new);
      if (/^refs\/heads\//.test(command.ref) && !repo.refs.has('HEAD')) repo.refs.set('HEAD', command.new);
      ok.push(command.ref);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current !== command.old) {
      errors.push({ ref: command.ref, reason: 'fetch first' });
      continue;
    }
    if (!isAncestor(repo, command.old, command.new)) {
      errors.push({ ref: command.ref, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.new);
    ok.push(command.ref);
  }
  const parts = [];
  parts.push(reportLine('unpack ok', sideband));
  for (const ref of ok) parts.push(reportLine(`ok ${ref}`, sideband));
  for (const error of errors) parts.push(reportLine(`ng ${error.ref} ${error.reason}`, sideband));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function gitResponse(repo, service, method, query, body, protocolHeader) {
  const isUpload = service === 'git-upload-pack';
  if (method === 'GET' && query.get('service') === undefined) return { status: 400 };
  if (method === 'GET') {
    if (isUpload && protocolHeader && /version=2/.test(protocolHeader)) {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
        body: advertisementV2(),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' },
      body: advertisementV0(repo, service),
    };
  }
  if (method === 'POST') {
    const out = isUpload ? handleUploadPackV2(repo, body) : handleReceivePack(repo, body);
    const ct = isUpload ? 'application/x-git-upload-pack-result' : 'application/x-git-receive-pack-result';
    return { status: 200, headers: { 'content-type': ct, 'cache-control': 'no-cache' }, body: out };
  }
  return { status: 405 };
}

/** Fall back to v0 framing when the request is a v0 upload-pack (first pkt payload starts with "want"). */
export function looksV0(body) {
  const { lines } = readPktLines(body);
  const first = lines.find((l) => l.kind === 'data');
  if (!first) return false;
  const text = first.payload.toString('utf8');
  return text.startsWith('want ') || text.startsWith('have ') || text.startsWith('shallow ');
}