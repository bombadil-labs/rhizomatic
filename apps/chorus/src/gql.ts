// GraphQL on demand: a schema you don't maintain, because it doesn't persist.
//
// The store's vocabulary is open — entities and attributes are minted on the fly, an attribute
// may carry a primitive on one entity and a reference on another, and cardinality (scalar vs
// list) is a RESOLUTION-POLICY artifact decided at read time, not a stored flag. A static
// GraphQL schema is in direct tension with all of that. The reconciliation: don't keep a schema.
//
// `prepareGql` pins a snapshot of the store, reflects over its surviving deltas under a chosen
// policy, and SYNTHESIZES a GraphQL schema for that frozen (snapshot, policy) pair. The schema is
// ephemeral: it is a pure function of what was there at the instant you pinned it. You then run
// any number of queries against that frozen triple until you release or regenerate it — so a
// long, multi-hop, retrospective walk ("what was I thinking the last time I…") reads one
// consistent world and never races a concurrent write. The schema's "staticness" doesn't go away;
// it moves down to the pin, where it belongs.
//
// Every resolver is just an operation over the pinned snapshot: a scalar/reference field is a
// `recall` over the frozen set under the frozen policy; a reverse edge is a lookup in an inbound
// index built once over that same set. Reflection identifies REFERENCES honestly (it reads the
// value pointer's kind, not a substring), so traversal follows the graph, never the spelling.

import { evalTerm, parseTerm, type Delta, type DeltaSet } from "@bombadil/rhizomatic";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  graphql,
  graphqlSync,
  printSchema,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLOutputType,
} from "graphql";
import type { ChorusAgent } from "./agent.js";
import { ROLE_ABOUT, ROLE_VALUE } from "./vocab.js";

// A uniform attribute gets a typed scalar; a heterogeneous one degrades to "Value" — the
// pass-through scalar — so mixed primitives stay type-faithful instead of coercing to text.
type ScalarKind = "String" | "Float" | "Int" | "Boolean" | "Value";

// --- reflection model -------------------------------------------------------------------------

// A reflected attribute on a type: its observed value shape and cardinality under the policy.
interface AttrShape {
  readonly attribute: string; // the store-native attribute name (may contain non-word chars)
  readonly field: string; // a GraphQL-legal field name derived from it
  reference: boolean; // true if the value is an entity REFERENCE (follows the graph)
  list: boolean; // true if it resolves to many values (set-valued under the policy)
  scalarType: ScalarKind; // observed primitive kind (refs ignore this)
  scalarPinned: boolean; // false until the first primitive observation fixes scalarType
  readonly targets: Set<string>; // referenced target TYPES (prefixes), when reference
}

interface TypeShape {
  readonly prefix: string; // the entity-id prefix ("concept", "event", …) — the "type"
  readonly typeName: string; // GraphQL type name ("Concept", "Event", …)
  readonly attrs: Map<string, AttrShape>; // attribute name -> shape
  readonly ids: Set<string>; // entity ids of this type that the store holds beliefs about
}

interface Reflection {
  readonly types: Map<string, TypeShape>; // prefix -> shape
  // inbound[targetId] = edges that POINT AT targetId (reverse adjacency, role-discriminated).
  readonly inbound: Map<string, InboundEdge[]>;
}

interface InboundEdge {
  readonly source: string; // the entity the edge comes FROM
  readonly attribute: string; // the attribute it was filed under at the source
  readonly role: string; // the pointer role (which kind of edge)
  readonly target: string; // the entity it points AT
  readonly deltaId: string;
  readonly author: string;
  readonly timestamp: number;
}

// The pinned, queryable artifact: a frozen world plus the schema synthesized for it.
export interface PreparedGql {
  readonly id: string;
  readonly snapshot: DeltaSet;
  readonly schema: GraphQLSchema;
  readonly sdl: string;
  readonly policy: unknown;
  readonly typeCount: number;
  readonly fieldCount: number;
  readonly deltaCount: number;
  readonly createdAt: number;
}

// The resolver context: everything frozen at prepare time. Resolvers never touch live state.
interface GqlContext {
  readonly agent: ChorusAgent;
  readonly snapshot: DeltaSet;
  readonly policy: unknown;
  readonly inbound: Map<string, InboundEdge[]>;
}

// An entity flowing through the resolvers is just its id; child resolvers recall from it.
interface NodeVal {
  readonly id: string;
}

export interface PrepareGqlOptions {
  readonly policy?: unknown; // resolution policy for cardinality + value adjudication
  readonly asOf?: number; // pin the world as it stood at this instant
  readonly prefix?: string; // restrict the schema to one entity-type family
}

// --- surviving deltas (negations applied once) ------------------------------------------------

function survivingDeltas(snapshot: DeltaSet, asOf?: number): Delta[] {
  const base =
    asOf === undefined
      ? "input"
      : {
          op: "select",
          pred: { match: { field: "timestamp", cmp: "lte", const: asOf } },
          in: "input",
        };
  const result = evalTerm(parseTerm({ op: "mask", policy: "drop", in: base }), snapshot);
  if (result.sort !== "dset") throw new Error("mask must yield a DSet");
  return [...result.set];
}

// --- naming -----------------------------------------------------------------------------------

const prefixOf = (id: string): string => {
  const i = id.indexOf(":");
  return i === -1 ? "entity" : id.slice(0, i);
};

// A GraphQL-legal identifier from an arbitrary store name. Non-word chars become "_"; a leading
// digit is prefixed. Collisions are possible but harmless at v0 (the original name is kept in the
// resolver closure, so reads stay exact).
const legal = (s: string): string => {
  const cleaned = s.replace(/[^_A-Za-z0-9]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

const typeNameOf = (prefix: string): string => {
  const l = legal(prefix);
  return l.charAt(0).toUpperCase() + l.slice(1);
};

// Internal scaffolding the schema should not surface: session bookkeeping and reserved contexts.
const isInternalEntity = (id: string): boolean => id.startsWith("session:");
const isInternalContext = (ctx: string): boolean =>
  ctx.startsWith("chorus.") || ctx.startsWith("rhizomatic.");

// --- reflection -------------------------------------------------------------------------------

// Walk the surviving deltas once and learn the shape of the world: which types exist, which
// attributes each carries, whether each attribute is a reference or a primitive, its observed
// primitive kind, and — counting values per (entity, attribute) — whether it is set-valued.
function reflect(snapshot: DeltaSet, opts: PrepareGqlOptions): Reflection {
  const types = new Map<string, TypeShape>();
  const inbound = new Map<string, InboundEdge[]>();
  // Attributes declared SET-VALUED (slice O): a surviving belief `attr:<name> plurality = set`.
  // Cardinality is a resolution artifact, not a stored flag on each value — so list-ness is read
  // from the declaration, and the matching resolver unions rather than picks.
  const pluralAttrs = new Set<string>();

  const ensureType = (prefix: string): TypeShape => {
    let t = types.get(prefix);
    if (t === undefined) {
      t = { prefix, typeName: typeNameOf(prefix), attrs: new Map(), ids: new Set() };
      types.set(prefix, t);
    }
    return t;
  };

  for (const d of survivingDeltas(snapshot, opts.asOf)) {
    // Extract the belief shape: about {id, attribute}, and the value pointer.
    let about: { id: string; attribute: string } | undefined;
    let valueEntity: string | undefined;
    let valuePrimitive: string | number | boolean | undefined;
    for (const p of d.claims.pointers) {
      if (
        p.role === ROLE_ABOUT &&
        p.target.kind === "entity" &&
        p.target.entity.context !== undefined
      ) {
        about = { id: p.target.entity.id, attribute: p.target.entity.context };
      } else if (p.role === ROLE_VALUE) {
        if (p.target.kind === "entity") valueEntity = p.target.entity.id;
        else if (p.target.kind === "primitive") valuePrimitive = p.target.value;
      }
    }
    if (about === undefined) continue;
    // A plurality declaration is vocabulary metadata, not a queryable entity: record it, skip it.
    if (
      about.id.startsWith("attr:") &&
      about.attribute === "plurality" &&
      valuePrimitive === "set"
    ) {
      pluralAttrs.add(about.id.slice("attr:".length));
      continue;
    }
    if (
      isInternalEntity(about.id) ||
      about.id.startsWith("attr:") ||
      isInternalContext(about.attribute)
    ) {
      continue;
    }
    if (opts.prefix !== undefined && !about.id.startsWith(opts.prefix)) continue;

    const type = ensureType(prefixOf(about.id));
    type.ids.add(about.id);

    const fieldName = legal(about.attribute);
    let shape = type.attrs.get(about.attribute);
    if (shape === undefined) {
      shape = {
        attribute: about.attribute,
        field: fieldName,
        reference: false,
        list: false,
        scalarType: "String",
        scalarPinned: false,
        targets: new Set(),
      };
      type.attrs.set(about.attribute, shape);
    }

    if (valueEntity !== undefined) {
      shape.reference = true;
      shape.targets.add(prefixOf(valueEntity));
      // Index the reverse edge: valueEntity is pointed AT by about.id under this attribute.
      const edge: InboundEdge = {
        source: about.id,
        attribute: about.attribute,
        role: ROLE_VALUE,
        target: valueEntity,
        deltaId: d.id,
        author: d.claims.author,
        timestamp: d.claims.timestamp,
      };
      const list = inbound.get(valueEntity) ?? [];
      list.push(edge);
      inbound.set(valueEntity, list);
      // A referenced entity is itself a node of its type, even if nothing is asserted ABOUT it.
      ensureType(prefixOf(valueEntity)).ids.add(valueEntity);
    } else if (valuePrimitive !== undefined) {
      narrowScalar(shape, valuePrimitive);
    }
  }

  // Cardinality inherits from the plurality declarations: a declared-set attribute is a list
  // everywhere it appears. (snapshot, policy) -> schema, exactly as the shrink-wrap design wants.
  for (const type of types.values()) {
    for (const shape of type.attrs.values()) {
      if (pluralAttrs.has(shape.attribute)) shape.list = true;
    }
  }

  return { types, inbound };
}

// Widen an attribute's observed primitive kind. The first observation pins the kind; mixed
// Int/Float widen to Float; anything else non-uniform degrades to String, which serializes
// every primitive faithfully.
function narrowScalar(shape: AttrShape, v: string | number | boolean): void {
  const kind: ScalarKind =
    typeof v === "number"
      ? Number.isInteger(v)
        ? "Int"
        : "Float"
      : typeof v === "boolean"
        ? "Boolean"
        : "String";
  if (!shape.scalarPinned) {
    shape.scalarType = kind;
    shape.scalarPinned = true;
    return;
  }
  if (shape.scalarType === kind) return;
  // Int and Float are both numbers — widen to Float rather than giving up.
  if (
    (shape.scalarType === "Int" && kind === "Float") ||
    (shape.scalarType === "Float" && kind === "Int")
  ) {
    shape.scalarType = "Float";
    return;
  }
  // Any other disagreement (e.g. string vs number) is genuine heterogeneity — pass through.
  shape.scalarType = "Value";
}

// --- schema synthesis -------------------------------------------------------------------------

// The pass-through value scalar: a belief's primitive payload, whatever its JSON type.
const ValueScalar = new GraphQLScalarType({
  name: "Value",
  description: "A belief's primitive value — string, number, or boolean — passed through as-is.",
  serialize: (v) => v as unknown,
});

const scalarType = (name: ScalarKind): GraphQLOutputType => {
  switch (name) {
    case "Int":
      return GraphQLInt;
    case "Float":
      return GraphQLFloat;
    case "Boolean":
      return GraphQLBoolean;
    case "Value":
      return ValueScalar;
    default:
      return GraphQLString;
  }
};

function buildSchema(reflection: Reflection): GraphQLSchema {
  const { types } = reflection;

  // The Node interface: every entity is a Node, so heterogeneous or unknown reference targets
  // resolve through it. resolveType reads the id prefix.
  const nodeInterface: GraphQLInterfaceType = new GraphQLInterfaceType({
    name: "Node",
    description: "Anything the store can hold beliefs about, addressed by id.",
    fields: () => ({ id: { type: new GraphQLNonNull(GraphQLID) } }),
    resolveType: (value: unknown) => {
      const id = (value as NodeVal).id;
      const t = types.get(prefixOf(id));
      return t === undefined ? "Node" : t.typeName;
    },
  });

  // A reverse edge surfaced as a queryable object — the neighbors() primitive in GraphQL clothes.
  const backlinkType = new GraphQLObjectType<InboundEdge, GqlContext>({
    name: "Backlink",
    description: "An edge pointing AT an entity: who points at it, under what attribute and role.",
    fields: () => ({
      source: { type: new GraphQLNonNull(GraphQLID), resolve: (e) => e.source },
      attribute: { type: new GraphQLNonNull(GraphQLString), resolve: (e) => e.attribute },
      role: { type: new GraphQLNonNull(GraphQLString), resolve: (e) => e.role },
      target: { type: new GraphQLNonNull(GraphQLID), resolve: (e) => e.target },
      author: { type: new GraphQLNonNull(GraphQLString), resolve: (e) => e.author },
      timestamp: { type: new GraphQLNonNull(GraphQLFloat), resolve: (e) => e.timestamp },
      // Follow the edge backwards into the source node — reverse traversal, one hop.
      sourceNode: {
        type: nodeInterface,
        resolve: (e): NodeVal => ({ id: e.source }),
      },
    }),
  });

  // One object type per reflected entity-type. Build lazily (fields thunk) so reference fields can
  // point at types defined later in the same pass — the schema graph may be cyclic even though the
  // SCHEMA registry (SPEC-3 §3) is not; data cycles are fine.
  const objectTypes = new Map<string, GraphQLObjectType>();
  const typeOf = (prefix: string): GraphQLObjectType | undefined => objectTypes.get(prefix);

  for (const shape of types.values()) {
    objectTypes.set(
      shape.prefix,
      new GraphQLObjectType<NodeVal, GqlContext>({
        name: shape.typeName,
        interfaces: [nodeInterface],
        fields: () => {
          const fields: GraphQLFieldConfigMap<NodeVal, GqlContext> = {
            id: { type: new GraphQLNonNull(GraphQLID), resolve: (p) => p.id },
            // Every node can be asked who points at it, scoped by attribute or role.
            backlinks: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(backlinkType))),
              args: {
                attribute: { type: GraphQLString },
                role: { type: GraphQLString },
              },
              resolve: (p, args, ctx) => incomingEdges(ctx, p.id, args),
            },
          };
          for (const attr of shape.attrs.values()) {
            fields[attr.field] = attrField(attr, typeOf, nodeInterface);
          }
          return fields;
        },
      }),
    );
  }

  // The root: per-type point lookup + listing, plus generic node and backlinks entry points.
  const queryFields: GraphQLFieldConfigMap<unknown, GqlContext> = {
    node: {
      type: nodeInterface,
      description: "Fetch any entity by id as a generic Node.",
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: (_src, args: { id: string }): NodeVal => ({ id: args.id }),
    },
    backlinks: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(backlinkType))),
      description: "Every edge pointing AT the target entity (reverse adjacency).",
      args: {
        target: { type: new GraphQLNonNull(GraphQLID) },
        attribute: { type: GraphQLString },
        role: { type: GraphQLString },
      },
      resolve: (_src, args: { target: string; attribute?: string; role?: string }, ctx) =>
        incomingEdges(ctx, args.target, args),
    },
  };

  for (const shape of types.values()) {
    const objType = typeOf(shape.prefix);
    if (objType === undefined) continue;
    const single = legal(shape.prefix);
    const many = `${single}s`;
    queryFields[single] = {
      type: objType,
      description: `Fetch one ${shape.typeName} by id.`,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: (_src, args: { id: string }, ctx): NodeVal | null =>
        entityExists(ctx, args.id) ? { id: args.id } : null,
    };
    queryFields[many] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objType))),
      description: `List ${shape.typeName} entities the pinned snapshot holds beliefs about.`,
      args: { limit: { type: GraphQLInt } },
      resolve: (_src, args: { limit?: number }): NodeVal[] => {
        const ids = [...shape.ids].sort();
        return (args.limit === undefined ? ids : ids.slice(0, args.limit)).map((id) => ({ id }));
      },
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
    types: [...objectTypes.values(), backlinkType],
  });
}

// A scalar or reference field, wrapped in a list when the attribute is set-valued.
function attrField(
  attr: AttrShape,
  typeOf: (prefix: string) => GraphQLObjectType | undefined,
  nodeInterface: GraphQLInterfaceType,
): GraphQLFieldConfig<NodeVal, GqlContext> {
  let inner: GraphQLOutputType;
  if (attr.reference) {
    // One observed target type -> that type; several or unknown -> the Node interface.
    const only = attr.targets.size === 1 ? typeOf([...attr.targets][0]!) : undefined;
    inner = only ?? nodeInterface;
  } else {
    inner = scalarType(attr.scalarType);
  }
  const type = attr.list ? new GraphQLList(new GraphQLNonNull(inner)) : inner;
  return {
    type,
    resolve: (parent, _args, ctx) => {
      const raw = recallAttr(ctx, parent.id, attr.attribute, attr.list);
      if (attr.reference) {
        const ids = toArray(raw).filter((v): v is string => typeof v === "string");
        const nodes: NodeVal[] = ids.map((id) => ({ id }));
        return attr.list ? nodes : (nodes[0] ?? null);
      }
      const vals = toArray(raw);
      return attr.list ? vals : (vals[0] ?? null);
    },
  };
}

// --- resolution over the pinned snapshot ------------------------------------------------------

// Recall one attribute of an entity over the FROZEN snapshot. A scalar field reads under the
// pinned pick-policy (one winner); a list field reads under the union policy (every surviving
// member) — the two halves of cardinality-as-policy, applied where each belongs. recall returns
// a single-key view object { [attribute]: value }; we hand back the bare value.
function recallAttr(ctx: GqlContext, id: string, attribute: string, list: boolean): unknown {
  const policy = list ? UNION_POLICY : ctx.policy;
  const view = ctx.agent.recall(id, { over: ctx.snapshot, policy, attribute });
  if (view !== null && typeof view === "object" && !Array.isArray(view)) {
    return (view as Record<string, unknown>)[attribute];
  }
  return undefined;
}

// Every surviving value, oldest first — the read for a declared-set (list) attribute.
const UNION_POLICY = { default: { all: { order: { byTimestamp: "asc" } } } };

// Does the snapshot hold any surviving belief making this id a subject OR a reference target?
function entityExists(ctx: GqlContext, id: string): boolean {
  if ((ctx.inbound.get(id)?.length ?? 0) > 0) return true;
  const view = ctx.agent.recall(id, { over: ctx.snapshot, policy: ctx.policy });
  return view !== null && typeof view === "object" && Object.keys(view).length > 0;
}

function incomingEdges(
  ctx: GqlContext,
  target: string,
  filter: { attribute?: string; role?: string },
): InboundEdge[] {
  const edges = ctx.inbound.get(target) ?? [];
  return edges
    .filter((e) => filter.attribute === undefined || e.attribute === filter.attribute)
    .filter((e) => filter.role === undefined || e.role === filter.role)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp || (a.deltaId < b.deltaId ? -1 : 1));
}

const toArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// --- prepare / query / release ----------------------------------------------------------------

let prepCounter = 0;

// Pin the store's current world, reflect, and synthesize a GraphQL schema for it.
export function prepareGql(agent: ChorusAgent, opts: PrepareGqlOptions = {}): PreparedGql {
  const snapshot = agent.snapshot();
  const policy = opts.policy ?? agent.policy;
  const reflection = reflect(snapshot, opts);
  const schema = buildSchema(reflection);
  const sdl = printSchema(schema);
  let fieldCount = 0;
  for (const t of reflection.types.values()) fieldCount += t.attrs.size;
  prepCounter += 1;
  return {
    id: `gql-${Date.now()}-${prepCounter}`,
    snapshot,
    schema,
    sdl,
    policy,
    typeCount: reflection.types.size,
    fieldCount,
    deltaCount: snapshot.size,
    createdAt: Date.now(),
    // The inbound index travels with the prepared artifact via a closure on the schema's
    // resolvers; we re-derive it for the context at query time from the same snapshot.
  };
}

export interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: string[];
}

// The frozen resolver context: every read is consistent with the pin, no matter how the live
// store has moved on. The inbound index is re-derived from the same snapshot.
function contextFor(agent: ChorusAgent, prepared: PreparedGql): GqlContext {
  return {
    agent,
    snapshot: prepared.snapshot,
    policy: prepared.policy,
    inbound: reflect(prepared.snapshot, {}).inbound,
  };
}

const shapeResult = (result: {
  data?: unknown;
  errors?: ReadonlyArray<{ message: string }>;
}): GqlResult => ({
  ...(result.data === undefined ? {} : { data: result.data as Record<string, unknown> | null }),
  ...(result.errors === undefined ? {} : { errors: result.errors.map((e) => e.message) }),
});

// Run a GraphQL query against a prepared snapshot.
export async function queryGql(
  agent: ChorusAgent,
  prepared: PreparedGql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult> {
  return shapeResult(
    await graphql({
      schema: prepared.schema,
      source: query,
      contextValue: contextFor(agent, prepared),
      ...(variables === undefined ? {} : { variableValues: variables }),
    }),
  );
}

// Synchronous execution — every resolver here is a pure read over the frozen set, so no async is
// needed. This is the path the (synchronous) MCP tool surface uses.
export function queryGqlSync(
  agent: ChorusAgent,
  prepared: PreparedGql,
  query: string,
  variables?: Record<string, unknown>,
): GqlResult {
  return shapeResult(
    graphqlSync({
      schema: prepared.schema,
      source: query,
      contextValue: contextFor(agent, prepared),
      ...(variables === undefined ? {} : { variableValues: variables }),
    }),
  );
}

// --- registry: the prepared-snapshot lifecycle ------------------------------------------------

// Prepared snapshots live until released or regenerated. The registry is per-process state — a
// query session's working set, not part of the durable store.
export class GqlRegistry {
  private readonly prepared = new Map<string, PreparedGql>();

  prepare(agent: ChorusAgent, opts: PrepareGqlOptions = {}): PreparedGql {
    const p = prepareGql(agent, opts);
    this.prepared.set(p.id, p);
    return p;
  }

  get(id: string): PreparedGql | undefined {
    return this.prepared.get(id);
  }

  async query(
    agent: ChorusAgent,
    id: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GqlResult> {
    return queryGql(agent, this.require(id), query, variables);
  }

  querySync(
    agent: ChorusAgent,
    id: string,
    query: string,
    variables?: Record<string, unknown>,
  ): GqlResult {
    return queryGqlSync(agent, this.require(id), query, variables);
  }

  private require(id: string): PreparedGql {
    const prepared = this.prepared.get(id);
    if (prepared === undefined) throw new Error(`gql: unknown prepared snapshot ${id}`);
    return prepared;
  }

  release(id: string): boolean {
    return this.prepared.delete(id);
  }

  list(): Array<{
    id: string;
    typeCount: number;
    fieldCount: number;
    deltaCount: number;
    createdAt: number;
  }> {
    return [...this.prepared.values()].map((p) => ({
      id: p.id,
      typeCount: p.typeCount,
      fieldCount: p.fieldCount,
      deltaCount: p.deltaCount,
      createdAt: p.createdAt,
    }));
  }
}
