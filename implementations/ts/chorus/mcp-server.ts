// Chorus as drop-in memory for any agent framework: an MCP server over stdio. Hand-rolled
// JSON-RPC 2.0 (same spirit as the hand-rolled CBOR: own the bytes you must be exact about);
// the protocol surface is initialize / tools/list / tools/call.
//
// Tools: begin-session · whoami · briefing · remember · recall · topics · search · same ·
// retract · revise · end-session · explain · trust · as-of.
//
// Identity model (chorus/identity.ts): one server process = one SESSION = one derived keypair
// — every model session is a distinct author with its own track record. The human is one
// persistent author (speaker: "user"). All keys derive from CHORUS_MASTER_SEED; only public
// keys touch the substrate. Persistence: the shared JSONL log (CHORUS_STORE; concurrent
// sessions converge by union) or a legacy pack snapshot (CHORUS_PACK).

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ChorusAgent, beliefPointers } from "./agent.js";
import { briefing } from "./briefing.js";
import { decide, replayDecision } from "./decisions.js";
import { recallUnified, sameAsClass, sameAsPointers, search, topics } from "./discovery.js";
import {
  identityIndex,
  identityPointers,
  sessionEntity,
  sessionSeed,
  userSeed,
  type AuthorIdentity,
} from "./identity.js";
import { SharedStore } from "./shared-store.js";
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
    name: "briefing",
    description:
      "What to have top-of-mind, computed fresh: the user's preferences, open tasks, recent sessions (with their summaries), top topics, CONTESTED facts (where the record disagrees with itself), and standing distrust edits. Call right after begin-session.",
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
      "Resolve an entity's beliefs to one view under the agent's trust policy. Optional attribute narrows to one property; aliasedVia (a concept id) crosses vocabulary dialects through the alias closure; unified: true reads through sameAs equivalences (co-referring ids merge; conflicts surface as arrays).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        attribute: { type: "string" },
        aliasedVia: { type: "string" },
        unified: { type: "boolean" },
      },
      required: ["entity"],
    },
  },
  {
    name: "topics",
    description:
      "What does this store know about? Entities with beliefs, most recently touched first: attributes, claim counts, distinct authors. Use prefix to narrow (e.g. 'person:').",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "search",
    description:
      "Case-insensitive substring search over belief values, attribute names, and entity ids. Returns hits with delta ids and authors.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "same",
    description:
      "Assert that two entity ids name the same thing (a signed, negatable identity judgment). recall {unified: true} then reads through the equivalence.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        reason: { type: "string" },
        ...SPEAKER,
      },
      required: ["a", "b"],
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
    name: "revise",
    description:
      "Replace a belief in one move: retract the old delta and assert the new value for the same entity/attribute, linked by a revises pointer. Use when a fact CHANGED (not when it was wrong from the start — that's retract + remember).",
    inputSchema: {
      type: "object",
      properties: {
        deltaId: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
        reason: { type: "string" },
        ...SPEAKER,
      },
      required: ["deltaId", "value"],
    },
  },
  {
    name: "end-session",
    description:
      "Close out: write this session's one-paragraph summary (and what's left open) so the next session's briefing starts where you stopped. Call before finishing a conversation.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
  {
    name: "decide",
    description:
      "Record that you are about to ACT on what you currently believe: resolves the entity now and pins (instant, policy, view hash, arrival prefix) into one signed decision record. Returns the decisionId — keep it in your summary if the action matters.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string" },
        intent: { type: "string", description: "what you are about to do, in your own words" },
        attribute: { type: "string" },
      },
      required: ["about", "intent"],
    },
  },
  {
    name: "replay",
    description:
      "Replay a recorded decision: the exact belief set and policy it resolved, re-verified byte-for-byte, with claims retracted SINCE the decision marked. Incident review as a query.",
    inputSchema: {
      type: "object",
      properties: { decisionId: { type: "string" } },
      required: ["decisionId"],
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
      "Retroactive distrust: one signed edit re-resolves every belief downstream of the demoted testimony; history stays queryable. Demote a specific author key (distrust), every session of a model (distrustModel), or one session by id (distrustSession).",
    inputSchema: {
      type: "object",
      properties: {
        distrust: { type: "string", description: "an author key, e.g. ed25519:…" },
        distrustModel: { type: "string", description: "demote ALL sessions of this model id" },
        distrustSession: { type: "string", description: "demote one session by its session id" },
        reason: { type: "string" },
        ...SPEAKER,
      },
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
      const opts = {
        ...(attribute === undefined ? {} : { attribute }),
        ...(aliasedVia === undefined ? {} : { aliasedVia }),
      };
      if (args["unified"] === true) {
        return recallUnified(agent, str(args["entity"]) ?? "", opts);
      }
      return agent.recall(str(args["entity"]) ?? "", opts);
    }
    case "briefing":
      return briefing(agent, ctx.userAuthor);
    case "revise": {
      const old = agent.peer.reactor.get(str(args["deltaId"]) ?? "");
      if (old === undefined) throw new Error(`revise: unknown delta ${String(args["deltaId"])}`);
      const aboutPtr = old.claims.pointers.find(
        (p) => p.role === "chorus.belief.about" && p.target.kind === "entity",
      );
      if (aboutPtr?.target.kind !== "entity" || aboutPtr.target.entity.context === undefined) {
        throw new Error("revise: target is not a chorus belief");
      }
      const kindPtr = old.claims.pointers.find(
        (p) => p.role === "chorus.belief.kind" && p.target.kind === "primitive",
      );
      const value = args["value"];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error("revise: value must be string | number | boolean");
      }
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model);
      const reason = str(args["reason"]) ?? "revised";
      const negation = asUser
        ? agent.retractAs(ctx.userSeedHex, old.id, reason)
        : agent.retract(old.id, reason);
      const pointers = [
        ...beliefPointers({
          about: aboutPtr.target.entity.id,
          attribute: aboutPtr.target.entity.context,
          value,
          ...(kindPtr?.target.kind === "primitive"
            ? {
                kind: String(kindPtr.target.value) as
                  | "observation"
                  | "fact"
                  | "preference"
                  | "task",
              }
            : {}),
        }),
        {
          role: "chorus.belief.revises",
          target: { kind: "delta" as const, deltaRef: { delta: old.id } },
        },
      ];
      const input = { timestamp: ctx.clock(), pointers };
      const delta = asUser ? agent.recordAs(ctx.userSeedHex, input) : agent.record(input);
      persist?.();
      return { deltaId: delta.id, revised: old.id, negationId: negation.id };
    }
    case "end-session": {
      if (!ctx.introduced) introduce(ctx, ctx.model);
      const t = ctx.clock();
      agent.assert({
        about: sessionEntity(ctx.sessionId),
        attribute: "summary",
        value: str(args["summary"]) ?? "",
        kind: "observation",
        timestamp: t,
      });
      agent.assert({
        about: sessionEntity(ctx.sessionId),
        attribute: "endedAt",
        value: t,
        kind: "observation",
        timestamp: t,
      });
      persist?.();
      return { sessionId: ctx.sessionId, endedAt: t };
    }
    case "topics": {
      const prefix = str(args["prefix"]);
      const limit = num(args["limit"]);
      return topics(agent, {
        ...(prefix === undefined ? {} : { prefix }),
        ...(limit === undefined ? {} : { limit }),
      });
    }
    case "search":
      return search(agent, str(args["query"]) ?? "", num(args["limit"]) ?? 25);
    case "same": {
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model);
      const pointers = sameAsPointers(
        str(args["a"]) ?? "",
        str(args["b"]) ?? "",
        str(args["reason"]),
      );
      const input = { timestamp: ctx.clock(), pointers };
      const delta = asUser ? agent.recordAs(ctx.userSeedHex, input) : agent.record(input);
      persist?.();
      return { deltaId: delta.id, class: sameAsClass(agent, str(args["a"]) ?? "") };
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
      // Resolve model/session selectors to author keys through the identity claims.
      const targets = new Set<string>();
      const direct = str(args["distrust"]);
      if (direct !== undefined) targets.add(direct);
      const byModel = str(args["distrustModel"]);
      const bySession = str(args["distrustSession"]);
      if (byModel !== undefined || bySession !== undefined) {
        for (const id of identityIndex(agent.snapshot(), ctx.userAuthor).values()) {
          if (id.kind !== "session") continue;
          if (byModel !== undefined && id.model === byModel) targets.add(id.author);
          if (bySession !== undefined && id.sessionId === bySession) targets.add(id.author);
        }
        if (byModel !== undefined && targets.size === 0) {
          throw new Error(`trust: no sessions of model "${byModel}" found in identity claims`);
        }
        if (bySession !== undefined && targets.size === 0) {
          throw new Error(`trust: no session "${bySession}" found in identity claims`);
        }
      }
      if (targets.size === 0) {
        throw new Error("trust: give one of distrust | distrustModel | distrustSession");
      }
      const editIds = [...targets].sort().map((a) => agent.distrust(a, reason).id);
      persist?.();
      return { distrusted: [...targets].sort(), editIds };
    }
    case "decide": {
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model);
      const attribute = str(args["attribute"]);
      const d = decide(agent, {
        about: str(args["about"]) ?? "",
        intent: str(args["intent"]) ?? "",
        ...(attribute === undefined ? {} : { attribute }),
      });
      persist?.();
      return { decisionId: d.delta.id, view: d.view, basis: d.basis, asOf: d.asOf };
    }
    case "replay": {
      const r = replayDecision(agent, str(args["decisionId"]) ?? "");
      const identities = identityIndex(agent.snapshot(), ctx.userAuthor);
      return {
        ...r,
        receipts: r.receipts.map((x) => ({ ...x, ...speakerOf(ctx, identities, x.author) })),
      };
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

export interface StoreHooks {
  readonly persist?: () => void; // after every accepted write
  readonly refresh?: () => void; // before every tool call: pull in other sessions' appends
}

export function handleRequest(
  ctx: SessionContext,
  req: RpcRequest,
  hooks: StoreHooks = {},
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
    case "notifications/cancelled":
      return undefined; // notifications: no response
    case "ping":
      return reply({}); // keepalive — real clients send this and expect an empty result
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = str(req.params?.["name"]) ?? "";
      const args = (req.params?.["arguments"] as Record<string, unknown> | undefined) ?? {};
      try {
        hooks.refresh?.();
        const result = callTool(ctx, name, args, hooks.persist);
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
  hooks?: StoreHooks,
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
    const resp = handleRequest(ctx, req, hooks);
    if (resp !== undefined) output.write(`${JSON.stringify(resp)}\n`);
  });
}

// Direct run: a persistent agent over stdio.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("chorus/mcp-server.ts")
) {
  const masterSeedHex =
    process.env["CHORUS_MASTER_SEED"] ?? process.env["CHORUS_SEED_HEX"] ?? "0f".repeat(32);
  const sessionId =
    process.env["CHORUS_SESSION_ID"] ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const ctx = createSession({ masterSeedHex, sessionId });
  const packPath = process.env["CHORUS_PACK"];
  if (packPath !== undefined) {
    // Legacy single-process pack mode (portable snapshot per write).
    if (existsSync(packPath)) ctx.agent.importSet(loadPack(packPath));
    serve(ctx, process.stdin, process.stdout, { persist: () => savePack(ctx.agent, packPath) });
  } else {
    // Default: the shared JSONL log — many concurrent sessions, one world.
    const store = new SharedStore(process.env["CHORUS_STORE"] ?? "chorus-memory.jsonl");
    store.refresh(ctx.agent);
    if (store.wasteful(ctx.agent)) store.compact(ctx.agent);
    serve(ctx, process.stdin, process.stdout, {
      persist: () => store.persist(ctx.agent),
      refresh: () => store.refresh(ctx.agent),
    });
  }
}
