// Release A: explicit boot and read-only gather/resolve. Retention cannot install this endpoint.
import { encode, map, tstr, bstr } from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { contentAddress, bytesToHex } from "../delta/hash.js";
import type { Delta, Target } from "../delta/types.js";
import {
  verifyCommandAppearance,
  isCommandId,
  commandEntity,
  commandNumber,
} from "../command-data/codec.js";
import { materializationDescriptionClaims } from "../command-data/materialization-codec.js";
import type { MaterializationSourceCapability } from "../federation/materialization-source.js";
import { EvaluationResourceLimit } from "../resolve/evaluation-budget.js";
import { evalMaterializationTerm } from "../resolve/eval.js";
import { encodeHViewEnvelope, hviewCanonicalHex } from "../resolve/evidence.js";
import { bindReadingVariables } from "../syntax/bind-reading.js";
import { resolveView, viewCanonicalHex } from "../resolve-kernel/resolution.js";
import { EvidenceCodecError } from "../syntax/evidence-codec.js";
import type { CommandSigner } from "./endpoint.js";
import {
  type MaterializationInputBoot,
  materializationInputCatalog,
  prepareMaterializationInput,
  checkMaterializationDeliveryCounts,
  materializationRequiredBinding,
  validateMaterializationSourceInput,
  validateMaterializationInputProgram,
} from "./materialization-input.js";
import { gatherMaterializationBasis } from "./materialization-basis.js";
import {
  materializationHexBytes,
  validateGatherMaterializationEvidence,
  materializationHasMissingReading,
} from "./materialization-evidence.js";
import {
  mFail,
  mLimit,
  mFields,
  mId,
  mText,
  MaterializationInputError,
} from "./materialization-values.js";
export interface MaterializationBoot extends MaterializationInputBoot {
  readonly signer: CommandSigner;
  readonly sourceGrants: ReadonlyMap<string, MaterializationSourceCapability>;
  readonly diagnostic: (fault: unknown) => void;
}
export class MaterializationEndpoint {
  private readonly catalogInputs;
  private readonly signer: CommandSigner;
  private readonly sourceGrants: ReadonlyMap<string, MaterializationSourceCapability>;
  private constructor(private readonly inputs: MaterializationBoot) {
    this.catalogInputs = materializationInputCatalog(inputs);
    if (
      inputs.signer.author !== this.catalogInputs.receiver ||
      typeof inputs.signer.sign !== "function"
    )
      throw Error("invalid materialization signer");
    this.signer = { author: inputs.signer.author, sign: inputs.signer.sign.bind(inputs.signer) };
    this.sourceGrants = new Map(inputs.sourceGrants);
    if ([...this.sourceGrants.keys()].some((k) => !this.catalogInputs.bindings.has(k)))
      throw Error("grant for unselected binding");
  }
  static boot(inputs: MaterializationBoot): MaterializationEndpoint {
    return new MaterializationEndpoint(inputs);
  }
  catalog(): DeltaSet {
    return DeltaSet.from(
      structuredClone([
        this.catalogInputs.configuration,
        ...[...this.catalogInputs.operations.values()].map((o) => o.delta),
        ...this.catalogInputs.bindings.values(),
      ]),
    );
  }
  invoke(entryId: string, appearances: readonly unknown[], receivedAt: number): Promise<Delta> {
    if (!isCommandId(entryId) || !Array.isArray(appearances) || !Number.isFinite(receivedAt))
      throw Error("invalid materialization transport framing");
    // The known count refusal precedes allocation/copying of any supplied appearance.
    try {
      checkMaterializationDeliveryCounts(appearances, this.catalogInputs.limits);
    } catch (error) {
      if (error instanceof MaterializationInputError)
        return this.attempt(entryId, appearances, receivedAt);
      throw error;
    }
    let copied: readonly unknown[];
    try {
      copied = structuredClone(appearances);
    } catch {
      copied = [null];
    }
    return this.attempt(entryId, copied, receivedAt);
  }
  private outcome(
    entryId: string,
    receivedAt: number,
    status: "completed" | "refused",
    body: ReturnType<typeof map>,
  ): Delta {
    const ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
    const claims = materializationDescriptionClaims(this.signer.author, receivedAt, "outcome/1", {
      receiver: [{ kind: "entity", entity: { id: this.signer.author } }],
      configuration: [ref(this.catalogInputs.configuration.id)],
      request: [ref(entryId)],
      status: [{ kind: "primitive", value: status }],
      result: [{ kind: "bytes", mime: "application/cbor", value: encode(body) }],
    });
    const expected = bytesToHex(canonicalBytes(claims));
    const signed = structuredClone(this.signer.sign(structuredClone(claims)));
    verifyCommandAppearance(signed);
    if (bytesToHex(canonicalBytes(signed.claims)) !== expected)
      throw Error("invalid materialization response signer");
    return signed;
  }
  private async attempt(
    entryId: string,
    appearances: readonly unknown[],
    receivedAt: number,
  ): Promise<Delta> {
    const c = this.catalogInputs;
    try {
      const p = prepareMaterializationInput(c, entryId, appearances, receivedAt);
      let snapshot;
      let grant: MaterializationSourceCapability | undefined;
      let binding: string | undefined;
      const check = async () => {
        const result = await grant!.checkCurrent(
          binding!,
          snapshot!.revision,
          snapshot!.authority,
          receivedAt,
          snapshot!.historicalCutoff,
          Object.freeze([...p.requiredSupport]),
        );
        if (result.status !== "current") mFail(result.status);
      };
      if (p.verb === "gather") {
        binding = materializationRequiredBinding(p);
        grant = this.sourceGrants.get(binding);
        if (!grant) mFail("unauthorized");
        snapshot = validateMaterializationSourceInput(c, p, receivedAt);
        await check();
      }
      const program = validateMaterializationInputProgram(c, p);
      let body;
      if (p.verb === "gather") {
        let gathered;
        try {
          gathered = evalMaterializationTerm(
            program.selected.hyper.body,
            DeltaSet.from(snapshot!.deltas),
            commandNumber(p.fields, "at"),
            c.limits,
            commandEntity(p.fields, "root"),
            program.selected.registry,
            program.bindings,
          );
        } catch (e) {
          if (e instanceof EvaluationResourceLimit) mFail("resource-limit");
          this.inputs.diagnostic(e);
          mFail("execution-failed");
        }
        if (gathered.sort !== "hview") mFail("execution-failed");
        let envelope;
        try {
          envelope = encodeHViewEnvelope(gathered.hview, {
            artifactBytes: c.limits.artifactBytes,
            appearances: c.limits.appearances,
            entries: c.limits.entries,
            nodes: c.limits.nodes,
            depth: c.limits.depth,
            pointers: c.limits.pointers,
            buckets: c.limits.buckets,
            readings: c.limits.readings,
            syntaxDepth: c.limits.syntaxDepth,
            syntaxNodes: c.limits.syntaxNodes,
          });
        } catch (e) {
          if (e instanceof EvidenceCodecError) mFail(e.code);
          throw e;
        }
        body = map([
          ["kind", tstr("gather")],
          ["root", tstr(commandEntity(p.fields, "root"))],
          ["basis", gatherMaterializationBasis(p.fields, snapshot!, program.deltas, c.limits)],
          ["envelope", bstr(envelope)],
          ["transport", tstr(contentAddress(envelope))],
          [
            "hview",
            tstr(contentAddress(materializationHexBytes(hviewCanonicalHex(gathered.hview)))),
          ],
        ]);
      } else {
        const evidence = validateGatherMaterializationEvidence(p.evidenceBody!, c.limits),
          fs = mFields(p.evidenceBody!, [
            "kind",
            "root",
            "basis",
            "envelope",
            "transport",
            "hview",
          ]);
        if (materializationHasMissingReading(evidence.hview)) mFail("missing-reading");
        let value;
        try {
          value = materializationHexBytes(
            viewCanonicalHex(
              resolveView(
                bindReadingVariables(program.selected.reading, program.bindings),
                evidence.hview,
              ),
            ),
          );
        } catch (e) {
          this.inputs.diagnostic(e);
          mFail("execution-failed");
        }
        mLimit(value.length, c.limits.artifactBytes);
        body = map([
          ["kind", tstr("resolve")],
          ["root", tstr(mText(fs.get("root")))],
          ["basis", fs.get("basis")!],
          ["transport", tstr(mId(fs.get("transport")))],
          ["hview", tstr(mId(fs.get("hview")))],
          ["value", bstr(value)],
          ["view", tstr(contentAddress(value))],
        ]);
      }
      mLimit(encode(body).length, c.limits.artifactBytes);
      if (p.verb === "gather") await check();
      return this.outcome(entryId, receivedAt, "completed", body);
    } catch (e) {
      if (e instanceof MaterializationInputError)
        return this.outcome(entryId, receivedAt, "refused", map([["code", tstr(e.code)]]));
      this.inputs.diagnostic(e);
      throw e;
    }
  }
}
