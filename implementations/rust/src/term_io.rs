//! Term serialization back to the JSON profile, the generic JSON<->CBOR bridge, and term hashing
//! (ERRATA-2 E12). Mirrors ../ts/src/term-io.ts.

use serde_json::{json, Map, Value};

use crate::cbor::{encode, CborValue};
use crate::eval::{GroupKey, MaskPolicy, PruneKeep, SchemaRef, Term};
use crate::hash::content_address;
use crate::policy::{MergeFn, Order, Policy, PropPolicy};
use crate::pred::{Cmp, EntityMatch, Field, MatchConst, PPred, Param, Pred, StrMatch, ValMatch};
use crate::types::Primitive;

// --- AST -> JSON profile ---------------------------------------------------------------------------

fn prim_to_json(p: &Primitive) -> Value {
    match p {
        Primitive::Str(s) => json!(s),
        Primitive::Num(n) => json!(n),
        Primitive::Bool(b) => json!(b),
    }
}

fn cmp_str(c: Cmp) -> &'static str {
    match c {
        Cmp::Eq => "eq",
        Cmp::Neq => "neq",
        Cmp::Lt => "lt",
        Cmp::Lte => "lte",
        Cmp::Gt => "gt",
        Cmp::Gte => "gte",
        Cmp::Prefix => "prefix",
        Cmp::InSet => "inSet",
    }
}

fn str_match_to_json(m: &StrMatch) -> Value {
    match m {
        StrMatch::Exact(s) => json!({ "exact": s }),
        StrMatch::Prefix(s) => json!({ "prefix": s }),
        StrMatch::InSet(vs) => json!({ "inSet": vs }),
    }
}

fn param_to_json(p: &Param) -> Value {
    match p {
        Param::Lit(v) => prim_to_json(v),
        Param::Hole(name) => json!({ "hole": name }),
    }
}

fn val_match_to_json(m: &ValMatch) -> Value {
    match m {
        ValMatch::Vcmp { cmp, value } => {
            json!({ "vcmp": { "cmp": cmp_str(*cmp), "value": param_to_json(value) } })
        }
        ValMatch::Between { lo, hi } => json!({ "between": [prim_to_json(lo), prim_to_json(hi)] }),
        ValMatch::InSet(vs) => json!({ "inSet": vs.iter().map(prim_to_json).collect::<Vec<_>>() }),
    }
}

fn ppred_to_json(p: &PPred) -> Value {
    let mut out = Map::new();
    if let Some(m) = &p.role {
        out.insert("role".into(), str_match_to_json(m));
    }
    if let Some(e) = &p.target_entity {
        out.insert(
            "targetEntity".into(),
            match e {
                EntityMatch::Const(id) => json!(id),
                EntityMatch::Root => json!({ "var": "root" }),
                EntityMatch::Hole(name) => json!({ "hole": name }),
            },
        );
    }
    if let Some(d) = &p.target_delta {
        out.insert("targetDelta".into(), json!(d));
    }
    if let Some(m) = &p.context {
        out.insert("context".into(), str_match_to_json(m));
    }
    if let Some(b) = p.target_is_primitive {
        out.insert("targetIsPrimitive".into(), json!(b));
    }
    if let Some(m) = &p.target_value {
        out.insert("targetValue".into(), val_match_to_json(m));
    }
    Value::Object(out)
}

pub fn pred_to_json(pred: &Pred) -> Value {
    match pred {
        Pred::True => json!("true"),
        Pred::False => json!("false"),
        Pred::Match {
            field,
            cmp,
            constant,
        } => {
            let field = match field {
                Field::Author => "author",
                Field::Timestamp => "timestamp",
                Field::Id => "id",
            };
            let constant = match constant {
                MatchConst::One(p) => prim_to_json(p),
                MatchConst::Many(ps) => Value::Array(ps.iter().map(prim_to_json).collect()),
                MatchConst::Hole(name) => json!({ "hole": name }),
            };
            json!({ "match": { "field": field, "cmp": cmp_str(*cmp), "const": constant } })
        }
        Pred::HasPointer(pp) => json!({ "hasPointer": ppred_to_json(pp) }),
        Pred::And(l, r) => json!({ "and": [pred_to_json(l), pred_to_json(r)] }),
        Pred::Or(l, r) => json!({ "or": [pred_to_json(l), pred_to_json(r)] }),
        Pred::Not(p) => json!({ "not": pred_to_json(p) }),
    }
}

fn order_to_json(o: &Order) -> Value {
    match o {
        Order::ByTimestamp { desc } => json!({ "byTimestamp": if *desc { "desc" } else { "asc" } }),
        Order::ByAuthorRank(authors) => json!({ "byAuthorRank": authors }),
        Order::ByPred { pred, then } => {
            json!({ "byPred": { "pred": pred_to_json(pred), "then": order_to_json(then) } })
        }
        Order::LexById => json!("lexById"),
    }
}

fn merge_fn_str(f: MergeFn) -> &'static str {
    match f {
        MergeFn::Max => "max",
        MergeFn::Min => "min",
        MergeFn::Sum => "sum",
        MergeFn::Count => "count",
        MergeFn::And => "and",
        MergeFn::Or => "or",
        MergeFn::ConcatSorted => "concatSorted",
    }
}

fn prop_policy_to_json(pp: &PropPolicy) -> Value {
    match pp {
        PropPolicy::Pick(o) => json!({ "pick": { "order": order_to_json(o) } }),
        PropPolicy::All(o) => json!({ "all": { "order": order_to_json(o) } }),
        PropPolicy::Merge(f) => json!({ "merge": merge_fn_str(*f) }),
        PropPolicy::Conflicts(o) => json!({ "conflicts": { "order": order_to_json(o) } }),
        PropPolicy::AbsentAs { constant, then } => {
            json!({ "absentAs": { "const": prim_to_json(constant), "then": prop_policy_to_json(then) } })
        }
    }
}

pub fn policy_to_json(p: &Policy) -> Value {
    let mut props = Map::new();
    for (k, v) in &p.props {
        props.insert(k.clone(), prop_policy_to_json(v));
    }
    json!({ "props": props, "default": prop_policy_to_json(&p.default) })
}

fn schema_ref_to_json(r: &SchemaRef) -> Value {
    match r {
        SchemaRef::Name(n) => json!(n),
        SchemaRef::Pinned(h) => json!({ "pinned": h }),
    }
}

pub fn term_to_json(term: &Term) -> Value {
    match term {
        Term::Input => json!("input"),
        Term::Select { pred, of } => {
            json!({ "op": "select", "pred": pred_to_json(pred), "in": term_to_json(of) })
        }
        Term::Union { left, right } => {
            json!({ "op": "union", "left": term_to_json(left), "right": term_to_json(right) })
        }
        Term::Mask { policy, of } => {
            let policy = match policy {
                MaskPolicy::Drop => json!("drop"),
                MaskPolicy::Annotate => json!("annotate"),
                MaskPolicy::Trust(p) => json!({ "trust": pred_to_json(p) }),
            };
            json!({ "op": "mask", "policy": policy, "in": term_to_json(of) })
        }
        Term::Group { key, of } => {
            let key = match key {
                GroupKey::ByTargetContext => json!("byTargetContext"),
                GroupKey::ByRole => json!("byRole"),
                GroupKey::Const(s) => json!({ "const": s }),
            };
            json!({ "op": "group", "key": key, "in": term_to_json(of) })
        }
        Term::Prune { keep, of } => {
            let keep = match keep {
                PruneKeep::All => json!("all"),
                PruneKeep::Match(m) => str_match_to_json(m),
            };
            json!({ "op": "prune", "keep": keep, "in": term_to_json(of) })
        }
        Term::Expand { role, schema, of } => json!({
            "op": "expand",
            "role": str_match_to_json(role),
            "schema": schema_ref_to_json(schema),
            "in": term_to_json(of),
        }),
        Term::Fix {
            schema,
            entity,
            bindings,
        } => {
            let mut out = serde_json::Map::new();
            out.insert("op".into(), json!("fix"));
            out.insert("schema".into(), schema_ref_to_json(schema));
            out.insert("entity".into(), json!(entity));
            if let Some(b) = bindings {
                if !b.is_empty() {
                    // BTreeMap iterates sorted, matching the TS serializer's sorted keys.
                    let bo: serde_json::Map<String, Value> = b
                        .iter()
                        .map(|(k, v)| (k.clone(), prim_to_json(v)))
                        .collect();
                    out.insert("bindings".into(), Value::Object(bo));
                }
            }
            Value::Object(out)
        }
        Term::Resolve { policy, of } => {
            json!({ "op": "resolve", "policy": policy_to_json(policy), "in": term_to_json(of) })
        }
    }
}

// --- generic JSON <-> CBOR bridge ------------------------------------------------------------------

pub fn json_to_cbor(v: &Value) -> Result<CborValue, String> {
    match v {
        Value::String(s) => Ok(CborValue::Tstr(s.clone())),
        Value::Number(_) => {
            let n = v.as_f64().ok_or("json: number not representable as f64")?;
            if !n.is_finite() {
                return Err("json: non-finite number".to_string());
            }
            Ok(CborValue::Float(n))
        }
        Value::Bool(b) => Ok(CborValue::Bool(*b)),
        Value::Array(xs) => Ok(CborValue::Array(
            xs.iter().map(json_to_cbor).collect::<Result<Vec<_>, _>>()?,
        )),
        Value::Object(m) => Ok(CborValue::Map(
            m.iter()
                .map(|(k, x)| Ok((k.clone(), json_to_cbor(x)?)))
                .collect::<Result<Vec<_>, String>>()?,
        )),
        Value::Null => Err("json: null is outside the CBOR profile".to_string()),
    }
}

pub fn cbor_to_json(v: &CborValue) -> Value {
    match v {
        CborValue::Tstr(s) => json!(s),
        CborValue::Float(n) => json!(n),
        CborValue::Bool(b) => json!(b),
        CborValue::Array(xs) => Value::Array(xs.iter().map(cbor_to_json).collect()),
        CborValue::Map(entries) => {
            let mut m = Map::new();
            for (k, x) in entries {
                m.insert(k.clone(), cbor_to_json(x));
            }
            Value::Object(m)
        }
    }
}

// --- term hashing (E12) ----------------------------------------------------------------------------

pub fn term_canonical_bytes(term: &Term) -> Result<Vec<u8>, String> {
    Ok(encode(&json_to_cbor(&term_to_json(term))?))
}

pub fn term_canonical_hex(term: &Term) -> Result<String, String> {
    Ok(hex::encode(term_canonical_bytes(term)?))
}

/// A term's content address: same multihash as deltas (E12).
pub fn term_hash(term: &Term) -> Result<String, String> {
    Ok(content_address(&term_canonical_bytes(term)?))
}
