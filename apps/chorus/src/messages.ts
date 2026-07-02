// Cross-session messages: ephemeral SALIENCE over a permanent record. A message is a signed
// delta like everything else (attributable, negatable, auditable) — but it is correspondence,
// not knowledge, so it never enters the knowledge surfaces: no chorus.belief.about pointer
// means topics/search/recall/contested cannot see it. It lives in exactly one place — the
// inbox of whoever it addresses — and leaves that inbox the moment they ack it. The bytes
// stay forever (append-only is load-bearing); the attention cost goes to zero.
//
// Addressing targets DECLARED IDENTITY (chorus/identity.ts): a specific session, every
// session of a model, every session on a surface, any session scoped to a topic, or the
// human (whose inbox is the console). No addressing at all = broadcast.

import { evalTerm, parseTerm, type Delta, type Pointer } from "@rhizomes/core";
import type { ChorusAgent } from "./agent.js";
import { identityAt, identityIntroductions } from "./identity.js";
import { CHORUS_PREFIX } from "./vocab.js";

export const ROLE_MSG_BODY = `${CHORUS_PREFIX}.message.body`;
export const ROLE_MSG_TO_SESSION = `${CHORUS_PREFIX}.message.toSession`;
export const ROLE_MSG_TO_MODEL = `${CHORUS_PREFIX}.message.toModel`;
export const ROLE_MSG_TO_SURFACE = `${CHORUS_PREFIX}.message.toSurface`;
export const ROLE_MSG_TO_TOPIC = `${CHORUS_PREFIX}.message.toTopic`;
export const ROLE_MSG_TO_USER = `${CHORUS_PREFIX}.message.toUser`;
export const ROLE_MSG_TO_AUTHOR = `${CHORUS_PREFIX}.message.toAuthor`;
export const ROLE_MSG_ABOUT = `${CHORUS_PREFIX}.message.about`;
export const ROLE_MSG_RE = `${CHORUS_PREFIX}.message.re`;
export const ROLE_MSG_ACK = `${CHORUS_PREFIX}.message.ack`;
export const ROLE_MSG_ACK_NOTE = `${CHORUS_PREFIX}.message.ackNote`;

export interface MessageAddress {
  readonly session?: string; // one session, by id
  readonly model?: string; // every session of a model
  readonly surface?: string; // every session on a surface (claude-code, claude-desktop, …)
  readonly topics?: readonly string[]; // any session scoped to one of these (":"-suffix = prefix family)
  readonly user?: boolean; // the human — their inbox is the console
  // AUTHOR MAIL: one exact keypair. The canonical coordination gesture — "about this thing
  // you wrote" — is anchored at a delta, and a delta's signature IS its author at a
  // timestamp. The post tool resolves {authorOf: <deltaId>} to this key at send time.
  readonly author?: string;
}

export interface PostInput {
  readonly body: string;
  readonly to?: MessageAddress; // omitted/empty = broadcast
  readonly about?: readonly string[]; // entity ids this concerns — contextless references
  readonly re?: string; // prior message delta id (threads)
}

// The message delta's pointers. Topics follow the identity convention: a real id is an
// entity REFERENCE (contextless — reference without filing, so discovery never sees it);
// a trailing-":" pattern is a string.
export function messagePointers(p: PostInput): Pointer[] {
  const pointers: Pointer[] = [
    { role: ROLE_MSG_BODY, target: { kind: "primitive", value: p.body } },
  ];
  const to = p.to ?? {};
  if (to.session !== undefined) {
    pointers.push({ role: ROLE_MSG_TO_SESSION, target: { kind: "primitive", value: to.session } });
  }
  if (to.model !== undefined) {
    pointers.push({ role: ROLE_MSG_TO_MODEL, target: { kind: "primitive", value: to.model } });
  }
  if (to.surface !== undefined) {
    pointers.push({ role: ROLE_MSG_TO_SURFACE, target: { kind: "primitive", value: to.surface } });
  }
  for (const t of to.topics ?? []) {
    pointers.push({
      role: ROLE_MSG_TO_TOPIC,
      target: t.endsWith(":")
        ? { kind: "primitive", value: t }
        : { kind: "entity", entity: { id: t } },
    });
  }
  if (to.user === true) {
    pointers.push({ role: ROLE_MSG_TO_USER, target: { kind: "primitive", value: true } });
  }
  if (to.author !== undefined) {
    pointers.push({ role: ROLE_MSG_TO_AUTHOR, target: { kind: "primitive", value: to.author } });
  }
  for (const a of p.about ?? []) {
    pointers.push({ role: ROLE_MSG_ABOUT, target: { kind: "entity", entity: { id: a } } });
  }
  if (p.re !== undefined) {
    pointers.push({ role: ROLE_MSG_RE, target: { kind: "delta", deltaRef: { delta: p.re } } });
  }
  return pointers;
}

// An ack is a per-recipient claim: "I have seen and handled this." A broadcast acked by one
// recipient stays visible to the others; a global withdrawal is the sender's retract.
// A response is often an EFFECT, not a reply — a commit, a clarifying belief, a retraction —
// so an ack may carry `about` references to the responding artifacts (audit-only for now).
export function ackPointers(
  messageId: string,
  note?: string,
  about?: readonly string[],
): Pointer[] {
  const pointers: Pointer[] = [
    { role: ROLE_MSG_ACK, target: { kind: "delta", deltaRef: { delta: messageId } } },
  ];
  if (note !== undefined) {
    pointers.push({ role: ROLE_MSG_ACK_NOTE, target: { kind: "primitive", value: note } });
  }
  for (const a of about ?? []) {
    pointers.push({ role: ROLE_MSG_ABOUT, target: { kind: "entity", entity: { id: a } } });
  }
  return pointers;
}

// Who is asking for their mail. Matching is disjunctive: any one addressing line that names
// you delivers the message. `author` identifies you for self-sent exclusion and ack lookup.
export interface Recipient {
  readonly author: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly surface?: string;
  readonly topics?: readonly string[];
  readonly user?: boolean; // reading as the human (the console)
  readonly userAuthor?: string; // for labeling user-sent mail in receipts
}

export interface MessageView {
  readonly id: string;
  readonly timestamp: number;
  readonly body: string;
  readonly from: {
    readonly author: string;
    readonly speaker: "user" | "session" | "unknown";
    readonly model?: string;
    readonly sessionId?: string;
  };
  readonly to: MessageAddress;
  readonly about: readonly string[];
  readonly re?: string;
  readonly acked: boolean; // by THIS recipient
}

function surviving(agent: ChorusAgent): Delta[] {
  const result = evalTerm(parseTerm({ op: "mask", policy: "drop", in: "input" }), agent.snapshot());
  if (result.sort !== "dset") throw new Error("mask must yield a DSet");
  return [...result.set];
}

// Topic matching honors prefix families on either side: a message to "synchronicity:" reaches
// a session scoped to synchronicity:mirror, and vice versa.
function topicMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(":") && b.startsWith(a)) return true;
  if (b.endsWith(":") && a.startsWith(b)) return true;
  return false;
}

// The inbox: surviving messages addressed to this recipient, minus self-sent, minus already
// acked (unless includeAcked). Sender identity resolves at the message's TIMESTAMP — a
// failed-over session's mail attributes to the model that actually wrote it.
export function inbox(
  agent: ChorusAgent,
  recipient: Recipient,
  opts: { includeAcked?: boolean } = {},
): MessageView[] {
  const alive = surviving(agent);
  const intros = identityIntroductions(alive, recipient.userAuthor);

  // My acks, by message id.
  const ackedByMe = new Set<string>();
  for (const d of alive) {
    if (d.claims.author !== recipient.author) continue;
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_MSG_ACK && p.target.kind === "delta") {
        ackedByMe.add(p.target.deltaRef.delta);
      }
    }
  }

  const views: MessageView[] = [];
  for (const d of alive) {
    let body: string | undefined;
    let re: string | undefined;
    const to: {
      session?: string;
      model?: string;
      surface?: string;
      topics?: string[];
      user?: boolean;
      author?: string;
    } = {};
    const about: string[] = [];
    for (const p of d.claims.pointers) {
      if (p.role === ROLE_MSG_BODY && p.target.kind === "primitive") {
        body = String(p.target.value);
      } else if (p.role === ROLE_MSG_TO_SESSION && p.target.kind === "primitive") {
        to.session = String(p.target.value);
      } else if (p.role === ROLE_MSG_TO_MODEL && p.target.kind === "primitive") {
        to.model = String(p.target.value);
      } else if (p.role === ROLE_MSG_TO_SURFACE && p.target.kind === "primitive") {
        to.surface = String(p.target.value);
      } else if (p.role === ROLE_MSG_TO_TOPIC) {
        const t =
          p.target.kind === "entity"
            ? p.target.entity.id
            : p.target.kind === "primitive"
              ? String(p.target.value)
              : undefined;
        if (t !== undefined) to.topics = [...(to.topics ?? []), t];
      } else if (p.role === ROLE_MSG_TO_USER && p.target.kind === "primitive") {
        to.user = p.target.value === true;
      } else if (p.role === ROLE_MSG_TO_AUTHOR && p.target.kind === "primitive") {
        to.author = String(p.target.value);
      } else if (p.role === ROLE_MSG_ABOUT && p.target.kind === "entity") {
        about.push(p.target.entity.id);
      } else if (p.role === ROLE_MSG_RE && p.target.kind === "delta") {
        re = p.target.deltaRef.delta;
      }
    }
    if (body === undefined) continue; // not a message
    if (d.claims.author === recipient.author) continue; // self-sent

    const addressed =
      to.session === undefined &&
      to.model === undefined &&
      to.surface === undefined &&
      to.topics === undefined &&
      to.user === undefined &&
      to.author === undefined
        ? true // broadcast
        : (to.session !== undefined && to.session === recipient.sessionId) ||
          (to.model !== undefined && to.model === recipient.model) ||
          (to.surface !== undefined && to.surface === recipient.surface) ||
          (to.topics !== undefined &&
            (recipient.topics ?? []).some((mine) =>
              to.topics!.some((theirs) => topicMatches(mine, theirs)),
            )) ||
          (to.user === true && recipient.user === true) ||
          (to.author !== undefined && to.author === recipient.author);
    if (!addressed) continue;

    const acked = ackedByMe.has(d.id);
    if (acked && opts.includeAcked !== true) continue;

    const sender = identityAt(intros, d.claims.author, d.claims.timestamp);
    views.push({
      id: d.id,
      timestamp: d.claims.timestamp,
      body,
      from: {
        author: d.claims.author,
        speaker: sender === undefined ? "unknown" : sender.kind === "user" ? "user" : "session",
        ...(sender?.model === undefined ? {} : { model: sender.model }),
        ...(sender?.sessionId === undefined ? {} : { sessionId: sender.sessionId }),
      },
      to,
      about,
      ...(re === undefined ? {} : { re }),
      acked,
    });
  }
  return views.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1));
}
