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
  identityAt,
  identityIntroductions,
  identityPointers,
  sessionEntity,
  sessionSeed,
  userSeed,
  type AuthorIdentity,
} from "./identity.js";
import { ackPointers, inbox, messagePointers, type MessageAddress } from "./messages.js";
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

// Reference, don't transcribe: a belief's value is an entity REFERENCE whenever it names
// something the store could hold beliefs about. "event:eclipse" as a string is a spelling;
// {entity: "event:eclipse"} is the thing spelled. Relations are composed of their relata,
// not of the words for them — recall and explain can follow a reference, never a substring.
const VALUE = {
  value: {
    description:
      "Primitive (string|number|boolean) for genuine content — text, quantities, flags. " +
      "{entity: <id>} for a typed reference. Reference, don't transcribe: if the value NAMES " +
      "something the store could hold beliefs about (an event, a person, a work), pass " +
      "{entity} — a relation is composed of the things it relates, not of their names.",
    anyOf: [
      { type: ["string", "number", "boolean"] },
      {
        type: "object",
        properties: { entity: { type: "string" }, context: { type: "string" } },
        required: ["entity"],
        additionalProperties: false,
      },
    ],
  },
} as const;

const TOOLS = [
  {
    name: "begin-session",
    description:
      "Introduce this session: bind its author keypair to your model name and declared intent. Call at the start of a conversation so every claim you make is attributable to THIS session — and call it AGAIN if your serving model OR your topic changes mid-conversation (e.g. a refusal failover, a pivot): introductions read as intervals, so each claim attributes to the introduction in effect at its timestamp. Declared topics become your briefing's scope.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "your model id, e.g. claude-fable-5" },
        purpose: { type: "string", description: "one line on what this session is doing" },
        topics: {
          type: "array",
          items: { type: "string" },
          description:
            "Entity ids this session is ABOUT (e.g. 'proj:chorus') — these scope your briefing. A value ending in ':' scopes a whole id-prefix family (e.g. 'synchronicity:'). Reference real ids: try topics/search first rather than inventing new ones.",
        },
        surface: {
          type: "string",
          description:
            "Where this session lives: 'claude-code' | 'claude-desktop' | 'claude-web' | 'api' | …",
        },
        mode: {
          type: "string",
          description:
            "Interaction type: 'work' | 'conversation' | 'research' | 'retrospective' | …",
        },
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
      "What to have top-of-mind, computed fresh THROUGH YOUR DECLARED SCOPE: the user's preferences (always global — they're about the human), in-scope open tasks, recent sessions (shared-topic sessions first), in-scope topics, in-scope CONTESTED facts (out-of-scope contests return as a count in contestedElsewhere — explore them via topics/recall if relevant), and standing distrust edits. Scope defaults to your begin-session topics; pass topics here to override; no topics anywhere = the global view. Call right after begin-session.",
    inputSchema: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Override scope: entity ids, or trailing-':' prefix patterns.",
        },
      },
    },
  },
  {
    name: "remember",
    description:
      "Assert a belief as a signed claim: about (entity id), attribute (property name), value (primitive, or {entity} for a typed reference — see the value description), optional kind (observation|fact|preference|task), confidence (0..1), source, speaker.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string" },
        attribute: { type: "string" },
        ...VALUE,
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
      "Resolve an entity's beliefs to one view under the agent's trust policy. Optional attribute narrows to one property; aliasedVia (a concept id) crosses vocabulary dialects through the alias closure; unified: true reads through sameAs equivalences (co-referring ids merge; conflicts surface as arrays); all: true returns EVERY surviving candidate instead of the policy's pick (multiple values surface as arrays) — the right read for set-valued attributes like composed-of.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        attribute: { type: "string" },
        aliasedVia: { type: "string" },
        unified: { type: "boolean" },
        all: { type: "boolean" },
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
        ...VALUE,
        reason: { type: "string" },
        ...SPEAKER,
      },
      required: ["deltaId", "value"],
    },
  },
  {
    name: "recast",
    description:
      "Re-encode a belief WITHOUT re-deciding it: the value's meaning stays identical, only its representation upgrades (e.g. a string that names an entity becomes a typed {entity} reference; one comma-packed string becomes N separate claims). Appends one negation of the original plus the replacement claim(s), each linked by a recasts pointer — the audit trail reads 're-encoded', never 'changed its mind'. Use revise when the fact CHANGED; retract+remember when it was WRONG; recast when only the encoding improves.",
    inputSchema: {
      type: "object",
      properties: {
        deltaId: { type: "string" },
        values: {
          type: "array",
          minItems: 1,
          items: VALUE.value,
          description:
            "The replacement value(s), meaning-identical to the original. Multiple values unpack a fat claim into separate claims (one per relatum).",
        },
        reason: { type: "string" },
        ...SPEAKER,
      },
      required: ["deltaId", "values"],
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
    name: "post",
    description:
      "Send a message to other sessions (or the human): correspondence, not knowledge — it appears ONLY in the addressed inboxes and never pollutes topics/search/recall. Addressing targets declared identity: one session, every session of a model, every session on a surface, any session scoped to a topic, or the user (their inbox is the console). No 'to' = broadcast. Use for handoffs, questions, and rulings between sessions; use remember for durable facts.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        to: {
          type: "object",
          properties: {
            session: { type: "string", description: "one session, by id" },
            model: { type: "string", description: "every session of this model" },
            surface: { type: "string", description: "every session on this surface" },
            topics: {
              type: "array",
              items: { type: "string" },
              description: "any session scoped to one of these (':' suffix = prefix family)",
            },
            user: { type: "boolean", description: "the human — delivered to the console" },
          },
          additionalProperties: false,
        },
        about: {
          type: "array",
          items: { type: "string" },
          description: "entity ids this message concerns (references, not filing)",
        },
        re: { type: "string", description: "a prior message's id — threads a reply" },
        ...SPEAKER,
      },
      required: ["body"],
    },
  },
  {
    name: "inbox",
    description:
      "Messages addressed to THIS session (by id, model, surface, declared topic, or broadcast), unacked first-class: each with sender receipts (which model, which session), thread pointer, and concerned entities. Ack what you handle. includeAcked: true shows handled mail too.",
    inputSchema: {
      type: "object",
      properties: { includeAcked: { type: "boolean" } },
    },
  },
  {
    name: "ack",
    description:
      "Acknowledge a message: it leaves YOUR inbox (other recipients of a broadcast still see it). The ack is a signed claim — handled-ness has provenance. To withdraw a message globally, retract it.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        note: { type: "string", description: "optional: what you did about it" },
        ...SPEAKER,
      },
      required: ["messageId"],
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

// A belief value off the wire: a primitive, or {entity, context?} for a typed reference.
function beliefValue(
  v: unknown,
  tool: string,
): string | number | boolean | { entity: string; context?: string } {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object" && v !== null) {
    const entity = str((v as Record<string, unknown>)["entity"]);
    const context = str((v as Record<string, unknown>)["context"]);
    if (entity !== undefined) {
      return context === undefined ? { entity } : { entity, context };
    }
  }
  throw new Error(`${tool}: value must be string | number | boolean | { entity, context? }`);
}

// One server process = one session. The agent's own keypair IS the session author; the user
// is a second, persistent derived author writing into the same store.
export interface SessionContext {
  readonly agent: ChorusAgent;
  readonly sessionId: string;
  readonly userSeedHex: string;
  readonly userAuthor: string;
  model: string; // declared at begin-session; "unknown" until then, and visibly so
  topics: string[]; // declared intent: what this session is about (briefing scope)
  surface?: string; // where the session lives: claude-code | claude-desktop | …
  mode?: string; // interaction type: work | conversation | research | retrospective…
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
    topics: [],
    introduced: false,
    clock: opts.clock ?? (() => Date.now()),
  };
}

interface Intent {
  readonly purpose?: string;
  readonly topics?: readonly string[];
  readonly surface?: string;
  readonly mode?: string;
}

// Bind the session author to its model + intent — one signed identity claim (identity.ts).
function introduce(ctx: SessionContext, model: string, intent: Intent = {}): void {
  ctx.model = model;
  if (intent.topics !== undefined) ctx.topics = [...intent.topics];
  if (intent.surface !== undefined) ctx.surface = intent.surface;
  if (intent.mode !== undefined) ctx.mode = intent.mode;
  ctx.introduced = true;
  const t = ctx.clock();
  ctx.agent.record({
    timestamp: t,
    pointers: identityPointers({
      sessionId: ctx.sessionId,
      model,
      startedAt: t,
      ...(intent.purpose === undefined ? {} : { purpose: intent.purpose }),
      ...(intent.topics === undefined ? {} : { topics: intent.topics }),
      ...(intent.surface === undefined ? {} : { surface: intent.surface }),
      ...(intent.mode === undefined ? {} : { mode: intent.mode }),
    }),
  });
}

// Who spoke — resolved AT THE CLAIM'S TIMESTAMP: a session whose serving model changed
// mid-flight (re-introduction) attributes each claim to the model in effect when it was made.
function speakerOf(
  ctx: SessionContext,
  intros: Map<string, AuthorIdentity[]>,
  author: string,
  timestamp: number,
) {
  const id = identityAt(intros, author, timestamp);
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
      const topics = Array.isArray(args["topics"])
        ? args["topics"].filter((t): t is string => typeof t === "string")
        : undefined;
      introduce(ctx, str(args["model"]) ?? "unknown", {
        ...(str(args["purpose"]) === undefined ? {} : { purpose: str(args["purpose"])! }),
        ...(topics === undefined ? {} : { topics }),
        ...(str(args["surface"]) === undefined ? {} : { surface: str(args["surface"])! }),
        ...(str(args["mode"]) === undefined ? {} : { mode: str(args["mode"])! }),
      });
      persist?.();
      return {
        sessionId: ctx.sessionId,
        sessionAuthor: agent.author,
        userAuthor: ctx.userAuthor,
        model: ctx.model,
        topics: ctx.topics,
        ...(ctx.surface === undefined ? {} : { surface: ctx.surface }),
        ...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
      };
    }
    case "whoami":
      return {
        sessionId: ctx.sessionId,
        sessionAuthor: agent.author,
        userAuthor: ctx.userAuthor,
        model: ctx.model,
        topics: ctx.topics,
        ...(ctx.surface === undefined ? {} : { surface: ctx.surface }),
        ...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
        introduced: ctx.introduced,
      };
    case "remember": {
      const value = beliefValue(args["value"], "remember");
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
      if (args["all"] === true) {
        return agent.recallAll(str(args["entity"]) ?? "", opts);
      }
      return agent.recall(str(args["entity"]) ?? "", opts);
    }
    case "briefing": {
      const override = Array.isArray(args["topics"])
        ? args["topics"].filter((t): t is string => typeof t === "string")
        : undefined;
      const scopeTopics = override ?? ctx.topics;
      const b = briefing(
        agent,
        ctx.userAuthor,
        scopeTopics.length === 0 ? undefined : { topics: scopeTopics },
      );
      // Mail addressed to this session arrives WITH the briefing — correspondence is
      // salient by construction (it names you); knowledge is salient by scope.
      const mail = inbox(agent, {
        author: agent.author,
        sessionId: ctx.sessionId,
        model: ctx.model,
        ...(ctx.surface === undefined ? {} : { surface: ctx.surface }),
        topics: ctx.topics,
        userAuthor: ctx.userAuthor,
      });
      return { ...b, inbox: mail.slice(0, 10) };
    }
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
      const value = beliefValue(args["value"], "revise");
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
    case "recast": {
      // Re-encoded, not re-decided: same proposition, better representation. The recaster
      // signs (you cannot speak in another author's voice); the original author's testimony
      // stays one hop down the recasts pointer, negated but never hidden.
      const old = agent.peer.reactor.get(str(args["deltaId"]) ?? "");
      if (old === undefined) throw new Error(`recast: unknown delta ${String(args["deltaId"])}`);
      const aboutPtr = old.claims.pointers.find(
        (p) => p.role === "chorus.belief.about" && p.target.kind === "entity",
      );
      if (aboutPtr?.target.kind !== "entity" || aboutPtr.target.entity.context === undefined) {
        throw new Error("recast: target is not a chorus belief");
      }
      const about = aboutPtr.target.entity.id;
      const attribute = aboutPtr.target.entity.context;
      // The proposition's epistemic state is unchanged, so kind/confidence/source carry over.
      let kind: string | undefined;
      let confidence: number | undefined;
      let source: string | undefined;
      for (const p of old.claims.pointers) {
        if (p.target.kind !== "primitive") continue;
        if (p.role === "chorus.belief.kind") kind = String(p.target.value);
        else if (p.role === "chorus.belief.confidence" && typeof p.target.value === "number") {
          confidence = p.target.value;
        } else if (p.role === "chorus.belief.source") source = String(p.target.value);
      }
      const rawValues = args["values"];
      if (!Array.isArray(rawValues) || rawValues.length === 0) {
        throw new Error("recast: values must be a non-empty array");
      }
      const values = rawValues.map((v) => beliefValue(v, "recast"));
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model);
      const reason = str(args["reason"]) ?? "recast: representation upgraded, meaning unchanged";
      const negation = asUser
        ? agent.retractAs(ctx.userSeedHex, old.id, reason)
        : agent.retract(old.id, reason);
      const deltaIds = values.map((value) => {
        const pointers = [
          ...beliefPointers({
            about,
            attribute,
            value,
            ...(kind === undefined
              ? {}
              : { kind: kind as "observation" | "fact" | "preference" | "task" }),
            ...(confidence === undefined ? {} : { confidence }),
            ...(source === undefined ? {} : { source }),
          }),
          {
            role: "chorus.belief.recasts",
            target: { kind: "delta" as const, deltaRef: { delta: old.id } },
          },
        ];
        const input = { timestamp: ctx.clock(), pointers };
        return (asUser ? agent.recordAs(ctx.userSeedHex, input) : agent.record(input)).id;
      });
      persist?.();
      return { recast: old.id, deltaIds, negationId: negation.id };
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
      const intros = identityIntroductions(agent.snapshot(), ctx.userAuthor);
      return receipts.map((r) => ({ ...r, ...speakerOf(ctx, intros, r.author, r.timestamp) }));
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
        // Conservative on purpose: an author that EVER introduced as the model is demoted —
        // a session that failed over mid-flight carries the demoted model's testimony too.
        for (const list of identityIntroductions(agent.snapshot(), ctx.userAuthor).values()) {
          for (const id of list) {
            if (id.kind !== "session") continue;
            if (byModel !== undefined && id.model === byModel) targets.add(id.author);
            if (bySession !== undefined && id.sessionId === bySession) targets.add(id.author);
          }
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
    case "post": {
      const body = str(args["body"]);
      if (body === undefined || body === "") throw new Error("post: body is required");
      const rawTo = args["to"] as Record<string, unknown> | undefined;
      const topics = Array.isArray(rawTo?.["topics"])
        ? rawTo["topics"].filter((t): t is string => typeof t === "string")
        : undefined;
      const to: MessageAddress = {
        ...(str(rawTo?.["session"]) === undefined ? {} : { session: str(rawTo!["session"])! }),
        ...(str(rawTo?.["model"]) === undefined ? {} : { model: str(rawTo!["model"])! }),
        ...(str(rawTo?.["surface"]) === undefined ? {} : { surface: str(rawTo!["surface"])! }),
        ...(topics === undefined ? {} : { topics }),
        ...(rawTo?.["user"] === true ? { user: true } : {}),
      };
      const about = Array.isArray(args["about"])
        ? args["about"].filter((a): a is string => typeof a === "string")
        : undefined;
      if (!ctx.introduced && !asUser) introduce(ctx, ctx.model);
      const pointers = messagePointers({
        body,
        to,
        ...(about === undefined ? {} : { about }),
        ...(str(args["re"]) === undefined ? {} : { re: str(args["re"])! }),
      });
      const input = { timestamp: ctx.clock(), pointers };
      const delta = asUser ? agent.recordAs(ctx.userSeedHex, input) : agent.record(input);
      persist?.();
      return { messageId: delta.id, from: delta.claims.author, to };
    }
    case "inbox": {
      return inbox(
        agent,
        {
          author: agent.author,
          sessionId: ctx.sessionId,
          model: ctx.model,
          ...(ctx.surface === undefined ? {} : { surface: ctx.surface }),
          topics: ctx.topics,
          userAuthor: ctx.userAuthor,
        },
        { includeAcked: args["includeAcked"] === true },
      );
    }
    case "ack": {
      const messageId = str(args["messageId"]);
      if (messageId === undefined) throw new Error("ack: messageId is required");
      if (agent.peer.reactor.get(messageId) === undefined) {
        throw new Error(`ack: unknown message ${messageId}`);
      }
      const pointers = ackPointers(messageId, str(args["note"]));
      const input = { timestamp: ctx.clock(), pointers };
      const delta = asUser ? agent.recordAs(ctx.userSeedHex, input) : agent.record(input);
      persist?.();
      return { ackId: delta.id, acked: messageId };
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
      const intros = identityIntroductions(agent.snapshot(), ctx.userAuthor);
      return {
        ...r,
        receipts: r.receipts.map((x) => ({
          ...x,
          ...speakerOf(ctx, intros, x.author, x.timestamp),
        })),
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
  process.argv[1].replace(/\\/g, "/").endsWith("src/mcp-server.ts")
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
