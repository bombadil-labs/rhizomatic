// A named lens binds one gather program and one resolution Schema by content address.
// Governing authors and selection order are explicit inputs to the read.

import { DeltaSet } from "../delta/set.js";
import type { Claims, Delta } from "../delta/types.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import { evalTerm, firstByOrder, governedDeltas, type AuthorSelection } from "../resolve/eval.js";
import type { HyperSchema } from "../schema/schema.js";
import type { Order, Schema } from "../syntax/model.js";
import { schemaHash, termHash } from "../syntax/term-io.js";
import { HYPER_SCHEMA_SCHEMA } from "./schema-deltas.js";

const BINDS = `${VOCAB_PREFIX}.lens.binds`;
const HYPERSCHEMA = `${VOCAB_PREFIX}.lens.hyperschema`;
const SCHEMA = `${VOCAB_PREFIX}.lens.schema`;
const PIN = /^1e20[0-9a-f]{64}$/;

export interface LensBinding {
  readonly name: string;
  readonly hyperSchemaPin: string;
  readonly schemaPin: string;
  readonly deltaId: string;
}

export function publishLensBindingClaims(
  name: string,
  hyperSchema: HyperSchema,
  schema: Schema,
  author: string,
  timestamp: number,
): Claims {
  return {
    timestamp,
    validFrom: timestamp,
    author,
    pointers: [
      { role: BINDS, target: { kind: "entity", entity: { id: name, context: "lens" } } },
      { role: HYPERSCHEMA, target: { kind: "primitive", value: termHash(hyperSchema.body) } },
      { role: SCHEMA, target: { kind: "primitive", value: schemaHash(schema) } },
    ],
  };
}

function readBinding(delta: Delta, name: string): LensBinding {
  const pointers = delta.claims.pointers;
  const filing = pointers.filter(
    (p) =>
      p.role === BINDS &&
      p.target.kind === "entity" &&
      p.target.entity.id === name &&
      p.target.entity.context === "lens",
  );
  const pins = (role: string) =>
    pointers.filter((p) => p.role === role && p.target.kind === "primitive");
  const hyper = pins(HYPERSCHEMA);
  const schema = pins(SCHEMA);
  if (pointers.length !== 3 || filing.length !== 1 || hyper.length !== 1 || schema.length !== 1) {
    throw new Error(`malformed lens binding delta ${delta.id}`);
  }
  const hyperSchemaPin = hyper[0]!.target;
  const schemaPin = schema[0]!.target;
  if (
    hyperSchemaPin.kind !== "primitive" ||
    schemaPin.kind !== "primitive" ||
    typeof hyperSchemaPin.value !== "string" ||
    typeof schemaPin.value !== "string" ||
    !PIN.test(hyperSchemaPin.value) ||
    !PIN.test(schemaPin.value)
  ) {
    throw new Error(`malformed lens binding delta ${delta.id}`);
  }
  return {
    name,
    hyperSchemaPin: hyperSchemaPin.value,
    schemaPin: schemaPin.value,
    deltaId: delta.id,
  };
}

export function loadLensBinding(
  input: DeltaSet,
  name: string,
  now: number,
  authors: AuthorSelection,
  order: Order,
): LensBinding {
  const governed = governedDeltas(input, now, authors);
  const result = evalTerm(HYPER_SCHEMA_SCHEMA.body, governed, now, name);
  if (result.sort !== "hview") throw new Error("lens bootstrap must yield an HView");
  const chosen = firstByOrder(order, result.hview.props.get("lens") ?? []);
  if (chosen === undefined) throw new Error(`no surviving lens binding for ${name}`);
  return readBinding(chosen.delta, name);
}

export function lensBindingRoles(): { binds: string; hyperSchema: string; schema: string } {
  return { binds: BINDS, hyperSchema: HYPERSCHEMA, schema: SCHEMA };
}
