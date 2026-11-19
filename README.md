# friederickemiddleton7/ghc-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/friederickemiddleton7/ghc-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/friederickemiddleton7/ghc-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: git smart HTTP (upload-pack protocol v2, receive-pack v0),
the REST v3 API for repositories, contents, issues, labels and pull requests, the GraphQL v4 documents
`gh` sends, and a Model Context Protocol endpoint — one Node process, its own in-memory object store,
no dependencies, no git binary, no UI.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

## How it is built

- `main.ts` — the entry lifecycle: bind an ephemeral port, POST it to the env's `/register`, poll `/done`, exit 0.
- `app.ts` — the HTTP server and router: health probe, git paths, `/api/v3`, `/api/graphql`, `/mcp`.
- `pub/gitobj.ts` — git object hashing, commit/tree/tag parsing, packfile read (ofs/ref deltas) and write.
- `pub/gitserver.ts` — smart HTTP v0 and v2: advertisements, `ls-refs`, `fetch`, shallow depth/deepen, receive-pack with per-ref fast-forward rules and sideband framing.
- `pub/store.ts` — the forge's store: repositories, loose objects, refs, issues, labels, pulls, comments.
- `pub/rest.ts` — REST v3 routes, status codes, pagination `Link` headers and JSON error bodies.
- `pub/gql.ts` — the GraphQL v4 documents, `__type` introspection and the create/close/comment/merge mutations.
- `pub/mcp.ts` — MCP over streamable HTTP: `initialize`, `tools/list` and six `tools/call` tools over the same store.

The conformance suite that scores this entry is in the competition kit; it drives a local run to all
120 checks green before every submission.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>