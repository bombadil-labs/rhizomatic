// Principal evidence reads (SPEC-14). A pinned root is an input, never discovered from the set.
import { verifyDelta } from "../delta/sign.js";
import type { Delta, Pointer, Primitive } from "../delta/types.js";
import { Reactor, type Suppression } from "../reactor/reactor.js";

export type ScopePolicy = "exact" | "prefix" | ((edgeScope: string, request: string) => boolean);
export type PrincipalSuppression = "sameAuthor" | "rootOrSameAuthor" | Suppression;
export type AssociationGrade = "unresolved" | "claimed" | "rooted" | "disputed";

export interface PrincipalReadOptions {
  readonly at: number;
  readonly now: number;
  readonly scope: string;
  readonly scopePolicy: ScopePolicy;
  readonly suppression: PrincipalSuppression;
}

export interface PrincipalResult {
  readonly grade: AssociationGrade;
  readonly associationPaths: readonly (readonly string[])[];
  readonly authorized: boolean;
  readonly delegable: boolean;
  readonly authorityPaths: readonly (readonly string[])[];
  readonly authors: readonly string[];
}

export interface AssociatedKey {
  readonly key: string;
  readonly via: readonly string[];
  readonly intervals: readonly {
    readonly validFrom: number;
    readonly validUntil?: number;
  }[];
  readonly negated: boolean;
}

type Evidence =
  | { readonly kind: "root"; readonly delta: Delta }
  | { readonly kind: "binding"; readonly delta: Delta; readonly key: string }
  | {
      readonly kind: "succession";
      readonly delta: Delta;
      readonly previous: string;
      readonly key: string;
    }
  | {
      readonly kind: "delegation";
      readonly delta: Delta;
      readonly key: string;
      readonly scope: string;
      readonly delegable: boolean;
    }
  | { readonly kind: "locator"; readonly delta: Delta; readonly address: string };

const AUTHOR = /^ed25519:[0-9a-f]{64}$/;
const isAuthor = (value: unknown): value is string =>
  typeof value === "string" && AUTHOR.test(value);
const validAt = (delta: Delta, at: number): boolean =>
  delta.claims.validFrom <= at &&
  (delta.claims.validUntil === undefined || at < delta.claims.validUntil);

function primitive(pointer: Pointer | undefined): Primitive | undefined {
  return pointer?.target.kind === "primitive" ? pointer.target.value : undefined;
}

function parseEvidence(delta: Delta, root: string): Evidence | undefined {
  if (verifyDelta(delta) !== "verified") return undefined;
  const fields = new Map<string, Pointer>();
  for (const pointer of delta.claims.pointers) {
    if (fields.has(pointer.role)) return undefined;
    fields.set(pointer.role, pointer);
  }
  const principal = fields.get("principal")?.target;
  if (
    principal?.kind !== "entity" ||
    principal.entity.id !== root ||
    principal.entity.context !== "rhizomatic.principal"
  )
    return undefined;
  const kind = primitive(fields.get("kind"));
  const exact = (...roles: string[]) =>
    fields.size === roles.length + 2 &&
    roles.every((role) => fields.has(role)) &&
    [...fields.keys()].every(
      (role) => role === "principal" || role === "kind" || roles.includes(role),
    );
  switch (kind) {
    case "root":
      return exact() ? { kind, delta } : undefined;
    case "binding": {
      const key = primitive(fields.get("key"));
      return exact("key") && isAuthor(key) ? { kind, delta, key } : undefined;
    }
    case "succession": {
      const previous = primitive(fields.get("previous"));
      const key = primitive(fields.get("key"));
      return exact("previous", "key") && isAuthor(previous) && isAuthor(key) && previous !== key
        ? { kind, delta, previous, key }
        : undefined;
    }
    case "delegation": {
      const key = primitive(fields.get("key"));
      const scope = primitive(fields.get("scope"));
      const delegable = primitive(fields.get("delegable"));
      return exact("key", "scope", "delegable") &&
        isAuthor(key) &&
        typeof scope === "string" &&
        scope.length > 0 &&
        typeof delegable === "boolean"
        ? { kind, delta, key, scope, delegable }
        : undefined;
    }
    case "locator": {
      const address = primitive(fields.get("address"));
      return exact("address") && typeof address === "string" && address.length > 0
        ? { kind, delta, address }
        : undefined;
    }
    default:
      return undefined;
  }
}

function evidence(reactor: Reactor, root: string): Evidence[] {
  const out: Evidence[] = [];
  for (const id of reactor.byTarget(root)) {
    const delta = reactor.get(id);
    const parsed = delta === undefined ? undefined : parseEvidence(delta, root);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function policyAllows(policy: ScopePolicy, edgeScope: string, request: string): boolean {
  if (typeof policy === "function") return policy(edgeScope, request);
  if (edgeScope === "*") return true;
  if (request === "*") return false;
  return edgeScope === request || (policy === "prefix" && request.startsWith(`${edgeScope}:`));
}

function suppressionFor(root: string, policy: PrincipalSuppression): Suppression {
  if (typeof policy === "function") return policy;
  if (policy !== "sameAuthor" && policy !== "rootOrSameAuthor") {
    throw new Error("unknown principal suppression profile");
  }
  return (negation, target) =>
    negation.claims.author === target.claims.author ||
    (policy === "rootOrSameAuthor" && negation.claims.author === root);
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return left.length - right.length;
}

function checkRootAndTime(root: string, at: number): void {
  if (!isAuthor(root)) throw new Error("root must be a lowercase Ed25519 author id");
  if (!Number.isFinite(at)) throw new Error("read time must be finite");
}

interface AssociationPath {
  readonly key: string;
  readonly ids: readonly string[];
}

function associationPaths(records: readonly Evidence[], root: string): AssociationPath[] {
  const paths: AssociationPath[] = [{ key: root, ids: [] }];
  const bindings = records.filter(
    (record): record is Extract<Evidence, { kind: "binding" }> =>
      record.kind === "binding" && record.delta.claims.author === root,
  );
  for (const binding of bindings) paths.push({ key: binding.key, ids: [binding.delta.id] });
  const successions = records.filter(
    (record): record is Extract<Evidence, { kind: "succession" }> =>
      record.kind === "succession" && record.delta.claims.author === root,
  );
  for (let i = 0; i < paths.length; i++) {
    const parent = paths[i]!;
    for (const succession of successions) {
      if (succession.previous !== parent.key || parent.ids.includes(succession.delta.id)) continue;
      paths.push({ key: succession.key, ids: [...parent.ids, succession.delta.id] });
    }
  }
  return paths;
}

interface AuthorityPath extends AssociationPath {
  readonly delegable: boolean;
}

function authorityPaths(
  records: readonly Evidence[],
  root: string,
  scope: string,
  policy: ScopePolicy,
): AuthorityPath[] {
  const paths: AuthorityPath[] = [{ key: root, ids: [], delegable: true }];
  const delegations = records.filter(
    (record): record is Extract<Evidence, { kind: "delegation" }> =>
      record.kind === "delegation" && policyAllows(policy, record.scope, scope),
  );
  for (let i = 0; i < paths.length; i++) {
    const parent = paths[i]!;
    if (!parent.delegable) continue;
    for (const delegation of delegations) {
      if (delegation.delta.claims.author !== parent.key || parent.ids.includes(delegation.delta.id))
        continue;
      paths.push({
        key: delegation.key,
        ids: [...parent.ids, delegation.delta.id],
        delegable: delegation.delegable,
      });
    }
  }
  return paths;
}

/** Resolve signed association and effective authority without choosing a governing root. */
export function resolvePrincipal(
  reactor: Reactor,
  root: string,
  key: string,
  options: PrincipalReadOptions,
): PrincipalResult {
  checkRootAndTime(root, options.at);
  if (!isAuthor(key)) throw new Error("key must be a lowercase Ed25519 author id");
  if (!Number.isFinite(options.now)) throw new Error("now must be finite");
  if (typeof options.scope !== "string" || options.scope.length === 0)
    throw new Error("scope must be nonempty");
  if (
    typeof options.scopePolicy !== "function" &&
    options.scopePolicy !== "exact" &&
    options.scopePolicy !== "prefix"
  ) {
    throw new Error("unknown principal scope policy");
  }
  const isNegated = reactor.negationPredicate(
    options.at,
    suppressionFor(root, options.suppression),
  );
  const all = evidence(reactor, root);
  const active = all.filter(
    (record) => validAt(record.delta, options.at) && !isNegated(record.delta.id),
  );
  const associations = associationPaths(active, root);
  const mine = associations.filter((path) => path.key === key);
  const successorGroups = new Map<string, Set<string>>();
  for (const record of active) {
    if (record.kind !== "succession" || record.delta.claims.author !== root) continue;
    const group = successorGroups.get(record.previous) ?? new Set<string>();
    group.add(record.key);
    successorGroups.set(record.previous, group);
  }
  const disputedIds = new Set(
    active
      .filter(
        (record): record is Extract<Evidence, { kind: "succession" }> =>
          record.kind === "succession" &&
          record.delta.claims.author === root &&
          (successorGroups.get(record.previous)?.size ?? 0) > 1,
      )
      .map((record) => record.delta.id),
  );
  const claimed = active.some(
    (record) =>
      (record.kind === "binding" || record.kind === "succession") &&
      record.key === key &&
      record.delta.claims.author !== root,
  );
  const grade: AssociationGrade =
    mine.length > 0
      ? mine.some((path) => path.ids.some((id) => disputedIds.has(id)))
        ? "disputed"
        : "rooted"
      : claimed
        ? "claimed"
        : "unresolved";
  const authority = authorityPaths(active, root, options.scope, options.scopePolicy);
  const mineAuthority = authority.filter((path) => path.key === key);
  return {
    grade,
    associationPaths: mine.map((path) => path.ids).sort(comparePaths),
    authorized: mineAuthority.length > 0,
    delegable: mineAuthority.some((path) => path.delegable),
    authorityPaths: mineAuthority.map((path) => path.ids).sort(comparePaths),
    authors: [...new Set(authority.map((path) => path.key))].sort(),
  };
}

/** The author set a governed read can use, under the same explicit authority inputs. */
export function authorsForPrincipal(
  reactor: Reactor,
  root: string,
  options: PrincipalReadOptions,
): readonly string[] {
  return resolvePrincipal(reactor, root, root, options).authors;
}

/** Historical associations remain visible after validity or negation ends their current effect. */
export function associatedKeys(
  reactor: Reactor,
  root: string,
  now: number,
  suppression: PrincipalSuppression,
): readonly AssociatedKey[] {
  checkRootAndTime(root, now);
  const records = evidence(reactor, root);
  const paths = associationPaths(records, root);
  const isNegated = reactor.negationPredicate(now, suppressionFor(root, suppression));
  return paths
    .map((path) => ({
      key: path.key,
      via: path.ids,
      intervals: path.ids.map((id) => {
        const claims = reactor.get(id)!.claims;
        return {
          validFrom: claims.validFrom,
          ...(claims.validUntil === undefined ? {} : { validUntil: claims.validUntil }),
        };
      }),
      negated: path.ids.some(isNegated),
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : comparePaths(left.via, right.via),
    );
}
