// Chorus as drop-in memory for any agent framework: an MCP server over stdio. Hand-rolled
// JSON-RPC 2.0 (same spirit as the hand-rolled CBOR: own the bytes you must be exact about);
// the protocol surface is initialize / tools/list / tools/call.
//
// Tools: begin-session · whoami · remember · recall · retract · explain · trust · as-of.
//
// Identity model (chorus/identity.ts): one server process = one SESSION = one derived keypair
// — every model session is a distinct author with its own track record. The human is one
// persistent author (speaker: "user"). All keys derive from CHORUS_MASTER_SEED; only public
// keys touch the substrate. Persistence: a self-verifying pack file after every write
// (CHORUS_PACK, default ./chorus-memory.pack).

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ChorusAgent } from "./agent.js";
import {
  identityIndex,
  identityPointers,
  sessionSeed,
  userSeed,
  type AuthorIdentity,
} from "./identity.js";
import { loadPack, savePack } from "./store.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const SPEAKER = {
  speaker: {
    enum: ["model", "user"],
    description:
      "Who is asserting: 'model' (this session's own author — default) or 'user' (the persistent human author, when relaying something the user said).",
  },
} as const;

const TOOLS = [
  {
    name: "begin-session",
    description:
      "Introduce this session: bind its author keypair to your model name and purpose. Call once at the start of a conversation so every claim you make is attributable to THIS session.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "your model id, e.g. claude-fable-5" },
        purpose: { type: "string", description: "one line on what this session is doing" },
      },
      required: ["model"],
    },
  },
  {
    name: "whoami",
    description:
      "The identity card: this session's author, the persistent user author, session id, and declared model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description:
      "Assert a belief as a signed claim: about (entity id), attribute (property name), value (string|number|boolean), optional kind (observation|fact|preference|task), confidence (0..1), source, speaker.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string" },
        attribute: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
        kind: { enum: ["observation", "fact", "preference", "task"] },
        confidence: { type: "number" },
        source: { type: "string" },
        ...SPEAKER,
      },
      required: ["about", "attribute", "value"],
    },
  },
  {
    name: "recall",
    description:
      "Resolve an entity's beliefs to one view under the agent's trust policy. Optional attribute narrows to one property; aliasedVia (a concept id) crosses vocabulary dialects through the alias closure.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        attribute: { type: "string" },
        aliasedVia: { type: "string" },
      },
      required: ["entity"],
    },
  },
  {
    name: "retract",
    description:
      "Retract a belief by delta id. Retraction APPENDS a signed negation — history stays intact and auditable.",
    inputSchema: {
      type: "object",
      properties: { deltaId: { type: "string" }, reason: { type: "string" }, ...SPEAKER },
      required: ["deltaId"],
    },
  },
  {
    name: "explain",
    description:
      "Why does recall say what it says? Every candidate belief with its receipt: author, delta id, timestamp, signature, negated flag, value, kind, confidence, source.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string" }, attribute: { type: "string" } },
      required: ["entity"],
    },
  },
  {
    name: "trust",
    description:
      "Demote an author (retroactive distrust): one signed edit re-resolves every belief downstream of their testimony; their history stays queryable.",
    inputSchema: {
      type: "object",
      properties: { distrust: { type: "string" }, reason: { type: "string" }, ...SPEAKER },
      required: ["distrust"],
    },
  },
  {
    name: "as-of",
    description:
      "Resolve an entity's beliefs as they stood at a past instant (ms epoch). Claims retracted afterwards are visible again — the replay is honest.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        at: { type: "number" },
        attribute: { type: "string" },
      },
      required: ["entity", "at"],
    },
  },
] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// One server process = one session. The agent's own keypair IS the session author; the user
// is a second, persistent derived author writing into the same store.
export interface SessionContext {
  readonly agent: ChorusAgent;
  readonly sessionId: string;
  readonly userSeedHex: string;
  readonly userAuthor: string;
  model: string; // declared at begin-session; "unknown" until then, and visibly so
  introduced: boolean;
  readonly clock: () => number;
}

export interface SessionOptions {
  readonly masterSeedHex: string;
  readonly sessionId: string;
  readonly clock?: () => number;
}

export function createSession(opts: SessionOptions): SessionContext {
  const agent = new ChorusAgent({
    name: `session-${opts.sessionId}`,
    seedHex: sessionSeed(opts.masterSeedHex, opts.sessionId),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });
  const uSeed = userSeed(opts.masterSeedHex);
  return {
    agent,
    sessionId: opts.sessionId,
    userSeedHex: uSeed,
    userAuthor: new ChorusAgent({ name: "user", seedHex: uSeed }).author,
    model: "unknown",
    introduced: false,
    clock: opts.clock ?? (() => Date.now()),
  };
}

// Bind the session author to its model + purpose — one signed identity claim (identity.ts).
function introduce(ctx: SessionContext, model: string, purpose?: string): void {
  ctx.model = model;
  ctx.introduced = true;
  const t = ctx.clock();
  ctx.agent.record({
    timestamp: t,
    pointers: identityPointers({
      sessionId: ctx.sessionId,
      model,
      startedAt: t,
      ...(purpose === undefined ? {} : { purpose }),
    }),
  });
}

function speakerOf(ctx: SessionContext, identities: Map<string, AuthorIdentity>, author: string) {
  const id = identities.get(author);
  if (id === undefined) return { author, speaker: "unknown" };
  if (id.kind === "user") return { author, speaker: "user" };
  return {
    author,
    speaker: "session",
    model: id.model,
    sessionId: id.sessionId,
    ...(id.purpose === undefined ? {} : { purpose: id.purpose }),
    thisSession: id.sessionId === ctx.sessionId,
  };
}

// One tool call against one session. Pure of transport; the smoke tests drive this directly.
export function callTool(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  persist?: () => void,
): unknown {
  const { agent } = ctx;
  const asUser = args["speaker"] === "user";
  switch (name) {
    case "begin-session": {
      introduce(ctx, str(args["model"]) ?? "unknown", str(args["purpose"]));
      persist?.();
      return {
        sessionId: ctx.sessionId,
        sessionAuthor: agent.author,
        userAuthor: ctx.userAuthor,
        model: ctx.model,
      };
    }
    case "whoami":
      return {
        sessionId: ctx.sessionId,
        sessionAuthor: agent.author,
        userAuthor: ctx.userAuthor,
        model: ctx.model,
        introduced: ctx.introduced,
      };
    case "remember": {
      const value = args["value"];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error("remember: value must be string | number | boolean");
      }
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model); // lazily bind, visibly "unknown"
      const kind = str(args["kind"]);
      const belief = {
        about: str(args["about"]) ?? "",
        attribute: str(args["attribute"]) ?? "",
        value,
        ...(kind === undefined
          ? {}
          : { kind: kind as "observation" | "fact" | "preference" | "task" }),
        ...(num(args["confidence"]) === undefined ? {} : { confidence: num(args["confidence"])! }),
        ...(str(args["source"]) === undefined ? {} : { source: str(args["source"])! }),
      };
      const delta = asUser ? agent.assertAs(ctx.userSeedHex, belief) : agent.assert(belief);
      persist?.();
      return {
        deltaId: delta.id,
        author: delta.claims.author,
        speaker: asUser ? "user" : "session",
        signed: delta.sig !== undefined,
      };
    }
    case "recall": {
      const attribute = str(args["attribute"]);
      const aliasedVia = str(args["aliasedVia"]);
      return agent.recall(str(args["entity"]) ?? "", {
        ...(attribute === undefined ? {} : { attribute }),
        ...(aliasedVia === undefined ? {} : { aliasedVia }),
      });
    }
    case "retract": {
      const reason = str(args["reason"]);
      const negation = asUser
        ? agent.retractAs(ctx.userSeedHex, str(args["deltaId"]) ?? "", reason)
        : agent.retract(str(args["deltaId"]) ?? "", reason);
      persist?.();
      return { negationId: negation.id, negates: str(args["deltaId"]) };
    }
    case "explain": {
      const receipts = agent.explain(str(args["entity"]) ?? "", str(args["attribute"]));
      const identities = identityIndex(agent.snapshot(), ctx.userAuthor);
      return receipts.map((r) => ({ ...r, ...speakerOf(ctx, identities, r.author) }));
    }
    case "trust": {
      const reason = str(args["reason"]);
      const edit = agent.distrust(str(args["distrust"]) ?? "", reason);
      persist?.();
      return { distrusted: str(args["distrust"]), editId: edit.id };
    }
    case "as-of": {
      const attribute = str(args["attribute"]);
      return agent.recall(str(args["entity"]) ?? "", {
        asOf: num(args["at"]) ?? 0,
        ...(attribute === undefined ? {} : { attribute }),
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function handleRequest(
  ctx: SessionContext,
  req: RpcRequest,
  persist?: () => void,
): Record<string, unknown> | undefined {
  const reply = (result: unknown): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id: req.id ?? null,
    result,
  });
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "chorus", version: "0.1.0" },
      });
    case "notifications/initialized":
      return undefined; // notification: no response
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = str(req.params?.["name"]) ?? "";
      const args = (req.params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
      try {
        const result = callTool(ctx, name, args, persist);
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        return reply({
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

// The stdio loop: one JSON-RPC message per line. Testable in-process with any stream pair.
export function serve(
  ctx: SessionContext,
  input: Readable,
  output: Writable,
  persist?: () => void,
): void {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      );
      return;
    }
    const resp = handleRequest(ctx, req, persist);
    if (resp !== undefined) output.write(`${JSON.stringify(resp)}\n`);
  });
}

// Direct run: a persistent agent over stdio.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("chorus/mcp-server.ts")
) {
  const packPath = process.env["CHORUS_PACK"] ?? "chorus-memory.pack";
  const masterSeedHex =
    process.env["CHORUS_MASTER_SEED"] ?? process.env["CHORUS_SEED_HEX"] ?? "0f".repeat(32);
  const sessionId =
    process.env["CHORUS_SESSION_ID"] ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const ctx = createSession({ masterSeedHex, sessionId });
  if (existsSync(packPath)) ctx.agent.importSet(loadPack(packPath));
  serve(ctx, process.stdin, process.stdout, () => savePack(ctx.agent, packPath));
}
