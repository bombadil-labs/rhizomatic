// Fixed test transport; diagnostics are stderr, signed semantic artifacts are stdout JSON.
import { readFileSync } from "node:fs";
import { parseClaims } from "../src/delta/json-profile.js";
import { signClaims } from "../src/delta/sign.js";
import {
  commandFields,
  commandText,
  commandRef,
  parseCommandDelta,
  serializeCommandDelta,
  readOperation,
  readRequestCommon,
  readRequestArguments,
  verifyCommandAppearance,
  writeCommandDescription,
  type DescriptionKind,
} from "../src/command-data/codec.js";
import { readCommandResult } from "../src/command/read-result.js";
import type { Delta } from "../src/delta/types.js";
interface DebugSign {
  claims: unknown;
  seed: string;
}
interface Artifact {
  format: string;
  entryId: string;
  deltas: unknown[];
}
interface Context {
  boot: { configuration: unknown; declarations: unknown[] };
  construction?: { request: DebugSign; support: DebugSign[] };
}
interface Input {
  mode: string;
  scenario: string;
  context: Context;
  artifact?: Artifact;
  outcome?: unknown;
}
const sign = (d: DebugSign) => signClaims(parseClaims(d.claims), d.seed);
function operation(context: Context, id: string): "retain" | "evaluate" {
  const delta = context.boot.declarations.map(parseCommandDelta).find((d) => d.id === id);
  if (!delta) throw new Error("fixture operation absent");
  return readOperation(delta);
}
function validate(artifact: Artifact, context: Context): Delta {
  if (artifact.format !== "rhizomatic-command-artifact/1") throw new Error("artifact version");
  const deltas = artifact.deltas.map(parseCommandDelta);
  deltas.forEach(verifyCommandAppearance);
  const entry = deltas.find((d) => d.id === artifact.entryId);
  if (!entry) throw new Error("entry missing");
  const common = readRequestCommon(entry);
  readRequestArguments(entry, operation(context, commandRef(common, "operation")));
  return entry;
}
function run(input: Input): unknown {
  switch (input.mode) {
    case "construct": {
      const construction = input.context.construction;
      if (!construction) throw new Error("construction missing");
      let request = sign(construction.request);
      const common = readRequestCommon(request);
      readRequestArguments(request, operation(input.context, commandRef(common, "operation")));
      const fields = { ...commandFields(request) };
      const kind = commandText(fields, "kind") as DescriptionKind;
      delete fields.kind;
      const canonical = writeCommandDescription(
        construction.request.seed,
        request.claims.timestamp,
        kind,
        fields,
      );
      request = signClaims(
        { ...request.claims, pointers: canonical.claims.pointers },
        construction.request.seed,
      );
      return {
        artifact: {
          format: "rhizomatic-command-artifact/1",
          entryId: request.id,
          deltas: [request, ...construction.support.map(sign)].map(serializeCommandDelta),
        },
      };
    }
    case "validate": {
      try {
        validate(input.artifact!, input.context);
        return { artifact: input.artifact, verdict: { valid: true } };
      } catch (fault) {
        return { artifact: input.artifact, verdict: { valid: false, diagnostic: String(fault) } };
      }
    }
    case "read-result": {
      const configuration = parseCommandDelta(input.context.boot.configuration);
      const outcome = parseCommandDelta(input.outcome);
      const result = readCommandResult(outcome, {
        receiver: configuration.claims.author,
        configuration: configuration.id,
        request: input.artifact!.entryId,
      });
      const bodyHex = Buffer.from(
        result.fields.result![0]!.kind === "bytes" ? result.fields.result![0]!.value : [],
      ).toString("hex");
      return {
        status: result.status,
        bodyHex,
        ...(result.value ? { valueHex: Buffer.from(result.value).toString("hex") } : {}),
      };
    }
    default:
      throw new Error("execution is unavailable before M2");
  }
}
try {
  process.stdout.write(JSON.stringify(run(JSON.parse(readFileSync(0, "utf8")) as Input)) + "\n");
} catch (fault) {
  process.stderr.write(String(fault) + "\n");
  process.exitCode = 1;
}
