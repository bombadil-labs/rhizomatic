//! The predicate grammar and its evaluator (SPEC-2 §3). Mirrors ../ts/src/pred.ts.
//! Predicates are total, terminating, single-delta.

use std::cmp::Ordering;

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

#[derive(Debug, Clone, PartialEq)]
pub enum StrMatch {
    Exact(String),
    Prefix(String),
    InSet(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ValMatch {
    Vcmp { cmp: Cmp, value: Primitive },
    Between { lo: Primitive, hi: Primitive },
    InSet(Vec<Primitive>),
}

/// An entity to match: a literal id, or the ambient root variable (ERRATA-2 E10).
#[derive(Debug, Clone, PartialEq)]
pub enum EntityMatch {
    Const(String),
    Root,
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
            MatchConst::One(_) => false, // rejected at parse time (E1)
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
    }
}

fn val_match(m: &ValMatch, v: &Primitive) -> bool {
    match m {
        // cmp InSet is rejected at parse time (E1) — ValMatch has its own InSet arm.
        ValMatch::Vcmp { cmp, value } => compare_with(*cmp, v, &MatchConst::One(value.clone())),
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
    }
}
