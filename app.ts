// The entry's HTTP server: one process, its own store, no dependencies.
import { createServer } from 'node:http';
import { restRoutes, HttpError, loginFromToken } from './pub/rest.ts';
import { gitResponse, looksV0, handleUploadPackV0 } from './pub/gitserver.ts';
import { handleGraphQL } from './pub/gql.ts';
import { handleMcp } from './pub/mcp.ts';
import { store } from './pub/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function requestId() {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendJson(res, status, body, headers = {}) {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer\s+/i.test(header)) return null;
  const value = header.replace(/^Bearer\s+/i, '').trim();
  return value || null;
}

function gitPath(path) {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)$/.exec(path);
  if (!m) return null;
  return { owner: m[1], repo: m[2], rest: m[3] };
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://forge.local');
      const path = url.pathname;
      const method = req.method || 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const git = gitPath(path);
      if (git) {
        const repo = store.get(git.owner, git.repo);
        const isInfo = git.rest === '/info/refs';
        const isUpload = git.rest === '/git-upload-pack';
        const isReceive = git.rest === '/git-receive-pack';
        if (!isInfo && !isUpload && !isReceive) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (isInfo) {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const out = gitResponse(repo, service, 'GET', url.searchParams, null, req.headers['git-protocol']);
          res.writeHead(out.status, { 'x-github-request-id': requestId(), ...out.headers });
          res.end(out.body);
          return;
        }
        const body = await readAll(req);
        const service = isUpload ? 'git-upload-pack' : 'git-receive-pack';
        const out =
          isUpload && looksV0(body)
            ? {
                status: 200,
                headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
                body: handleUploadPackV0(repo, body),
              }
            : gitResponse(repo, service, 'POST', url.searchParams, body, req.headers['git-protocol']);
        res.writeHead(out.status, { 'x-github-request-id': requestId(), ...out.headers });
        res.end(out.body);
        return;
      }

      if (path === '/api/graphql') {
        const token = tokenOf(req);
        const body = method === 'POST' ? await readAll(req) : Buffer.alloc(0);
        const out = handleGraphQL({ token, login: token ? loginFromToken(token) : '', body, method });
        sendJson(res, out.status, out.body, out.headers);
        return;
      }

      if (path === '/mcp' || path === '/mcp/') {
        const token = tokenOf(req);
        const body = await readAll(req);
        const out = handleMcp({ token, login: token ? loginFromToken(token) : '', body, method, headers: req.headers });
        const headers = { ...(out.headers || {}) };
        if (typeof out.raw === 'string') {
          res.writeHead(out.status, { 'content-type': out.contentType || JSON_TYPE, 'x-github-request-id': requestId(), ...headers });
          res.end(out.raw);
          return;
        }
        sendJson(res, out.status, out.body, headers);
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const token = tokenOf(req);
        if (!token) {
          sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
          return;
        }
        const login = loginFromToken(token);
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readAll(req);
        const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'forge.local'}`;
        const ctx = { method, path, query: url.searchParams, body, login, token, origin };
        const out = restRoutes(ctx);
        if (typeof out.text === 'string') {
          sendText(res, out.status || 200, out.text, out.headers || {});
          return;
        }
        sendJson(res, out.status || 200, out.body === undefined ? null : out.body, out.headers || {});
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
        return;
      }
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    }
  });
}