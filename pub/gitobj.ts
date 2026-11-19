// git object model, packfile reader/writer and delta application. No git binary, no deps.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, inflateRawSync } from 'node:zlib';

export const ZERO = '0000000000000000000000000000000000000000';

export function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type, content) {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, content]));
}

export function frame(type, content) {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return Buffer.concat([header, content]);
}

const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function parseCommit(buf) {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out = { tree: '', parents: [], author: '', committer: '', message, headers: [] };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5);
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7));
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
    else if (line) out.headers.push(line);
  }
  return out;
}

export function parseTree(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length) {
    let sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = buf.toString('utf8', i, sp);
    let nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = buf.toString('utf8', sp + 1, nul);
    const sha = buf.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(buf) {
  const text = buf.toString('utf8');
  const out = { object: '', type: '', tag: '', tagger: '', message: '' };
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  out.message = split === -1 ? '' : text.slice(split + 2);
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7);
    else if (line.startsWith('type ')) out.type = line.slice(5);
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

/** Apply one git delta to a base buffer. */
export function applyDelta(base, delta) {
  let p = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    let b;
    do {
      b = delta[p++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset += delta[p++];
      if (op & 0x02) offset += delta[p++] * 256;
      if (op & 0x04) offset += delta[p++] * 65536;
      if (op & 0x08) offset += delta[p++] * 16777216;
      if (op & 0x10) size += delta[p++];
      if (op & 0x20) size += delta[p++] * 256;
      if (op & 0x40) size += delta[p++] * 65536;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op !== 0) {
      delta.copy(out, o, p, p + op);
      p += op;
      o += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  return out;
}

/**
 * Read a packfile. Returns the objects in pack order, resolving ofs/ref deltas against the pack and
 * (for a thin pack) against `lookup(sha) -> {type, content} | null`.
 */
export function readPack(buf, lookup) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const out = [];
  const byOffset = new Map();
  let p = 12;
  while (out.length < count) {
    const start = p;
    let c = buf[p++];
    const type = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = buf[p++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (type === 6) {
      let c2 = buf[p++];
      let off = c2 & 0x7f;
      while (c2 & 0x80) {
        c2 = buf[p++];
        off = ((off + 1) * 128) + (c2 & 0x7f);
      }
      const baseObj = byOffset.get(start - off);
      if (!baseObj) throw new Error(`ofs-delta base at ${start - off} not found`);
      const delta = inflateAt(buf, p, size);
      p = delta.end;
      const content = applyDelta(baseObj.content, delta.data);
      const obj = { type: baseObj.type, content };
      obj.sha = hashObject(obj.type, content);
      byOffset.set(start, obj);
      out.push(obj);
    } else if (type === 7) {
      const baseSha = buf.toString('hex', p, p + 20);
      p += 20;
      const delta = inflateAt(buf, p, size);
      p = delta.end;
      const baseObj = byOffset.get(baseSha) || (lookup ? lookup(baseSha) : null);
      if (!baseObj) throw new Error(`ref-delta base ${baseSha} not found`);
      const content = applyDelta(baseObj.content, delta.data);
      const obj = { type: baseObj.type, content };
      obj.sha = hashObject(obj.type, content);
      byOffset.set(start, obj);
      out.push(obj);
    } else {
      if (!TYPES[type]) throw new Error(`bad object type ${type}`);
      const inflated = inflateAt(buf, p, size);
      p = inflated.end;
      if (inflated.data.length !== size) throw new Error(`object size ${inflated.data.length} != ${size}`);
      const obj = { type: TYPES[type], content: inflated.data };
      obj.sha = hashObject(obj.type, obj.content);
      byOffset.set(start, obj);
      out.push(obj);
    }
  }
  if (!verifyPackChecksum(buf)) throw new Error('pack checksum mismatch');
  return out;
}

function inflateAt(buf, start, expectedSize) {
  const data = inflateSync(buf.subarray(start));
  const len = zlibConsumed(buf, start, data);
  return { data, end: start + len };
}

/** The 4-byte Adler-32 a zlib stream ends with, as a big-endian buffer. */
function adlerTrailer(data) {
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(adler32(data), 0);
  return trailer;
}

/** Adler-32 of a buffer (RFC 1950): the checksum every zlib stream ends with. */
export function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + 3800, buf.length); // keep the sums inside 32 bits before reducing
    for (; i < end; i += 1) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * How many bytes the zlib stream at `start` occupies, given its already-inflated `data`. A zlib
 * stream ends with the big-endian Adler-32 of its output, so the trailer is found by searching for
 * it and confirming the slice inflates to the same answer. The previous bisection over the input
 * range cost a fresh native zlib stream per probe (~10 probes per object), which dominated
 * receive-pack; this is two inflates per object at worst.
 */
function zlibConsumed(buf, start, data) {
  const trailer = adlerTrailer(data);
  let at = buf.indexOf(trailer, start + 2);
  while (at >= 0 && at + 4 <= buf.length) {
    const end = at + 4;
    try {
      if (inflateSync(buf.subarray(start, end)).length === data.length) return end - start;
    } catch {
      // A false positive: the four bytes are inside the compressed stream, not its trailer. Look on.
    }
    at = end < buf.length ? buf.indexOf(trailer, end) : -1;
  }
  // No trailer found (a corrupt or truncated stream): the whole remaining input is the best answer,
  // and the caller's size check rejects it.
  return buf.length - start;
}

export function verifyPackChecksum(buf) {
  if (buf.length < 20) return false;
  const body = buf.subarray(0, buf.length - 20);
  const stated = buf.toString('hex', buf.length - 20);
  return sha1(body) === stated;
}

/**
 * Compressed bytes per object sha. Pack building is the only deflate in the hot path and a benchmark
 * clone re-packs the same trees and blobs for every request, so the deflate is done once per object
 * instead of once per pack. Keyed by sha: the content behind a sha never changes.
 */
const packedCache = new Map();
let packedBytes = 0;
const PACKED_MAX_BYTES = 8 * 1024 * 1024;
const PACKED_MAX_OBJECT = 256 * 1024;

function deflateEntry(obj: { sha?: string; content: Buffer }): Buffer {
  const sha = obj.sha;
  if (typeof sha !== 'string' || obj.content.length > PACKED_MAX_OBJECT) return deflateSync(obj.content, { level: 1 });
  const hit = packedCache.get(sha);
  if (hit !== undefined) return hit;
  const out = deflateSync(obj.content, { level: 1 });
  if (packedBytes + out.length > PACKED_MAX_BYTES) {
    // Drop the whole memo rather than track an eviction order: one repo's objects come back in the
    // same order on the next pack, so a clear costs one re-compression pass, not a resident leak.
    if (out.length > PACKED_MAX_BYTES / 2) return out;
    packedCache.clear();
    packedBytes = 0;
  }
  packedCache.set(sha, out);
  packedBytes += out.length;
  return out;
}

/** Build a packfile from objects (no deltas). */
export function buildPack(objects) {
  const chunks = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const obj of objects) {
    const typeNum = TYPE_NUM[obj.type];
    if (!typeNum) throw new Error(`cannot pack type ${obj.type}`);
    const size = obj.content.length;
    const bytes = [];
    let c = (typeNum << 4) | (size & 0x0f);
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      bytes.push(c | 0x80);
      c = rest & 0x7f;
      rest = Math.floor(rest / 128);
    }
    bytes.push(c);
    chunks.push(Buffer.from(bytes));
    chunks.push(deflateEntry(obj));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Every object reachable from `tips` (commits/tags/trees/blobs), tip first, deduplicated. */
export function collectReachable(repo, tips) {
  const seen = new Map();
  const order = [];
  const push = (sha) => {
    if (!sha || seen.has(sha)) return false;
    const obj = repo.read(sha);
    if (!obj) return false;
    seen.set(sha, obj);
    order.push({ sha, ...obj });
    return true;
  };
  const walkTree = (sha) => {
    const obj = repo.read(sha);
    if (!obj) return;
    if (obj.type !== 'tree') {
      push(sha);
      return;
    }
    if (!push(sha)) return;
    for (const entry of parseTree(obj.content)) {
      if (entry.mode === '160000') continue; // gitlink: no object here
      walkTree(entry.sha);
    }
  };
  const walkCommit = (sha) => {
    const obj = repo.read(sha);
    if (!obj) return;
    if (obj.type === 'tag') {
      if (!push(sha)) return;
      const tag = parseTag(obj.content);
      walkCommit(tag.object);
      return;
    }
    if (obj.type !== 'commit') {
      push(sha);
      return;
    }
    if (!push(sha)) return;
    const commit = parseCommit(obj.content);
    walkTree(commit.tree);
    for (const parent of commit.parents) walkCommit(parent);
  };
  for (const tip of tips) walkCommit(tip);
  return order;
}

export function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const seen = new Set();
  const stack = [descendant];
  while (stack.length) {
    const sha = stack.pop();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.read(sha);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.content);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The commit's ancestors at most `depth` generations back, inclusive of the tip. */
export function shallowCommits(repo, tip, depth) {
  const out = [];
  let level = [tip];
  for (let d = 0; d < depth && level.length; d += 1) {
    const next = [];
    for (const sha of level) {
      const obj = repo.read(sha);
      if (!obj || obj.type !== 'commit') continue;
      out.push(sha);
      for (const parent of parseCommit(obj.content).parents) next.push(parent);
    }
    level = next;
  }
  return out;
}

export function inflateRawSafe(buf) {
  try {
    return inflateRawSync(buf);
  } catch {
    return null;
  }
}