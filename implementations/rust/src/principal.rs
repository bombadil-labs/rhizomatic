//! Principal evidence reads (SPEC-14). The caller pins the root outside the delta set.

use std::collections::{BTreeMap, BTreeSet};

use crate::eval::{eval_term_at, EvalResult, MaskPolicy, Term};
use crate::pred::{Bindings, Cmp, Field, MatchConst, Pred, PrincipalPolicy, PrincipalPolicyKind};
use crate::reactor::Reactor;
use crate::resolution::{Order, Policy, Schema};
use crate::schema::SchemaRegistry;
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::{Delta, Primitive, Target};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopePolicy {
    Exact,
    Prefix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalSuppression {
    SameAuthor,
    RootOrSameAuthor,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrincipalReadOptions {
    pub at: f64,
    pub now: f64,
    pub scope: String,
    pub scope_policy: ScopePolicy,
    pub suppression: PrincipalSuppression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssociationGrade {
    Unresolved,
    Claimed,
    Rooted,
    Disputed,
}

impl AssociationGrade {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unresolved => "unresolved",
            Self::Claimed => "claimed",
            Self::Rooted => "rooted",
            Self::Disputed => "disputed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrincipalResult {
    pub grade: AssociationGrade,
    pub association_paths: Vec<Vec<String>>,
    pub authorized: bool,
    pub delegable: bool,
    pub authority_paths: Vec<Vec<String>>,
    pub authors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidityInterval {
    pub valid_from: f64,
    pub valid_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssociatedKey {
    pub key: String,
    pub via: Vec<String>,
    pub intervals: Vec<ValidityInterval>,
    pub negated: bool,
}

#[derive(Clone)]
enum EvidenceKind {
    Root,
    Binding {
        key: String,
    },
    Succession {
        previous: String,
        key: String,
    },
    Delegation {
        key: String,
        scope: String,
        delegable: bool,
    },
    Locator,
}

#[derive(Clone)]
struct Evidence<'a> {
    delta: &'a Delta,
    kind: EvidenceKind,
}

fn is_author(value: &str) -> bool {
    value.strip_prefix("ed25519:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}

fn primitive_str<'a>(fields: &BTreeMap<&str, &'a Target>, role: &str) -> Option<&'a str> {
    match fields.get(role)? {
        Target::Primitive(Primitive::Str(value)) => Some(value),
        _ => None,
    }
}

fn primitive_bool(fields: &BTreeMap<&str, &Target>, role: &str) -> Option<bool> {
    match fields.get(role)? {
        Target::Primitive(Primitive::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn exact(fields: &BTreeMap<&str, &Target>, roles: &[&str]) -> bool {
    fields.len() == roles.len() + 2
        && roles.iter().all(|role| fields.contains_key(role))
        && fields
            .keys()
            .all(|role| *role == "principal" || *role == "kind" || roles.contains(role))
}

fn parse_evidence<'a>(delta: &'a Delta, root: &str) -> Option<Evidence<'a>> {
    if verify_delta(delta) != Verification::Verified {
        return None;
    }
    let mut fields = BTreeMap::<&str, &Target>::new();
    for pointer in &delta.claims.pointers {
        if fields.insert(&pointer.role, &pointer.target).is_some() {
            return None;
        }
    }
    match fields.get("principal")? {
        Target::Entity(entity)
            if entity.id == root && entity.context.as_deref() == Some("rhizomatic.principal") => {}
        _ => return None,
    }
    let kind = match primitive_str(&fields, "kind")? {
        "root" if exact(&fields, &[]) => EvidenceKind::Root,
        "binding" if exact(&fields, &["key"]) => {
            let key = primitive_str(&fields, "key")?;
            if !is_author(key) {
                return None;
            }
            EvidenceKind::Binding {
                key: key.to_string(),
            }
        }
        "succession" if exact(&fields, &["previous", "key"]) => {
            let previous = primitive_str(&fields, "previous")?;
            let key = primitive_str(&fields, "key")?;
            if !is_author(previous) || !is_author(key) || previous == key {
                return None;
            }
            EvidenceKind::Succession {
                previous: previous.to_string(),
                key: key.to_string(),
            }
        }
        "delegation" if exact(&fields, &["key", "scope", "delegable"]) => {
            let key = primitive_str(&fields, "key")?;
            let scope = primitive_str(&fields, "scope")?;
            let delegable = primitive_bool(&fields, "delegable")?;
            if !is_author(key) || scope.is_empty() {
                return None;
            }
            EvidenceKind::Delegation {
                key: key.to_string(),
                scope: scope.to_string(),
                delegable,
            }
        }
        "locator" if exact(&fields, &["address"]) => {
            if primitive_str(&fields, "address")?.is_empty() {
                return None;
            }
            EvidenceKind::Locator
        }
        _ => return None,
    };
    Some(Evidence { delta, kind })
}

fn evidence<'a>(reactor: &'a Reactor, root: &str) -> Vec<Evidence<'a>> {
    reactor
        .by_target(root)
        .iter()
        .filter_map(|id| {
            reactor
                .get(id)
                .and_then(|delta| parse_evidence(delta, root))
        })
        .collect()
}

fn valid_at(delta: &Delta, at: f64) -> bool {
    delta.claims.valid_from <= at && delta.claims.valid_until.is_none_or(|end| at < end)
}

fn permits(policy: ScopePolicy, edge_scope: &str, request: &str) -> bool {
    if edge_scope == "*" {
        return true;
    }
    if request == "*" {
        return false;
    }
    edge_scope == request
        || (policy == ScopePolicy::Prefix && request.starts_with(&format!("{edge_scope}:")))
}

fn suppresses(policy: PrincipalSuppression, root: &str, negation: &Delta, target: &Delta) -> bool {
    verify_delta(negation) == Verification::Verified
        && (negation.claims.author == target.claims.author
            || (policy == PrincipalSuppression::RootOrSameAuthor && negation.claims.author == root))
}

fn check_root_time(root: &str, time: f64) -> Result<(), String> {
    if !is_author(root) {
        return Err("root must be a lowercase Ed25519 author id".to_string());
    }
    if !time.is_finite() {
        return Err("read time must be finite".to_string());
    }
    Ok(())
}

#[derive(Clone)]
struct Path {
    key: String,
    ids: Vec<String>,
    delegable: bool,
}

fn association_paths(records: &[Evidence<'_>], root: &str) -> Vec<Path> {
    let mut paths = vec![Path {
        key: root.to_string(),
        ids: Vec::new(),
        delegable: true,
    }];
    for record in records {
        if record.delta.claims.author != root {
            continue;
        }
        if let EvidenceKind::Binding { key } = &record.kind {
            paths.push(Path {
                key: key.clone(),
                ids: vec![record.delta.id.clone()],
                delegable: false,
            });
        }
    }
    let successions: Vec<&Evidence<'_>> = records
        .iter()
        .filter(|record| {
            record.delta.claims.author == root
                && matches!(&record.kind, EvidenceKind::Succession { .. })
        })
        .collect();
    let mut index = 0;
    while index < paths.len() {
        let parent = paths[index].clone();
        for record in &successions {
            if let EvidenceKind::Succession { previous, key } = &record.kind {
                if *previous != parent.key || parent.ids.contains(&record.delta.id) {
                    continue;
                }
                let mut ids = parent.ids.clone();
                ids.push(record.delta.id.clone());
                paths.push(Path {
                    key: key.clone(),
                    ids,
                    delegable: false,
                });
            }
        }
        index += 1;
    }
    paths
}

fn authority_paths(
    records: &[Evidence<'_>],
    root: &str,
    scope: &str,
    policy: ScopePolicy,
) -> Vec<Path> {
    let mut paths = vec![Path {
        key: root.to_string(),
        ids: Vec::new(),
        delegable: true,
    }];
    let delegations: Vec<&Evidence<'_>> = records
        .iter()
        .filter(|record| match &record.kind {
            EvidenceKind::Delegation { scope: edge, .. } => permits(policy, edge, scope),
            _ => false,
        })
        .collect();
    let mut index = 0;
    while index < paths.len() {
        let parent = paths[index].clone();
        if parent.delegable {
            for record in &delegations {
                if let EvidenceKind::Delegation { key, delegable, .. } = &record.kind {
                    if record.delta.claims.author != parent.key
                        || parent.ids.contains(&record.delta.id)
                    {
                        continue;
                    }
                    let mut ids = parent.ids.clone();
                    ids.push(record.delta.id.clone());
                    paths.push(Path {
                        key: key.clone(),
                        ids,
                        delegable: *delegable,
                    });
                }
            }
        }
        index += 1;
    }
    paths
}

/// Resolve signed association separately from effective delegation authority.
pub fn resolve_principal(
    reactor: &Reactor,
    root: &str,
    key: &str,
    options: &PrincipalReadOptions,
) -> Result<PrincipalResult, String> {
    check_root_time(root, options.at)?;
    if !is_author(key) {
        return Err("key must be a lowercase Ed25519 author id".to_string());
    }
    if !options.now.is_finite() {
        return Err("now must be finite".to_string());
    }
    if options.scope.is_empty() {
        return Err("scope must be nonempty".to_string());
    }
    let all = evidence(reactor, root);
    let mut negations = reactor.negation_reader(options.at, |negation, target| {
        suppresses(options.suppression, root, negation, target)
    })?;
    let active: Vec<Evidence<'_>> = all
        .into_iter()
        .filter(|record| {
            valid_at(record.delta, options.at) && !negations.is_negated(&record.delta.id)
        })
        .collect();
    let associations = association_paths(&active, root);
    let mine: Vec<&Path> = associations.iter().filter(|path| path.key == key).collect();
    let mut successor_groups = BTreeMap::<String, BTreeSet<String>>::new();
    for record in &active {
        if let EvidenceKind::Succession { previous, key } = &record.kind {
            if record.delta.claims.author == root {
                successor_groups
                    .entry(previous.clone())
                    .or_default()
                    .insert(key.clone());
            }
        }
    }
    let disputed_ids: BTreeSet<&str> = active
        .iter()
        .filter_map(|record| match &record.kind {
            EvidenceKind::Succession { previous, .. }
                if record.delta.claims.author == root
                    && successor_groups
                        .get(previous)
                        .is_some_and(|group| group.len() > 1) =>
            {
                Some(record.delta.id.as_str())
            }
            _ => None,
        })
        .collect();
    let claimed = active.iter().any(|record| match &record.kind {
        EvidenceKind::Binding { key: named } | EvidenceKind::Succession { key: named, .. } => {
            named == key && record.delta.claims.author != root
        }
        _ => false,
    });
    let grade = if mine
        .iter()
        .any(|path| path.ids.iter().any(|id| disputed_ids.contains(id.as_str())))
    {
        AssociationGrade::Disputed
    } else if !mine.is_empty() {
        AssociationGrade::Rooted
    } else if claimed {
        AssociationGrade::Claimed
    } else {
        AssociationGrade::Unresolved
    };
    let authority = authority_paths(&active, root, &options.scope, options.scope_policy);
    let mine_authority: Vec<&Path> = authority.iter().filter(|path| path.key == key).collect();
    let authors: BTreeSet<String> = authority.iter().map(|path| path.key.clone()).collect();
    let mut association_paths: Vec<Vec<String>> =
        mine.iter().map(|path| path.ids.clone()).collect();
    let mut authority_paths: Vec<Vec<String>> =
        mine_authority.iter().map(|path| path.ids.clone()).collect();
    association_paths.sort();
    authority_paths.sort();
    Ok(PrincipalResult {
        grade,
        association_paths,
        authorized: !mine_authority.is_empty(),
        delegable: mine_authority.iter().any(|path| path.delegable),
        authority_paths,
        authors: authors.into_iter().collect(),
    })
}

/// The author set a governed read can use, under the same explicit authority inputs.
pub fn authors_for_principal(
    reactor: &Reactor,
    root: &str,
    options: &PrincipalReadOptions,
) -> Result<Vec<String>, String> {
    Ok(resolve_principal(reactor, root, root, options)?.authors)
}

/// Historical associations remain visible after validity or negation ends their present effect.
pub fn associated_keys(
    reactor: &Reactor,
    root: &str,
    now: f64,
    suppression: PrincipalSuppression,
) -> Result<Vec<AssociatedKey>, String> {
    check_root_time(root, now)?;
    let records = evidence(reactor, root);
    let paths = association_paths(&records, root);
    let mut negations = reactor.negation_reader(now, |negation, target| {
        suppresses(suppression, root, negation, target)
    })?;
    let mut rows: Vec<AssociatedKey> = paths
        .iter()
        .map(|path| AssociatedKey {
            key: path.key.clone(),
            via: path.ids.clone(),
            intervals: path
                .ids
                .iter()
                .map(|id| {
                    let claims = &reactor
                        .get(id)
                        .expect("path only holds retained evidence")
                        .claims;
                    ValidityInterval {
                        valid_from: claims.valid_from,
                        valid_until: claims.valid_until,
                    }
                })
                .collect(),
            negated: path.ids.iter().any(|id| negations.is_negated(id)),
        })
        .collect();
    rows.sort_by(|left, right| {
        left.key
            .cmp(&right.key)
            .then_with(|| left.via.cmp(&right.via))
    });
    Ok(rows)
}

/// A principal resolver receives the exact delta set and time of the enclosing evaluation.
pub type PrincipalResolver<'a> =
    dyn Fn(&DeltaSet, &str, &PrincipalPolicy, f64) -> Result<Vec<String>, String> + 'a;

/// Portable resolver over the supplied input set, with an explicit suppression profile.
pub fn principal_resolver(
    suppression: PrincipalSuppression,
) -> impl Fn(&DeltaSet, &str, &PrincipalPolicy, f64) -> Result<Vec<String>, String> {
    move |input, root, policy, at| {
        let mut reactor = Reactor::new();
        for delta in input.iter() {
            if reactor.ingest(delta.clone()) != crate::reactor::IngestResult::Accepted {
                return Err("principal input contains an invalid delta".to_string());
            }
        }
        let scope_policy = match policy.kind {
            PrincipalPolicyKind::Exact => ScopePolicy::Exact,
            PrincipalPolicyKind::Prefix => ScopePolicy::Prefix,
        };
        authors_for_principal(
            &reactor,
            root,
            &PrincipalReadOptions {
                at,
                now: at,
                scope: policy.scope.clone(),
                scope_policy,
                suppression,
            },
        )
    }
}

/// Resolve against an indexed reactor only when the term input is its exact current set.
pub fn principal_resolver_for_reactor(
    reactor: &Reactor,
    suppression: PrincipalSuppression,
) -> impl Fn(&DeltaSet, &str, &PrincipalPolicy, f64) -> Result<Vec<String>, String> + '_ {
    move |input, root, policy, at| {
        if input.len() != reactor.len()
            || input
                .iter()
                .any(|delta| reactor.get(&delta.id) != Some(delta))
        {
            return Err("principal resolver input differs from the supplied reactor".to_string());
        }
        let scope_policy = match policy.kind {
            PrincipalPolicyKind::Exact => ScopePolicy::Exact,
            PrincipalPolicyKind::Prefix => ScopePolicy::Prefix,
        };
        authors_for_principal(
            reactor,
            root,
            &PrincipalReadOptions {
                at,
                now: at,
                scope: policy.scope.clone(),
                scope_policy,
                suppression,
            },
        )
    }
}

fn lower_pred(
    pred: &Pred,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<Pred, String> {
    Ok(match pred {
        Pred::ActsFor { root, policy } => Pred::Match {
            field: Field::Author,
            cmp: Cmp::InSet,
            constant: MatchConst::Many(
                resolver(input, root, policy, at)?
                    .into_iter()
                    .map(Primitive::Str)
                    .collect(),
            ),
        },
        Pred::And(left, right) => Pred::And(
            Box::new(lower_pred(left, input, at, resolver)?),
            Box::new(lower_pred(right, input, at, resolver)?),
        ),
        Pred::Or(left, right) => Pred::Or(
            Box::new(lower_pred(left, input, at, resolver)?),
            Box::new(lower_pred(right, input, at, resolver)?),
        ),
        Pred::Not(inner) => Pred::Not(Box::new(lower_pred(inner, input, at, resolver)?)),
        Pred::InView {
            term,
            field,
            extract,
        } => Pred::InView {
            term: Box::new(lower_principal_term(term, input, at, resolver)?),
            field: *field,
            extract: extract.clone(),
        },
        Pred::HasPointer(p) => {
            let mut p = p.clone();
            p.role = p
                .role
                .as_ref()
                .map(|m| lower_string_match(m, input, at, resolver))
                .transpose()?;
            p.context = p
                .context
                .as_ref()
                .map(|m| lower_string_match(m, input, at, resolver))
                .transpose()?;
            Pred::HasPointer(p)
        }
        _ => pred.clone(),
    })
}

fn lower_string_match(
    m: &crate::pred::StrMatch,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<crate::pred::StrMatch, String> {
    Ok(match m {
        crate::pred::StrMatch::Aliased(a) => {
            let mut a = (**a).clone();
            a.trust = a
                .trust
                .as_ref()
                .map(|p| lower_pred(p, input, at, resolver))
                .transpose()?;
            crate::pred::StrMatch::Aliased(Box::new(a))
        }
        _ => m.clone(),
    })
}

fn lower_order(
    order: &Order,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<Order, String> {
    Ok(match order {
        Order::ByPred { pred, then } => Order::ByPred {
            pred: lower_pred(pred, input, at, resolver)?,
            then: Box::new(lower_order(then, input, at, resolver)?),
        },
        Order::Chain(orders) => Order::Chain(
            orders
                .iter()
                .map(|item| lower_order(item, input, at, resolver))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => order.clone(),
    })
}

fn lower_policy(
    policy: &Policy,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<Policy, String> {
    Ok(match policy {
        Policy::Pick(order) => Policy::Pick(lower_order(order, input, at, resolver)?),
        Policy::All(order, distinct) => {
            Policy::All(lower_order(order, input, at, resolver)?, *distinct)
        }
        Policy::Conflicts(order) => Policy::Conflicts(lower_order(order, input, at, resolver)?),
        Policy::AbsentAs { constant, then } => Policy::AbsentAs {
            constant: constant.clone(),
            then: Box::new(lower_policy(then, input, at, resolver)?),
        },
        _ => policy.clone(),
    })
}

pub fn lower_principal_reading(
    schema: &Schema,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<Schema, String> {
    let mut lowered = schema.clone();
    lowered.props = schema
        .props
        .iter()
        .map(|(name, policy)| Ok((name.clone(), lower_policy(policy, input, at, resolver)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    lowered.default = lower_policy(&schema.default, input, at, resolver)?;
    Ok(lowered)
}

/// Lower every serializable actsFor node before the lower evaluator sees it.
pub fn lower_principal_term(
    term: &Term,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<Term, String> {
    if !at.is_finite() {
        return Err("now must be a finite number".to_string());
    }
    Ok(match term {
        Term::Input | Term::Fix { .. } => term.clone(),
        Term::Select { pred, of } => Term::Select {
            pred: lower_pred(pred, input, at, resolver)?,
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
        Term::Union { left, right } => Term::Union {
            left: Box::new(lower_principal_term(left, input, at, resolver)?),
            right: Box::new(lower_principal_term(right, input, at, resolver)?),
        },
        Term::Intersect { left, right } => Term::Intersect {
            left: Box::new(lower_principal_term(left, input, at, resolver)?),
            right: Box::new(lower_principal_term(right, input, at, resolver)?),
        },
        Term::Difference { of, without } => Term::Difference {
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
            without: Box::new(lower_principal_term(without, input, at, resolver)?),
        },
        Term::Mask { policy, of } => Term::Mask {
            policy: match policy {
                MaskPolicy::Trust(pred) => {
                    MaskPolicy::Trust(lower_pred(pred, input, at, resolver)?)
                }
                _ => policy.clone(),
            },
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
        Term::Group { key, of } => Term::Group {
            key: key.clone(),
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
        Term::Prune { keep, of } => Term::Prune {
            keep: match keep {
                crate::eval::PruneKeep::All => keep.clone(),
                crate::eval::PruneKeep::Match(m) => {
                    crate::eval::PruneKeep::Match(lower_string_match(m, input, at, resolver)?)
                }
            },
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
        Term::Expand {
            role,
            schema,
            reading,
            of,
        } => Term::Expand {
            role: lower_string_match(role, input, at, resolver)?,
            schema: schema.clone(),
            reading: reading.clone(),
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
        Term::Resolve { schema, of } => Term::Resolve {
            schema: lower_principal_reading(schema, input, at, resolver)?,
            of: Box::new(lower_principal_term(of, input, at, resolver)?),
        },
    })
}

/// Preserve signed schema references while lowering their bodies for this evaluation.
pub fn lower_principal_registry(
    registry: &SchemaRegistry,
    input: &DeltaSet,
    at: f64,
    resolver: &PrincipalResolver<'_>,
) -> Result<SchemaRegistry, String> {
    registry.map_evaluation_bodies(
        |body| lower_principal_term(body, input, at, resolver),
        |reading| lower_principal_reading(reading, input, at, resolver),
    )
}

/// Evaluate with an explicitly supplied principal resolver over this input and time.
pub fn eval_principal_term(
    term: &Term,
    input: &DeltaSet,
    now: f64,
    resolver: &PrincipalResolver<'_>,
    root: Option<&str>,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
) -> Result<EvalResult, String> {
    let lowered_registry = registry
        .map(|registry| lower_principal_registry(registry, input, now, resolver))
        .transpose()?;
    eval_term_at(
        &lower_principal_term(term, input, now, resolver)?,
        input,
        now,
        root,
        lowered_registry.as_ref(),
        bindings,
    )
}

/// Register a view whose principal membership follows ingest and validity boundaries.
pub fn register_principal_materialization<F>(
    reactor: &mut Reactor,
    name: &str,
    term: Term,
    roots: &[String],
    now: f64,
    resolver: F,
    registry: Option<SchemaRegistry>,
) -> Result<(), String>
where
    F: Fn(&DeltaSet, &str, &PrincipalPolicy, f64) -> Result<Vec<String>, String>
        + Send
        + Sync
        + 'static,
{
    reactor.register_at_lowered(
        name,
        term,
        roots,
        now,
        registry,
        move |body, input, at, registry| {
            Ok((
                lower_principal_term(body, input, at, &resolver)?,
                registry
                    .map(|registry| lower_principal_registry(registry, input, at, &resolver))
                    .transpose()?,
            ))
        },
    )
}
