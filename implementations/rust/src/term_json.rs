//! Parse the JSON term profile (ERRATA-2 E1) into Term/Pred. Mirrors ../ts/src/term-json.ts.
//! Strings are NFC-normalized at parse time.

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::eval::{term_contains_in_view, GroupKey, MaskPolicy, PruneKeep, SchemaRef, Term};
use crate::pred::{
    pred_contains_in_view, AliasedMatch, Cmp, EntityMatch, Field, InViewExtract, MatchConst, PPred,
    Param, Pred, StrMatch, ValMatch,
};
use crate::resolution::{MergeFn, Order, Policy, Schema};
use crate::strict::{as_dispatched, as_object, as_open_map, one_tag};
use crate::types::Primitive;

/// The closed key sets of the §9 profile (issue #25). Every object node in the grammar names its
/// keys here or at its call site; the only open nodes are `fix.bindings` and `schema.props`, whose
/// keys are author-chosen data rather than grammar.
const TERM_KEYS: [(&str, &[&str]); 10] = [
    ("select", &["op", "pred", "in"]),
    ("union", &["op", "left", "right"]),
    ("intersect", &["op", "left", "right"]),
    ("difference", &["op", "of", "without"]),
    ("mask", &["op", "policy", "in"]),
    ("group", &["op", "key", "in"]),
    ("prune", &["op", "keep", "in"]),
    ("expand", &["op", "role", "schema", "reading", "in"]),
    ("fix", &["op", "schema", "entity", "bindings"]),
    ("resolve", &["op", "schema", "in"]),
];

const STR_MATCH_TAGS: [&str; 4] = ["exact", "prefix", "inSet", "aliased"];
const VAL_MATCH_TAGS: [&str; 3] = ["vcmp", "between", "inSet"];
const PRED_TAGS: [&str; 6] = ["match", "hasPointer", "and", "or", "not", "inView"];
const ORDER_TAGS: [&str; 4] = ["byTimestamp", "byAuthorRank", "byPred", "chain"];
const POLICY_TAGS: [&str; 5] = ["pick", "all", "merge", "conflicts", "absentAs"];
const EXTRACT_TAGS: [&str; 2] = ["field", "role"];

/// A hole in Const position: {"hole": "name"} (E15). Speculative — a non-hole returns None so the
/// caller can try a primitive — but once the `hole` key is present the node IS a hole, and its
/// keys are checked like any other closed node (issue #25).
fn parse_hole(v: &Value) -> Result<Option<String>, String> {
    match v.as_object() {
        Some(o) if o.contains_key("hole") => {
            let o = as_object(v, "hole", &["hole"])?;
            let name = o
                .get("hole")
                .and_then(Value::as_str)
                .ok_or("hole name must be a string")?;
            Ok(Some(nfc(name)))
        }
        _ => Ok(None),
    }
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

fn parse_primitive(v: &Value, what: &str) -> Result<Primitive, String> {
    match v {
        Value::String(s) => Ok(Primitive::Str(nfc(s))),
        Value::Bool(b) => Ok(Primitive::Bool(*b)),
        Value::Number(_) => {
            let n = v.as_f64().ok_or_else(|| format!("{what}: bad number"))?;
            if !n.is_finite() {
                return Err(format!("{what}: numeric constant must be finite"));
            }
            Ok(Primitive::Num(n))
        }
        _ => Err(format!(
            "{what}: constant must be string | number | boolean"
        )),
    }
}

fn parse_cmp(v: &Value, what: &str) -> Result<Cmp, String> {
    match v.as_str() {
        Some("eq") => Ok(Cmp::Eq),
        Some("neq") => Ok(Cmp::Neq),
        Some("lt") => Ok(Cmp::Lt),
        Some("lte") => Ok(Cmp::Lte),
        Some("gt") => Ok(Cmp::Gt),
        Some("gte") => Ok(Cmp::Gte),
        Some("prefix") => Ok(Cmp::Prefix),
        Some("inSet") => Ok(Cmp::InSet),
        _ => Err(format!("{what}: unknown cmp {v}")),
    }
}

fn parse_str_match(v: &Value, what: &str) -> Result<StrMatch, String> {
    let (o, tag) = one_tag(v, &STR_MATCH_TAGS, what)?;
    match tag {
        "exact" => Ok(StrMatch::Exact(nfc(o["exact"]
            .as_str()
            .ok_or_else(|| format!("{what}: exact must be a string"))?))),
        "prefix" => Ok(StrMatch::Prefix(nfc(o["prefix"]
            .as_str()
            .ok_or_else(|| format!("{what}: prefix must be a string"))?))),
        "inSet" => {
            let arr = o["inSet"]
                .as_array()
                .ok_or_else(|| format!("{what}: inSet must be an array"))?;
            let values = arr
                .iter()
                .map(|s| {
                    s.as_str()
                        .map(nfc)
                        .ok_or_else(|| format!("{what}: inSet members must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(StrMatch::InSet(values))
        }
        _ => {
            let ao = as_object(
                &o["aliased"],
                &format!("{what}.aliased"),
                &["name", "via", "trust"],
            )?;
            let name = ao
                .get("name")
                .and_then(Value::as_str)
                .map(nfc)
                .ok_or_else(|| format!("{what}: aliased.name must be a string"))?;
            let via = match ao.get("via") {
                None => None,
                Some(v) => Some(
                    v.as_str()
                        .map(nfc)
                        .ok_or_else(|| format!("{what}: aliased.via must be an entity id"))?,
                ),
            };
            let trust = match ao.get("trust") {
                None => None,
                Some(t) => {
                    let pred = parse_pred(t)?;
                    assert_closed_trust_pred(&pred, &format!("{what}.aliased.trust"))?;
                    Some(pred)
                }
            };
            Ok(StrMatch::Aliased(Box::new(AliasedMatch {
                name,
                via,
                trust,
            })))
        }
    }
}

/// An aliased trust predicate admits no holes and no nested aliased (SPEC-9 §4.1): it is
/// evaluated against alias-vocabulary deltas during closure computation, outside the hole
/// environment and outside any further expansion.
fn assert_closed_trust_pred(p: &Pred, what: &str) -> Result<(), String> {
    match p {
        Pred::True | Pred::False => Ok(()),
        Pred::Match { constant, .. } => match constant {
            MatchConst::Hole(_) => Err(format!(
                "{what}: holes are not allowed inside an aliased trust predicate"
            )),
            _ => Ok(()),
        },
        Pred::HasPointer(pp) => {
            if matches!(pp.target_entity, Some(EntityMatch::Hole(_)))
                || matches!(
                    pp.target_value,
                    Some(ValMatch::Vcmp {
                        value: Param::Hole(_),
                        ..
                    })
                )
            {
                return Err(format!(
                    "{what}: holes are not allowed inside an aliased trust predicate"
                ));
            }
            if matches!(pp.role, Some(StrMatch::Aliased(_)))
                || matches!(pp.context, Some(StrMatch::Aliased(_)))
            {
                return Err(format!(
                    "{what}: nested aliased is not allowed inside an aliased trust predicate"
                ));
            }
            Ok(())
        }
        Pred::And(l, r) | Pred::Or(l, r) => {
            assert_closed_trust_pred(l, what)?;
            assert_closed_trust_pred(r, what)
        }
        Pred::Not(p) => assert_closed_trust_pred(p, what),
        Pred::InView { .. } => Err(format!(
            "{what}: inView is not allowed inside an aliased trust predicate"
        )),
    }
}

fn parse_val_match(v: &Value, what: &str) -> Result<ValMatch, String> {
    let (o, tag) = one_tag(v, &VAL_MATCH_TAGS, what)?;
    match tag {
        "vcmp" => {
            let vo = as_object(&o["vcmp"], &format!("{what}.vcmp"), &["cmp", "value"])?;
            let cmp = parse_cmp(
                vo.get("cmp").unwrap_or(&Value::Null),
                &format!("{what}.vcmp"),
            )?;
            if cmp == Cmp::InSet {
                return Err(format!(
                    "{what}: vcmp cmp inSet is not allowed; use the inSet arm"
                ));
            }
            let raw = vo.get("value").unwrap_or(&Value::Null);
            let value = match parse_hole(raw)? {
                Some(name) => Param::Hole(name),
                None => Param::Lit(parse_primitive(raw, &format!("{what}.vcmp"))?),
            };
            if cmp == Cmp::Prefix
                && !matches!(value, Param::Lit(Primitive::Str(_)) | Param::Hole(_))
            {
                return Err(format!("{what}: prefix requires a string constant"));
            }
            Ok(ValMatch::Vcmp { cmp, value })
        }
        "between" => {
            let arr = o["between"]
                .as_array()
                .filter(|a| a.len() == 2)
                .ok_or_else(|| format!("{what}: between takes [lo, hi]"))?;
            Ok(ValMatch::Between {
                lo: parse_primitive(&arr[0], &format!("{what}.between"))?,
                hi: parse_primitive(&arr[1], &format!("{what}.between"))?,
            })
        }
        _ => {
            let arr = o["inSet"]
                .as_array()
                .ok_or_else(|| format!("{what}: inSet must be an array"))?;
            let values = arr
                .iter()
                .map(|x| parse_primitive(x, &format!("{what}.inSet")))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ValMatch::InSet(values))
        }
    }
}

fn parse_ppred(v: &Value) -> Result<PPred, String> {
    let o = as_object(
        v,
        "hasPointer",
        &[
            "role",
            "targetEntity",
            "targetDelta",
            "context",
            "targetIsPrimitive",
            "targetValue",
        ],
    )?;
    let mut out = PPred::default();
    let mut any = false;
    if let Some(r) = o.get("role") {
        out.role = Some(parse_str_match(r, "hasPointer.role")?);
        any = true;
    }
    if let Some(e) = o.get("targetEntity") {
        out.target_entity = Some(if let Some(s) = e.as_str() {
            EntityMatch::Const(nfc(s))
        } else if let Some(name) = parse_hole(e)? {
            EntityMatch::Hole(name)
        } else {
            let vo = as_object(e, "targetEntity", &["var"])?;
            if vo.get("var").and_then(Value::as_str) != Some("root") {
                return Err(
                    "targetEntity must be a string, {var: \"root\"}, or {hole: \"name\"}"
                        .to_string(),
                );
            }
            EntityMatch::Root
        });
        any = true;
    }
    if let Some(d) = o.get("targetDelta") {
        out.target_delta = Some(
            d.as_str()
                .ok_or("targetDelta must be a string")?
                .to_string(),
        );
        any = true;
    }
    if let Some(c) = o.get("context") {
        out.context = Some(parse_str_match(c, "hasPointer.context")?);
        any = true;
    }
    if let Some(b) = o.get("targetIsPrimitive") {
        out.target_is_primitive = Some(b.as_bool().ok_or("targetIsPrimitive must be a boolean")?);
        any = true;
    }
    if let Some(tv) = o.get("targetValue") {
        out.target_value = Some(parse_val_match(tv, "hasPointer.targetValue")?);
        any = true;
    }
    if !any {
        return Err("hasPointer requires at least one field (E1)".to_string());
    }
    Ok(out)
}

pub fn parse_pred(raw: &Value) -> Result<Pred, String> {
    if raw == "true" {
        return Ok(Pred::True);
    }
    if raw == "false" {
        return Ok(Pred::False);
    }
    let (o, tag) = one_tag(raw, &PRED_TAGS, "pred")?;
    match tag {
        "match" => {
            let mo = as_object(&o["match"], "match", &["field", "cmp", "const"])?;
            let field = match mo.get("field").and_then(Value::as_str) {
                Some("author") => Field::Author,
                Some("timestamp") => Field::Timestamp,
                Some("id") => Field::Id,
                other => return Err(format!("match: unknown field {other:?}")),
            };
            let cmp = parse_cmp(mo.get("cmp").unwrap_or(&Value::Null), "match")?;
            let raw_const = mo.get("const").unwrap_or(&Value::Null);
            let constant = if cmp == Cmp::InSet {
                let arr = raw_const
                    .as_array()
                    .ok_or("match: inSet requires an array const")?;
                MatchConst::Many(
                    arr.iter()
                        .map(|v| parse_primitive(v, "match.const"))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            } else if let Some(name) = parse_hole(raw_const)? {
                MatchConst::Hole(name)
            } else {
                let one = parse_primitive(raw_const, "match.const")?;
                if cmp == Cmp::Prefix && !matches!(one, Primitive::Str(_)) {
                    return Err("match: prefix requires a string const".to_string());
                }
                MatchConst::One(one)
            };
            Ok(Pred::Match {
                field,
                cmp,
                constant,
            })
        }
        "hasPointer" => Ok(Pred::HasPointer(parse_ppred(&o["hasPointer"])?)),
        "and" | "or" => {
            let arr = o[tag]
                .as_array()
                .filter(|a| a.len() == 2)
                .ok_or_else(|| format!("{tag} takes exactly [Pred, Pred] (E1)"))?;
            let left = Box::new(parse_pred(&arr[0])?);
            let right = Box::new(parse_pred(&arr[1])?);
            Ok(if tag == "and" {
                Pred::And(left, right)
            } else {
                Pred::Or(left, right)
            })
        }
        "not" => Ok(Pred::Not(Box::new(parse_pred(&o["not"])?))),
        _ => {
            let iv = as_object(&o["inView"], "inView", &["term", "field", "extract"])?;
            let term = parse_term(iv.get("term").unwrap_or(&Value::Null))?;
            if !matches!(
                term,
                Term::Input | Term::Select { .. } | Term::Union { .. } | Term::Mask { .. }
            ) {
                return Err(
                    "inView.term must be a DSet-sort term (input | select | union | mask)"
                        .to_string(),
                );
            }
            if term_contains_in_view(&term) {
                return Err(
                    "inView is stratified: no inView inside inView.term (SPEC-2 §3.1)".to_string(),
                );
            }
            let field = match iv.get("field").and_then(Value::as_str) {
                Some("author") => Field::Author,
                Some("id") => Field::Id,
                _ => return Err("inView.field must be author | id".to_string()),
            };
            Ok(Pred::InView {
                term: Box::new(term),
                field,
                extract: parse_extract(iv.get("extract").unwrap_or(&Value::Null))?,
            })
        }
    }
}

fn parse_extract(raw: &Value) -> Result<InViewExtract, String> {
    let (o, tag) = one_tag(raw, &EXTRACT_TAGS, "inView.extract")?;
    if tag == "field" {
        return match o["field"].as_str() {
            Some("author") => Ok(InViewExtract::Author),
            Some("id") => Ok(InViewExtract::Id),
            _ => Err("inView.extract.field must be author | id".to_string()),
        };
    }
    let r = o["role"]
        .as_str()
        .ok_or("inView.extract.role must be a string")?;
    Ok(InViewExtract::Role(nfc(r)))
}

fn parse_mask_policy(raw: &Value) -> Result<MaskPolicy, String> {
    if raw == "drop" {
        return Ok(MaskPolicy::Drop);
    }
    if raw == "annotate" {
        return Ok(MaskPolicy::Annotate);
    }
    let (o, _) = one_tag(raw, &["trust"], "mask.policy")?;
    Ok(MaskPolicy::Trust(parse_pred(&o["trust"])?))
}

fn parse_order(raw: &Value) -> Result<Order, String> {
    if raw == "lexById" {
        return Ok(Order::LexById);
    }
    let (o, tag) = one_tag(raw, &ORDER_TAGS, "order")?;
    match tag {
        "byTimestamp" => match o["byTimestamp"].as_str() {
            Some("desc") => Ok(Order::ByTimestamp { desc: true }),
            Some("asc") => Ok(Order::ByTimestamp { desc: false }),
            _ => Err("byTimestamp must be desc | asc".to_string()),
        },
        "byAuthorRank" => {
            let arr = o["byAuthorRank"]
                .as_array()
                .ok_or("byAuthorRank must be an array")?;
            let authors = arr
                .iter()
                .map(|a| {
                    a.as_str()
                        .map(nfc)
                        .ok_or("byAuthorRank entries must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Order::ByAuthorRank(authors))
        }
        "byPred" => {
            let po = as_object(&o["byPred"], "byPred", &["pred", "then"])?;
            let pred = parse_pred(po.get("pred").unwrap_or(&Value::Null))?;
            // Schema predicates are closed: they run inside resolve, after the mask already decided
            // standing — a reflective order would be a second, unlowered trust surface (SPEC-2 §3.1).
            if pred_contains_in_view(&pred) {
                return Err(
                    "inView is not allowed inside a policy byPred predicate (SPEC-2 §3.1)"
                        .to_string(),
                );
            }
            Ok(Order::ByPred {
                pred,
                then: Box::new(parse_order(po.get("then").unwrap_or(&Value::Null))?),
            })
        }
        _ => {
            let arr = o["chain"].as_array().ok_or("chain must be an array")?;
            if arr.is_empty() {
                return Err("chain must name at least one order".to_string());
            }
            let orders = arr.iter().map(parse_order).collect::<Result<Vec<_>, _>>()?;
            Ok(Order::Chain(orders))
        }
    }
}

fn parse_policy(raw: &Value) -> Result<Policy, String> {
    let (o, tag) = one_tag(raw, &POLICY_TAGS, "propPolicy")?;
    match tag {
        "pick" | "all" | "conflicts" => {
            let po = as_object(&o[tag], tag, &["order"])?;
            let order = parse_order(po.get("order").unwrap_or(&Value::Null))?;
            Ok(match tag {
                "pick" => Policy::Pick(order),
                "all" => Policy::All(order),
                _ => Policy::Conflicts(order),
            })
        }
        "merge" => {
            let fn_ = match o["merge"].as_str() {
                Some("max") => MergeFn::Max,
                Some("min") => MergeFn::Min,
                Some("sum") => MergeFn::Sum,
                Some("count") => MergeFn::Count,
                Some("and") => MergeFn::And,
                Some("or") => MergeFn::Or,
                Some("concatSorted") => MergeFn::ConcatSorted,
                other => return Err(format!("unknown merge fn {other:?}")),
            };
            Ok(Policy::Merge(fn_))
        }
        _ => {
            let ao = as_object(&o["absentAs"], "absentAs", &["const", "then"])?;
            Ok(Policy::AbsentAs {
                constant: parse_primitive(
                    ao.get("const").unwrap_or(&Value::Null),
                    "absentAs.const",
                )?,
                then: Box::new(parse_policy(ao.get("then").unwrap_or(&Value::Null))?),
            })
        }
    }
}

pub fn parse_schema(raw: &Value) -> Result<Schema, String> {
    let o = as_object(raw, "schema", &["props", "default", "name", "alg"])?;
    let mut props = std::collections::BTreeMap::new();
    if let Some(ps) = o.get("props") {
        // OPEN by design: the keys are the author's property names, not grammar (issue #25).
        for (k, v) in as_open_map(ps, "schema.props")? {
            props.insert(nfc(k), parse_policy(v)?);
        }
    }
    Ok(Schema {
        props,
        default: parse_policy(o.get("default").unwrap_or(&Value::Null))?,
        // Optional identity for a named/self-hosting Schema (SPEC-3 ERRATA S6); absent on inline
        // resolve-term schemas.
        name: o.get("name").and_then(|v| v.as_str()).map(nfc),
        alg: o.get("alg").and_then(|v| v.as_f64()),
    })
}

fn parse_group_key(raw: &Value) -> Result<GroupKey, String> {
    if raw == "byTargetContext" {
        return Ok(GroupKey::ByTargetContext);
    }
    if raw == "byRole" {
        return Ok(GroupKey::ByRole);
    }
    let (o, _) = one_tag(raw, &["const"], "group.key")?;
    let s = o["const"]
        .as_str()
        .ok_or("group.key const must be a string")?;
    Ok(GroupKey::Const(nfc(s)))
}

fn parse_schema_ref(raw: &Value) -> Result<SchemaRef, String> {
    if let Some(s) = raw.as_str() {
        return Ok(SchemaRef::Name(nfc(s)));
    }
    let (o, _) = one_tag(raw, &["pinned"], "schemaRef")?;
    let h = o["pinned"]
        .as_str()
        .ok_or("schema ref must be a name string or {pinned: hash} (E13)")?;
    Ok(SchemaRef::Pinned(h.to_string()))
}

pub fn parse_term(raw: &Value) -> Result<Term, String> {
    if raw == "input" {
        return Ok(Term::Input);
    }
    // Dispatched node: the `op` is checked first (the §8 tag rule), then the keys are checked
    // against exactly that operator's row of the closed grammar (issue #25).
    let (o, tag) = as_dispatched(raw, "term", "op", &TERM_KEYS)?;
    match tag {
        "select" => Ok(Term::Select {
            pred: parse_pred(o.get("pred").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        "union" => Ok(Term::Union {
            left: Box::new(parse_term(o.get("left").unwrap_or(&Value::Null))?),
            right: Box::new(parse_term(o.get("right").unwrap_or(&Value::Null))?),
        }),
        "intersect" => Ok(Term::Intersect {
            left: Box::new(parse_term(o.get("left").unwrap_or(&Value::Null))?),
            right: Box::new(parse_term(o.get("right").unwrap_or(&Value::Null))?),
        }),
        "difference" => Ok(Term::Difference {
            of: Box::new(parse_term(o.get("of").unwrap_or(&Value::Null))?),
            without: Box::new(parse_term(o.get("without").unwrap_or(&Value::Null))?),
        }),
        "mask" => Ok(Term::Mask {
            policy: parse_mask_policy(o.get("policy").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        "group" => Ok(Term::Group {
            key: parse_group_key(o.get("key").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        "expand" => Ok(Term::Expand {
            role: parse_str_match(o.get("role").unwrap_or(&Value::Null), "expand.role")?,
            schema: parse_schema_ref(o.get("schema").unwrap_or(&Value::Null))?,
            // `reading` is required in the current vocabulary (issue #23); legacy bodies without
            // it still parse and gather, but their expansions refuse to resolve (SPEC-5 §6).
            reading: match o.get("reading") {
                None => None,
                Some(r) => Some(parse_schema_ref(r)?),
            },
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        "fix" => {
            let entity = o
                .get("entity")
                .and_then(Value::as_str)
                .ok_or("fix.entity must be a string")?;
            let bindings = match o.get("bindings") {
                None => None,
                Some(b) => {
                    // OPEN by design: the keys are the author's hole names, not grammar (#25).
                    let bo = as_open_map(b, "fix.bindings")?;
                    let mut out = crate::pred::Bindings::new();
                    for (k, v) in bo {
                        out.insert(nfc(k), parse_primitive(v, &format!("fix.bindings.{k}"))?);
                    }
                    Some(out)
                }
            };
            Ok(Term::Fix {
                schema: parse_schema_ref(o.get("schema").unwrap_or(&Value::Null))?,
                entity: nfc(entity),
                bindings,
            })
        }
        "resolve" => Ok(Term::Resolve {
            schema: parse_schema(o.get("schema").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        "prune" => {
            let keep_raw = o.get("keep").unwrap_or(&Value::Null);
            let keep = if keep_raw == "all" {
                PruneKeep::All
            } else {
                PruneKeep::Match(parse_str_match(keep_raw, "prune.keep")?)
            };
            Ok(Term::Prune {
                keep,
                of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
            })
        }
        // as_dispatched already rejected every tag outside TERM_KEYS.
        other => Err(format!("unknown term op {other:?}")),
    }
}
