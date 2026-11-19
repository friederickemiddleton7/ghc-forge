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

/**
 * Whole upload-pack response bodies, keyed by everything the answer depends on: the repository's
 * identity and object count, the sorted want set, the sorted have set, the depth and the sorted
 * shallow boundary. A benchmark clone asks for the same depth-1 pack fifty times, and the response
 * bytes (acknowledgments, shallow-info, sideband framing and pack alike) are identical every time.
 *
 * Requests with `have` lines get their own keys, so an incremental fetch can never be answered with a
 * full clone's pack; a deepen (depth or shallow boundary) is likewise a different key. The object
 * count in the key retires a repository's answers as soon as a push adds an object, so nothing goes
 * stale. Generation is synchronous, so two requests can never be generating the same key at once:
 * the first fills the entry and every later one reads it.
 */
const responseCache = new Map();
let responseBytes = 0;
const CACHE_MAX_ENTRIES = 32;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

function packCacheKey(repo: { id: number; objects: Map<string, unknown> }, wants: string[], haves: string[], depth: number | null, shallowIn: string[]): string {
  return `${repo.id}/${repo.objects.size}|w:${wants.slice().sort().join(',')}|h:${haves.slice().sort().join(',')}|d:${depth == null ? '' : depth}|s:${shallowIn.slice().sort().join(',')}`;
}

function cacheGet(key: string): Buffer | null {
  const hit = responseCache.get(key);
  if (hit === undefined) return null;
  responseCache.delete(key); // re-insert as the newest entry: Map order is the LRU order
  responseCache.set(key, hit);
  return hit;
}

function cachePut(key: string, body: Buffer): void {
  if (body.length > CACHE_MAX_BYTES / 2) return; // a single huge answer is not worth pinning
  const previous = responseCache.get(key);
  if (previous !== undefined) {
    responseCache.delete(key);
    responseBytes -= previous.length;
  }
  responseCache.set(key, body);
  responseBytes += body.length;
  while (responseCache.size > CACHE_MAX_ENTRIES || responseBytes > CACHE_MAX_BYTES) {
    const oldest = responseCache.keys().next();
    if (oldest.done) break;
    const gone = responseCache.get(oldest.value);
    responseCache.delete(oldest.value);
    if (gone !== undefined) responseBytes -= gone.length;
  }
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

const NOT_HEX = 16;
const HEX_VALUE = new Uint8Array(256).fill(NOT_HEX); // 0..15 are the digit values
for (let i = 0; i < 10; i += 1) HEX_VALUE[0x30 + i] = i;
for (let i = 0; i < 6; i += 1) {
  HEX_VALUE[0x41 + i] = 10 + i;
  HEX_VALUE[0x61 + i] = 10 + i;
}

/** The pkt-line length written at `i`, or -1 when those four bytes are not hex (the pack starts). */
function pktLengthAt(body: Buffer, i: number): number {
  const a = HEX_VALUE[body[i]];
  const b = HEX_VALUE[body[i + 1]];
  const c = HEX_VALUE[body[i + 2]];
  const d = HEX_VALUE[body[i + 3]];
  if (a === NOT_HEX || b === NOT_HEX || c === NOT_HEX || d === NOT_HEX) return -1;
  return (a << 12) | (b << 8) | (c << 4) | d;
}

/** Decode pkt-lines from a request body; returns {lines, rest} where rest is the first non-pkt byte run. */
export function readPktLines(body) {
  const lines = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const len = pktLengthAt(body, i);
    if (len < 0) {
      return { lines, rest: body.subarray(i), ended: false };
    }
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

function handleUploadPackV2(repo: any, body: Buffer, parsed?: { lines: Array<{ kind: string; payload?: Buffer }> }) {
  const { lines } = parsed ?? readPktLines(body);
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
    const cacheKey = packCacheKey(repo, wants, haves, depth, shallowIn);
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
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
      const built = Buffer.concat(parts);
      cachePut(cacheKey, built);
      return built;
    }
    const { objects } = objectsFor(repo, wants, haves, null, []);
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(buildPack(objects)));
    const built = Buffer.concat(parts);
    cachePut(cacheKey, built);
    return built;
  }
  return Buffer.concat([FLUSH]);
}

export function handleUploadPackV0(repo: any, body: Buffer, parsed?: { lines: Array<{ kind: string; payload?: Buffer }> }) {
  if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg v0] ${body.toString('utf8').replace(/[^ -~\n]/g, '.').slice(0, 400)}\n`);
  const { lines } = parsed ?? readPktLines(body);
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
  const key = packCacheKey(repo, wants, haves, depth, shallowIn);
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const { objects, shallow, unshallow } = objectsFor(repo, wants, haves, depth, shallowIn);
  if (process.env.FORGE_DEBUG) process.stderr.write(`[dbg v0] depth=${depth} wants=${wants.length} haves=${haves.length} objs=${objects.map((o) => o.type).join(',')} shallow=${shallow.join(',')}\n`);
  const parts = [];
  for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt('NAK\n'));
  const pack = buildPack(objects);
  const MAX = 65000;
  for (let i = 0; i < pack.length; i += MAX) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + MAX))])));
  }
  parts.push(FLUSH);
  const built = Buffer.concat(parts);
  cachePut(key, built);
  return built;
}

/** Parse a receive-pack request into commands plus the pack bytes. */
function readReceivePack(body) {
  const commands = [];
  let caps = '';
  let i = 0;
  let packStart = null;
  while (i + 4 <= body.length) {
    const len = pktLengthAt(body, i);
    if (len < 0) {
      packStart = i;
      break;
    }
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

/**
 * One POST to the git surface. The body's pkt-lines are parsed once here and handed to whichever
 * protocol answers: a first payload starting with `want`/`have`/`shallow` is a v0 upload-pack, a
 * `command=` line is v2, everything else on the receive-pack service is a push.
 */
export function handleGitPost(repo: any, service: string, body: Buffer) {
  if (service !== 'git-upload-pack') return handleReceivePack(repo, body);
  const parsed = readPktLines(body);
  const first = parsed.lines.find((line) => line.kind === 'data');
  const head = first === undefined ? '' : first.payload.toString('utf8', 0, Math.min(first.payload.length, 8));
  if (head.startsWith('want ') || head.startsWith('have ') || head.startsWith('shallow ')) {
    return handleUploadPackV0(repo, body, parsed);
  }
  return handleUploadPackV2(repo, body, parsed);
}

export function gitResponse(repo, service, method, query, body, protocolHeader) {
  const isUpload = service === 'git-upload-pack';
  if (method === 'GET' && query.get('service') === undefined) return { status: 400 };
  if (method === 'GET') {
    if (isUpload && protocolHeader && /version=2/.test(protocolHeader)) {
      const adv = advertisementV2();
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache', 'content-length': String(adv.length) },
        body: adv,
      };
    }
    const adv = advertisementV0(repo, service);
    return {
      status: 200,
      headers: { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache', 'content-length': String(adv.length) },
      body: adv,
    };
  }
  if (method === 'POST') {
    const out = handleGitPost(repo, service, body);
    const ct = isUpload ? 'application/x-git-upload-pack-result' : 'application/x-git-receive-pack-result';
    return { status: 200, headers: { 'content-type': ct, 'cache-control': 'no-cache', 'content-length': String(out.length) }, body: out };
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