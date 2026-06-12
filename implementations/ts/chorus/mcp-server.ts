// Chorus as drop-in memory for any agent framework: an MCP server over stdio. Hand-rolled
// JSON-RPC 2.0 (same spirit as the hand-rolled CBOR: own the bytes you must be exact about);
// the protocol surface is initialize / tools/list / tools/call.
//
// Tools: remember · recall · retract · explain · trust · as-of. State is one ChorusAgent,
// persisted as a self-verifying pack file after every write (CHORUS_PACK, default
// ./chorus-memory.pack; CHORUS_SEED_HEX pins the agent's keypair).

import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ChorusAgent } from "./agent.js";
import { loadPack, savePack } from "./store.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "remember",
    description:
      "Assert a belief as a signed claim: about (entity id), attribute (property name), value (string|number|boolean), optional kind (observation|fact|preference|task), confidence (0..1), source.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string" },
        attribute: { type: "string" },
        value: { type: ["string", "number", "boolean"] },
        kind: { enum: ["observation", "fact", "preference", "task"] },
        confidence: { type: "number" },
        source: { type: "string" },
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
      properties: { deltaId: { type: "string" }, reason: { type: "string" } },
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
      properties: { distrust: { type: "string" }, reason: { type: "string" } },
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

// One tool call against one agent. Pure of transport; the smoke tests drive this directly.
export function callTool(
  agent: ChorusAgent,
  name: string,
  args: Record<string, unknown>,
  persist?: () => void,
): unknown {
  switch (name) {
    case "remember": {
      const value = args["value"];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error("remember: value must be string | number | boolean");
      }
      const kind = str(args["kind"]);
      const delta = agent.assert({
        about: str(args["about"]) ?? "",
        attribute: str(args["attribute"]) ?? "",
        value,
        ...(kind === undefined
          ? {}
          : { kind: kind as "observation" | "fact" | "preference" | "task" }),
        ...(num(args["confidence"]) === undefined ? {} : { confidence: num(args["confidence"])! }),
        ...(str(args["source"]) === undefined ? {} : { source: str(args["source"])! }),
      });
      persist?.();
      return { deltaId: delta.id, author: agent.author, signed: delta.sig !== undefined };
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
      const negation = agent.retract(str(args["deltaId"]) ?? "", reason);
      persist?.();
      return { negationId: negation.id, negates: str(args["deltaId"]) };
    }
    case "explain":
      return agent.explain(str(args["entity"]) ?? "", str(args["attribute"]));
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
  agent: ChorusAgent,
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
        const result = callTool(agent, name, args, persist);
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
  agent: ChorusAgent,
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
    const resp = handleRequest(agent, req, persist);
    if (resp !== undefined) output.write(`${JSON.stringify(resp)}\n`);
  });
}

// Direct run: a persistent agent over stdio.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("chorus/mcp-server.ts")
) {
  const packPath = process.env["CHORUS_PACK"] ?? "chorus-memory.pack";
  const seedHex = process.env["CHORUS_SEED_HEX"] ?? "0f".repeat(32);
  const agent = new ChorusAgent({ name: "chorus-mcp", seedHex });
  if (existsSync(packPath)) agent.importSet(loadPack(packPath));
  serve(agent, process.stdin, process.stdout, () => savePack(agent, packPath));
}
