// SPEC-16 MR-21 projection: all supplied inputs, never native currentness or produced outputs.
import { isCommandId } from "../command-data/codec.js";
import {
  type MaterializationInputBoot,
  materializationInputCatalog,
  prepareMaterializationInput,
  checkMaterializationDeliveryCounts,
  validateMaterializationSourceInput,
  validateMaterializationInputProgram,
} from "./materialization-input.js";
import { validateGatherMaterializationEvidence } from "./materialization-evidence.js";
import { MaterializationInputError } from "./materialization-values.js";
export type MaterializationInputPreflight =
  | { readonly status: "input-valid" }
  | { readonly status: "over-input-limit"; readonly code: "resource-limit" }
  | { readonly status: "invalid-input"; readonly code: string };
export function preflightMaterializationInput(
  boot: MaterializationInputBoot,
  entryId: string,
  appearances: readonly unknown[],
  receivedAt: number,
): MaterializationInputPreflight {
  if (!isCommandId(entryId) || !Array.isArray(appearances) || !Number.isFinite(receivedAt))
    throw Error("invalid materialization transport framing");
  const catalog = materializationInputCatalog(boot);
  try {
    checkMaterializationDeliveryCounts(appearances, catalog.limits);
  } catch (error) {
    if (error instanceof MaterializationInputError)
      return error.code === "resource-limit"
        ? { status: "over-input-limit", code: "resource-limit" }
        : { status: "invalid-input", code: error.code };
    throw error;
  }
  let copied: readonly unknown[];
  try {
    copied = structuredClone(appearances);
  } catch {
    copied = [null];
  }
  try {
    const p = prepareMaterializationInput(catalog, entryId, copied, receivedAt);
    if (p.verb === "gather") validateMaterializationSourceInput(catalog, p, receivedAt);
    validateMaterializationInputProgram(catalog, p);
    if (p.verb === "resolve")
      validateGatherMaterializationEvidence(p.evidenceBody!, catalog.limits);
    return { status: "input-valid" };
  } catch (e) {
    if (e instanceof MaterializationInputError)
      return e.code === "resource-limit"
        ? { status: "over-input-limit", code: "resource-limit" }
        : { status: "invalid-input", code: e.code };
    throw e;
  }
}
