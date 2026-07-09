//! The predicate grammar and its evaluator (SPEC-2 §3). Mirrors ../ts/src/pred.ts.
//! Predicates are total, terminating, single-delta — the one stratified exception, inView
//! (SPEC-2 §3.1), is lowered to InSet before predicates meet data.

use std::cmp::Ordering;

use crate::eval::Term;
use crate::types::{Delta, Pointer, Primitive, Target};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmp {
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    Prefix,
    InSet,
}

/// The aliased closure spec (SPEC-9 §4): expanded to InSet against the ambient input before
/// matching. Boxed inside StrMatch to keep the enum small.
#[derive(Debug, Clone, PartialEq)]
pub struct AliasedMatch {
    pub name: String,
    pub via: Option<String>,
    pub trust: Option<Pred>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StrMatch {
    Exact(String),
    Prefix(String),
    InSet(Vec<String>),
    Aliased(Box<AliasedMatch>),
}

/// A parameter slot in Const position, bound through fix's bindings (SPEC-2 §6, ERRATA-2 E15).
#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    Lit(Primitive),
    Hole(String),
}

pub type Bindings = std::collections::BTreeMap<String, Primitive>;

fn resolve_param(p: &Param, bindings: Option<&Bindings>) -> Result<Primitive, String> {
    match p {
        Param::Lit(v) => Ok(v.clone()),
        Param::Hole(name) => bindings
            .and_then(|b| b.get(name))
            .cloned()
            .ok_or_else(|| format!("unbound hole \"{name}\" (E15)")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ValMatch {
    Vcmp { cmp: Cmp, value: Param },
    Between { lo: Primitive, hi: Primitive },
    InSet(Vec<Primitive>),
}

/// An entity to match: a literal id, the ambient root variable (E10), or a hole (E15).
#[derive(Debug, Clone, PartialEq)]
pub enum EntityMatch {
    Const(String),
    Root,
    Hole(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PPred {
    pub role: Option<StrMatch>,
    pub target_entity: Option<EntityMatch>,
    pub target_delta: Option<String>,
    pub context: Option<StrMatch>,
    pub target_is_primitive: Option<bool>,
    pub target_value: Option<ValMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Author,
    Timestamp,
    Id,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MatchConst {
    One(Primitive),
    Many(Vec<Primitive>),
    Hole(String),
}

/// The facet of a delta an inView extracts from its sub-view, forming the accepted set.
#[derive(Debug, Clone, PartialEq)]
pub enum InViewExtract {
    Author,
    Id,
    Role(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pred {
    True,
    False,
    Match {
        field: Field,
        cmp: Cmp,
        constant: MatchConst,
    },
    HasPointer(PPred),
    And(Box<Pred>, Box<Pred>),
    Or(Box<Pred>, Box<Pred>),
    Not(Box<Pred>),
    /// Reflective (SPEC-2 §3.1): candidate's field ∈ extract(sub-view over the ambient input).
    /// Stratified depth-1; DSet-sort sub-term only; `field` is Author | Id; all parse-enforced.
    InView {
        term: Box<Term>,
        field: Field,
        extract: InViewExtract,
    },
}

/// Does the predicate contain a reflective node anywhere? (SPEC-2 §3.1 stratification and the
/// reactor's conservative-dispatch rule both hang off this walk.)
pub fn pred_contains_in_view(pred: &Pred) -> bool {
    match pred {
        Pred::InView { .. } => true,
        Pred::And(l, r) | Pred::Or(l, r) => pred_contains_in_view(l) || pred_contains_in_view(r),
        Pred::Not(p) => pred_contains_in_view(p),
        _ => false,
    }
}

// --- the canonical total order over primitives (ERRATA-2 E3) -------------------------------------

fn type_rank(p: &Primitive) -> u8 {
    match p {
        Primitive::Bool(_) => 0,
        Primitive::Num(_) => 1,
        Primitive::Str(_) => 2,
    }
}

/// Type rank first (bool < number < string), then value; strings by NFC UTF-8 bytes
/// (Rust `str` ordering IS bytewise UTF-8 order, and data strings are NFC by validation D11).
pub fn compare_primitives(a: &Primitive, b: &Primitive) -> Ordering {
    let (ra, rb) = (type_rank(a), type_rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Primitive::Bool(x), Primitive::Bool(y)) => x.cmp(y),
        (Primitive::Num(x), Primitive::Num(y)) => x
            .partial_cmp(y)
            .expect("numbers are finite by L1 validation"),
        (Primitive::Str(x), Primitive::Str(y)) => x.as_bytes().cmp(y.as_bytes()),
        _ => unreachable!("ranks matched"),
    }
}

fn compare_with(cmp: Cmp, subject: &Primitive, constant: &MatchConst) -> bool {
    match cmp {
        Cmp::InSet => match constant {
            MatchConst::Many(vs) => vs
                .iter()
                .any(|v| compare_primitives(subject, v) == Ordering::Equal),
            // One is rejected at parse time (E1); holes are substituted away before
            // evaluation (E15) — a stray one matches nothing.
            _ => false,
        },
        Cmp::Prefix => match (subject, constant) {
            (Primitive::Str(s), MatchConst::One(Primitive::Str(p))) => s.starts_with(p.as_str()),
            _ => false,
        },
        _ => {
            let MatchConst::One(c) = constant else {
                return false;
            };
            let o = compare_primitives(subject, c);
            match cmp {
                Cmp::Eq => o == Ordering::Equal,
                Cmp::Neq => o != Ordering::Equal,
                Cmp::Lt => o == Ordering::Less,
                Cmp::Lte => o != Ordering::Greater,
                Cmp::Gt => o == Ordering::Greater,
                Cmp::Gte => o != Ordering::Less,
                Cmp::Prefix | Cmp::InSet => unreachable!("handled above"),
            }
        }
    }
}

// --- evaluation ------------------------------------------------------------------------------------

pub fn str_match(m: &StrMatch, s: &str) -> bool {
    match m {
        StrMatch::Exact(v) => s == v,
        StrMatch::Prefix(v) => s.starts_with(v.as_str()),
        StrMatch::InSet(vs) => vs.iter().any(|v| v == s),
        // Every consumer expands aliased against the ambient input first (SPEC-9 §4.1); reaching
        // here is an evaluator bug, not bad data.
        StrMatch::Aliased(a) => {
            unreachable!(
                "aliased(\"{}\") must be expanded before matching (SPEC-9)",
                a.name
            )
        }
    }
}

fn val_match(m: &ValMatch, v: &Primitive) -> bool {
    match m {
        // cmp InSet is rejected at parse time (E1) — ValMatch has its own InSet arm.
        // Holes are substituted away before evaluation (E15); a stray one matches nothing.
        ValMatch::Vcmp {
            cmp,
            value: Param::Lit(value),
        } => compare_with(*cmp, v, &MatchConst::One(value.clone())),
        ValMatch::Vcmp { .. } => false,
        ValMatch::Between { lo, hi } => {
            compare_primitives(v, lo) != Ordering::Less
                && compare_primitives(v, hi) != Ordering::Greater
        }
        ValMatch::InSet(vs) => vs
            .iter()
            .any(|x| compare_primitives(v, x) == Ordering::Equal),
    }
}

fn pointer_matches(p: &PPred, ptr: &Pointer, root: Option<&str>) -> bool {
    if let Some(m) = &p.role {
        if !str_match(m, &ptr.role) {
            return false;
        }
    }
    if let Some(e) = &p.target_entity {
        let Target::Entity(er) = &ptr.target else {
            return false;
        };
        // The root variable matches nothing without an ambient root (E10).
        let want = match e {
            EntityMatch::Const(id) => Some(id.as_str()),
            EntityMatch::Root => root,
            // Substituted away before evaluation (E15); a stray hole matches nothing.
            EntityMatch::Hole(_) => None,
        };
        if want != Some(er.id.as_str()) {
            return false;
        }
    }
    if let Some(d) = &p.target_delta {
        match &ptr.target {
            Target::Delta(dr) if &dr.delta == d => {}
            _ => return false,
        }
    }
    if let Some(m) = &p.context {
        let ctx = match &ptr.target {
            Target::Entity(er) => er.context.as_deref(),
            Target::Delta(dr) => dr.context.as_deref(),
            Target::Primitive(_) => None,
        };
        match ctx {
            Some(c) if str_match(m, c) => {}
            _ => return false,
        }
    }
    if let Some(want) = p.target_is_primitive {
        if matches!(ptr.target, Target::Primitive(_)) != want {
            return false;
        }
    }
    if let Some(m) = &p.target_value {
        match &ptr.target {
            Target::Primitive(v) if val_match(m, v) => {}
            _ => return false,
        }
    }
    true
}

/// Total and terminating: O(|delta|) per evaluation, no data dereference (SPEC-2 §3).
/// root is the ambient root entity, consulted only by the root variable (E10).
pub fn eval_pred(pred: &Pred, delta: &Delta, root: Option<&str>) -> bool {
    match pred {
        Pred::True => true,
        Pred::False => false,
        Pred::Match {
            field,
            cmp,
            constant,
        } => {
            let subject = match field {
                Field::Author => Primitive::Str(delta.claims.author.clone()),
                Field::Timestamp => Primitive::Num(delta.claims.timestamp),
                Field::Id => Primitive::Str(delta.id.clone()),
            };
            compare_with(*cmp, &subject, constant)
        }
        Pred::HasPointer(pp) => delta
            .claims
            .pointers
            .iter()
            .any(|ptr| pointer_matches(pp, ptr, root)),
        Pred::And(l, r) => eval_pred(l, delta, root) && eval_pred(r, delta, root),
        Pred::Or(l, r) => eval_pred(l, delta, root) || eval_pred(r, delta, root),
        Pred::Not(p) => !eval_pred(p, delta, root),
        // Every consumer lowers inView against the ambient input first (SPEC-2 §3.1); reaching
        // here is an evaluator bug, not bad data.
        Pred::InView { .. } => {
            unreachable!("inView must be resolved before matching (SPEC-2 §3.1)")
        }
    }
}

/// Eagerly resolve every hole in a predicate against the ambient bindings (E15). Applied where
/// a predicate meets data (select / mask-trust), so an unbound hole errors deterministically —
/// regardless of how many deltas the operand happens to hold.
pub fn substitute_holes(pred: &Pred, bindings: Option<&Bindings>) -> Result<Pred, String> {
    Ok(match pred {
        Pred::True | Pred::False => pred.clone(),
        Pred::Match {
            field,
            cmp,
            constant,
        } => match constant {
            MatchConst::Hole(name) => Pred::Match {
                field: *field,
                cmp: *cmp,
                constant: MatchConst::One(resolve_param(&Param::Hole(name.clone()), bindings)?),
            },
            _ => pred.clone(),
        },
        Pred::HasPointer(pp) => {
            let mut out = pp.clone();
            if let Some(EntityMatch::Hole(name)) = &pp.target_entity {
                match resolve_param(&Param::Hole(name.clone()), bindings)? {
                    Primitive::Str(id) => out.target_entity = Some(EntityMatch::Const(id)),
                    _ => {
                        return Err(format!(
                            "hole \"{name}\" bound to a non-string where an entity id is required (E15)"
                        ))
                    }
                }
            }
            if let Some(ValMatch::Vcmp {
                cmp,
                value: value @ Param::Hole(_),
            }) = &pp.target_value
            {
                out.target_value = Some(ValMatch::Vcmp {
                    cmp: *cmp,
                    value: Param::Lit(resolve_param(value, bindings)?),
                });
            }
            Pred::HasPointer(out)
        }
        Pred::And(l, r) => Pred::And(
            Box::new(substitute_holes(l, bindings)?),
            Box::new(substitute_holes(r, bindings)?),
        ),
        Pred::Or(l, r) => Pred::Or(
            Box::new(substitute_holes(l, bindings)?),
            Box::new(substitute_holes(r, bindings)?),
        ),
        Pred::Not(p) => Pred::Not(Box::new(substitute_holes(p, bindings)?)),
        // Holes inside the sub-term resolve from the same ambient bindings when it is evaluated.
        Pred::InView { .. } => pred.clone(),
    })
}
