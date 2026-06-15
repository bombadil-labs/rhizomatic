// Chorus over the network: the MCP server's streamable-HTTP transport. The protocol brain
// (handleRequest, chorus/mcp-server.ts) is transport-agnostic — stdio wraps it for local
// clients; this wraps it for remote ones (Claude Code/Desktop on other machines via
// `claude mcp add --transport http`, claude.ai web via a custom connector).
//
// The session mapping is the point: one Mcp-Session-Id = one SessionContext = one chorus
// session = ONE AUTHOR. A remote surface connecting twice is two sessions with two keypairs,
// exactly like two local processes.
//
// Auth, v0: a secret URL path segment (CHORUS_HTTP_TOKEN — required, the server refuses to
// start without it), because claude.ai's connector UI offers OAuth-or-nothing and cannot
// send custom headers. Clients that CAN send headers may use Authorization: Bearer instead.
// Bind 127.0.0.1 and put TLS in front (tailscale serve for tailnet reach, tailscale funnel
// for claude.ai's public reachability requirement). Real OAuth is a later slice.
//
//   npm run chorus:http   (CHORUS_HTTP_TOKEN, CHORUS_HTTP_PORT=4821, CHORUS_HTTP_HOST,
//                          CHORUS_MASTER_SEED, CHORUS_STORE)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createStore, type Store } from "./store-tier.js";
import { createSession, handleRequest, type SessionContext } from "./mcp-server.js";

interface HttpSession {
  readonly ctx: SessionContext;
  // One Store per session, not per server: the store's watermark assumes one agent per instance
  // (the stdio server is one process = one agent = one store). Sharing an instance across agents
  // makes refresh skip deltas persisted for a sibling.
  readonly store: Store;
  lastSeen: number;
}

export interface HttpServerOptions {
  readonly masterSeedHex: string;
  readonly storePath: string;
  readonly token: string; // the secret path segment / bearer token
  readonly port?: number; // 0 = ephemeral
  readonly host?: string; // default 127.0.0.1 — TLS terminates in front of us
  readonly idleMs?: number; // prune sessions idle longer than this (default 2h)
  readonly clock?: () => number;
}

export interface HttpServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly url: string; // http://host:port/mcp/<token>
  close(): void;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

export function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  if (opts.token === "") throw new Error("chorus http: a non-empty token is required");
  const sessions = new Map<string, HttpSession>();
  const now = opts.clock ?? (() => Date.now());
  const idleMs = opts.idleMs ?? 2 * 60 * 60 * 1000;

  const prune = (): void => {
    const cutoff = now() - idleMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (url.pathname === `/mcp/${opts.token}` || url.pathname === `/mcp/${opts.token}/`) {
      return true;
    }
    return url.pathname === "/mcp" && req.headers["authorization"] === `Bearer ${opts.token}`;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!authorized(req, url)) {
      res.writeHead(404).end(); // not 401: don't advertise that an endpoint exists
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200).end(); // protocol discovery
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE, HEAD" }).end(); // no server-push stream
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    const mcpSessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;

    if (req.method === "DELETE") {
      if (mcpSessionId !== undefined) sessions.delete(mcpSessionId);
      res.writeHead(204).end(); // client terminated its session
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE, HEAD" }).end();
      return;
    }

    let rpc: { id?: number | string | null; method?: string };
    let raw: string;
    try {
      raw = await readBody(req);
      rpc = JSON.parse(raw) as typeof rpc;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
      );
      return;
    }

    prune();
    // initialize mints the session; everything else must present its Mcp-Session-Id.
    let session: HttpSession;
    let mintedId: string | undefined;
    if (rpc.method === "initialize") {
      mintedId = randomBytes(16).toString("hex");
      const ctx = createSession({
        masterSeedHex: opts.masterSeedHex,
        sessionId: `${now()}-http-${mintedId.slice(0, 8)}`,
      });
      const store = createStore(opts.storePath);
      store.refresh(ctx.agent);
      session = { ctx, store, lastSeen: now() };
      sessions.set(mintedId, session);
    } else {
      const found = mcpSessionId === undefined ? undefined : sessions.get(mcpSessionId);
      if (found === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            error: { code: -32001, message: "unknown or expired session — re-initialize" },
          }),
        );
        return;
      }
      session = found;
      session.lastSeen = now();
    }

    const response = handleRequest(
      session.ctx,
      JSON.parse(raw) as Parameters<typeof handleRequest>[1],
      {
        persist: () => session.store.persist(session.ctx.agent),
        refresh: () => session.store.refresh(session.ctx.agent),
      },
    );
    if (response === undefined) {
      res.writeHead(202).end(); // notification: accepted, no body
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      ...(mintedId === undefined ? {} : { "mcp-session-id": mintedId }),
    });
    res.end(JSON.stringify(response));
  };

  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
          }),
        );
      });
    });
    server.listen(opts.port ?? 4821, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        server,
        port,
        url: `http://${opts.host ?? "127.0.0.1"}:${port}/mcp/${opts.token}`,
        close: () => server.close(),
      });
    });
  });
}

// Direct run: the remote chorus node.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("src/mcp-http.ts")
) {
  const token = process.env["CHORUS_HTTP_TOKEN"];
  if (token === undefined || token === "") {
    console.error(
      "CHORUS_HTTP_TOKEN is required (the secret path segment). Generate one:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"",
    );
    process.exit(1);
  }
  const masterSeedHex =
    process.env["CHORUS_MASTER_SEED"] ?? process.env["CHORUS_SEED_HEX"] ?? "0f".repeat(32);
  void startHttpServer({
    masterSeedHex,
    storePath: process.env["CHORUS_STORE"] ?? "chorus-memory.jsonl",
    token,
    port: Number(process.env["CHORUS_HTTP_PORT"] ?? 4821),
    ...(process.env["CHORUS_HTTP_HOST"] === undefined
      ? {}
      : { host: process.env["CHORUS_HTTP_HOST"] }),
  }).then((h) => {
    console.error(`chorus http: serving ${h.url} (one MCP session = one author)`);
  });
}
