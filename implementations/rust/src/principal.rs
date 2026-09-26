//! Principal evidence reads (SPEC-14). The caller pins the root outside the delta set.

use std::collections::{BTreeMap, BTreeSet};

use crate::reactor::Reactor;
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
    Binding { key: String },
    Succession { previous: String, key: String },
    Delegation { key: String, scope: String, delegable: bool },
    Locator,
}

#[derive(Clone)]
struct Evidence<'a> {
    delta: &'a Delta,
    kind: EvidenceKind,
}

fn is_author(value: &str) -> bool {
    value
        .strip_prefix("ed25519:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
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
            EvidenceKind::Binding { key: key.to_string() }
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
        .filter_map(|id| reactor.get(id).and_then(|delta| parse_evidence(delta, root)))
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

fn suppresses(
    policy: PrincipalSuppression,
    root: &str,
    negation: &Delta,
    target: &Delta,
) -> bool {
    negation.claims.author == target.claims.author
        || (policy == PrincipalSuppression::RootOrSameAuthor && negation.claims.author == root)
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
                    if record.delta.claims.author != parent.key || parent.ids.contains(&record.delta.id) {
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
        .filter(|record| valid_at(record.delta, options.at) && !negations.is_negated(&record.delta.id))
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
                    && successor_groups.get(previous).is_some_and(|group| group.len() > 1) =>
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
    let mut association_paths: Vec<Vec<String>> = mine.iter().map(|path| path.ids.clone()).collect();
    let mut authority_paths: Vec<Vec<String>> = mine_authority.iter().map(|path| path.ids.clone()).collect();
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
                    let claims = &reactor.get(id).expect("path only holds retained evidence").claims;
                    ValidityInterval {
                        valid_from: claims.valid_from,
                        valid_until: claims.valid_until,
                    }
                })
                .collect(),
            negated: path.ids.iter().any(|id| negations.is_negated(id)),
        })
        .collect();
    rows.sort_by(|left, right| left.key.cmp(&right.key).then_with(|| left.via.cmp(&right.via)));
    Ok(rows)
}
