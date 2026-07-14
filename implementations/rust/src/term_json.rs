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
use crate::types::Primitive;

/// A hole in Const position: {"hole": "name"} (E15).
fn parse_hole(v: &Value) -> Option<String> {
    v.as_object()
        .and_then(|o| o.get("hole"))
        .and_then(Value::as_str)
        .map(nfc)
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
    let o = v
        .as_object()
        .ok_or_else(|| format!("{what}: expected object"))?;
    if let Some(s) = o.get("exact").and_then(Value::as_str) {
        return Ok(StrMatch::Exact(nfc(s)));
    }
    if let Some(s) = o.get("prefix").and_then(Value::as_str) {
        return Ok(StrMatch::Prefix(nfc(s)));
    }
    if let Some(arr) = o.get("inSet").and_then(Value::as_array) {
        let values = arr
            .iter()
            .map(|s| {
                s.as_str()
                    .map(nfc)
                    .ok_or_else(|| format!("{what}: inSet members must be strings"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(StrMatch::InSet(values));
    }
    if let Some(a) = o.get("aliased") {
        let ao = a
            .as_object()
            .ok_or_else(|| format!("{what}.aliased: expected object"))?;
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
        return Ok(StrMatch::Aliased(Box::new(AliasedMatch {
            name,
            via,
            trust,
        })));
    }
    Err(format!(
        "{what}: StrMatch must be exact | prefix | inSet | aliased"
    ))
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
    let o = v
        .as_object()
        .ok_or_else(|| format!("{what}: expected object"))?;
    if let Some(vc) = o.get("vcmp") {
        let vo = vc
            .as_object()
            .ok_or_else(|| format!("{what}.vcmp: expected object"))?;
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
        let value = match parse_hole(raw) {
            Some(name) => Param::Hole(name),
            None => Param::Lit(parse_primitive(raw, &format!("{what}.vcmp"))?),
        };
        if cmp == Cmp::Prefix && !matches!(value, Param::Lit(Primitive::Str(_)) | Param::Hole(_)) {
            return Err(format!("{what}: prefix requires a string constant"));
        }
        return Ok(ValMatch::Vcmp { cmp, value });
    }
    if let Some(arr) = o.get("between").and_then(Value::as_array) {
        if arr.len() != 2 {
            return Err(format!("{what}: between takes [lo, hi]"));
        }
        return Ok(ValMatch::Between {
            lo: parse_primitive(&arr[0], &format!("{what}.between"))?,
            hi: parse_primitive(&arr[1], &format!("{what}.between"))?,
        });
    }
    if let Some(arr) = o.get("inSet").and_then(Value::as_array) {
        let values = arr
            .iter()
            .map(|x| parse_primitive(x, &format!("{what}.inSet")))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(ValMatch::InSet(values));
    }
    Err(format!("{what}: ValMatch must be vcmp | between | inSet"))
}

fn parse_ppred(v: &Value) -> Result<PPred, String> {
    let o = v.as_object().ok_or("hasPointer: expected object")?;
    let mut out = PPred::default();
    let mut any = false;
    if let Some(r) = o.get("role") {
        out.role = Some(parse_str_match(r, "hasPointer.role")?);
        any = true;
    }
    if let Some(e) = o.get("targetEntity") {
        out.target_entity = Some(if let Some(s) = e.as_str() {
            EntityMatch::Const(nfc(s))
        } else if let Some(name) = parse_hole(e) {
            EntityMatch::Hole(name)
        } else if e.get("var").and_then(Value::as_str) == Some("root") {
            EntityMatch::Root
        } else {
            return Err(
                "targetEntity must be a string, {var: \"root\"}, or {hole: \"name\"}".to_string(),
            );
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
    let o = raw.as_object().ok_or("pred: expected object")?;
    if let Some(m) = o.get("match") {
        let mo = m.as_object().ok_or("match: expected object")?;
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
        } else if let Some(name) = parse_hole(raw_const) {
            MatchConst::Hole(name)
        } else {
            let one = parse_primitive(raw_const, "match.const")?;
            if cmp == Cmp::Prefix && !matches!(one, Primitive::Str(_)) {
                return Err("match: prefix requires a string const".to_string());
            }
            MatchConst::One(one)
        };
        return Ok(Pred::Match {
            field,
            cmp,
            constant,
        });
    }
    if let Some(hp) = o.get("hasPointer") {
        return Ok(Pred::HasPointer(parse_ppred(hp)?));
    }
    for (key, is_and) in [("and", true), ("or", false)] {
        if let Some(arr) = o.get(key) {
            let arr = arr
                .as_array()
                .filter(|a| a.len() == 2)
                .ok_or_else(|| format!("{key} takes exactly [Pred, Pred] (E1)"))?;
            let left = Box::new(parse_pred(&arr[0])?);
            let right = Box::new(parse_pred(&arr[1])?);
            return Ok(if is_and {
                Pred::And(left, right)
            } else {
                Pred::Or(left, right)
            });
        }
    }
    if let Some(n) = o.get("not") {
        return Ok(Pred::Not(Box::new(parse_pred(n)?)));
    }
    if let Some(v) = o.get("inView") {
        let iv = v.as_object().ok_or("inView: expected object")?;
        let term = parse_term(iv.get("term").unwrap_or(&Value::Null))?;
        if !matches!(
            term,
            Term::Input | Term::Select { .. } | Term::Union { .. } | Term::Mask { .. }
        ) {
            return Err(
                "inView.term must be a DSet-sort term (input | select | union | mask)".to_string(),
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
        return Ok(Pred::InView {
            term: Box::new(term),
            field,
            extract: parse_extract(iv.get("extract").unwrap_or(&Value::Null))?,
        });
    }
    Err("pred must be true | false | match | hasPointer | and | or | not | inView".to_string())
}

fn parse_extract(raw: &Value) -> Result<InViewExtract, String> {
    let o = raw.as_object().ok_or("inView.extract: expected object")?;
    if let Some(f) = o.get("field") {
        return match f.as_str() {
            Some("author") => Ok(InViewExtract::Author),
            Some("id") => Ok(InViewExtract::Id),
            _ => Err("inView.extract.field must be author | id".to_string()),
        };
    }
    if let Some(r) = o.get("role").and_then(Value::as_str) {
        return Ok(InViewExtract::Role(nfc(r)));
    }
    Err("inView.extract must be {field: author|id} | {role: string}".to_string())
}

fn parse_mask_policy(raw: &Value) -> Result<MaskPolicy, String> {
    if raw == "drop" {
        return Ok(MaskPolicy::Drop);
    }
    if raw == "annotate" {
        return Ok(MaskPolicy::Annotate);
    }
    if let Some(o) = raw.as_object() {
        if let Some(p) = o.get("trust") {
            return Ok(MaskPolicy::Trust(parse_pred(p)?));
        }
    }
    Err("mask policy must be drop | annotate | {trust: Pred}".to_string())
}

fn parse_order(raw: &Value) -> Result<Order, String> {
    if raw == "lexById" {
        return Ok(Order::LexById);
    }
    let o = raw.as_object().ok_or("order: expected object")?;
    if let Some(d) = o.get("byTimestamp") {
        return match d.as_str() {
            Some("desc") => Ok(Order::ByTimestamp { desc: true }),
            Some("asc") => Ok(Order::ByTimestamp { desc: false }),
            _ => Err("byTimestamp must be desc | asc".to_string()),
        };
    }
    if let Some(arr) = o.get("byAuthorRank").and_then(Value::as_array) {
        let authors = arr
            .iter()
            .map(|a| {
                a.as_str()
                    .map(nfc)
                    .ok_or("byAuthorRank entries must be strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Order::ByAuthorRank(authors));
    }
    if let Some(bp) = o.get("byPred") {
        let po = bp.as_object().ok_or("byPred: expected object")?;
        let pred = parse_pred(po.get("pred").unwrap_or(&Value::Null))?;
        // Schema predicates are closed: they run inside resolve, after the mask already decided
        // standing — a reflective order would be a second, unlowered trust surface (SPEC-2 §3.1).
        if pred_contains_in_view(&pred) {
            return Err(
                "inView is not allowed inside a policy byPred predicate (SPEC-2 §3.1)".to_string(),
            );
        }
        return Ok(Order::ByPred {
            pred,
            then: Box::new(parse_order(po.get("then").unwrap_or(&Value::Null))?),
        });
    }
    if let Some(arr) = o.get("chain").and_then(Value::as_array) {
        if arr.is_empty() {
            return Err("chain must name at least one order".to_string());
        }
        let orders = arr.iter().map(parse_order).collect::<Result<Vec<_>, _>>()?;
        return Ok(Order::Chain(orders));
    }
    Err("order must be lexById | byTimestamp | byAuthorRank | byPred | chain".to_string())
}

fn parse_policy(raw: &Value) -> Result<Policy, String> {
    let o = raw.as_object().ok_or("propPolicy: expected object")?;
    if let Some(p) = o.get("pick") {
        let po = p.as_object().ok_or("pick: expected object")?;
        return Ok(Policy::Pick(parse_order(
            po.get("order").unwrap_or(&Value::Null),
        )?));
    }
    if let Some(p) = o.get("all") {
        let po = p.as_object().ok_or("all: expected object")?;
        return Ok(Policy::All(parse_order(
            po.get("order").unwrap_or(&Value::Null),
        )?));
    }
    if let Some(m) = o.get("merge") {
        let fn_ = match m.as_str() {
            Some("max") => MergeFn::Max,
            Some("min") => MergeFn::Min,
            Some("sum") => MergeFn::Sum,
            Some("count") => MergeFn::Count,
            Some("and") => MergeFn::And,
            Some("or") => MergeFn::Or,
            Some("concatSorted") => MergeFn::ConcatSorted,
            other => return Err(format!("unknown merge fn {other:?}")),
        };
        return Ok(Policy::Merge(fn_));
    }
    if let Some(c) = o.get("conflicts") {
        let co = c.as_object().ok_or("conflicts: expected object")?;
        return Ok(Policy::Conflicts(parse_order(
            co.get("order").unwrap_or(&Value::Null),
        )?));
    }
    if let Some(a) = o.get("absentAs") {
        let ao = a.as_object().ok_or("absentAs: expected object")?;
        return Ok(Policy::AbsentAs {
            constant: parse_primitive(ao.get("const").unwrap_or(&Value::Null), "absentAs.const")?,
            then: Box::new(parse_policy(ao.get("then").unwrap_or(&Value::Null))?),
        });
    }
    Err("propPolicy must be pick | all | merge | conflicts | absentAs".to_string())
}

pub fn parse_schema(raw: &Value) -> Result<Schema, String> {
    let o = raw.as_object().ok_or("policy: expected object")?;
    let mut props = std::collections::BTreeMap::new();
    if let Some(ps) = o.get("props") {
        let po = ps.as_object().ok_or("policy.props: expected object")?;
        for (k, v) in po {
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
    if let Some(o) = raw.as_object() {
        if let Some(s) = o.get("const").and_then(Value::as_str) {
            return Ok(GroupKey::Const(nfc(s)));
        }
    }
    Err("group key must be byTargetContext | byRole | {const: string}".to_string())
}

fn parse_schema_ref(raw: &Value) -> Result<SchemaRef, String> {
    if let Some(s) = raw.as_str() {
        return Ok(SchemaRef::Name(nfc(s)));
    }
    if let Some(o) = raw.as_object() {
        if let Some(h) = o.get("pinned").and_then(Value::as_str) {
            return Ok(SchemaRef::Pinned(h.to_string()));
        }
    }
    Err("schema ref must be a name string or {pinned: hash} (E13)".to_string())
}

pub fn parse_term(raw: &Value) -> Result<Term, String> {
    if raw == "input" {
        return Ok(Term::Input);
    }
    let o = raw.as_object().ok_or("term: expected object")?;
    match o.get("op").and_then(Value::as_str) {
        Some("select") => Ok(Term::Select {
            pred: parse_pred(o.get("pred").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        Some("union") => Ok(Term::Union {
            left: Box::new(parse_term(o.get("left").unwrap_or(&Value::Null))?),
            right: Box::new(parse_term(o.get("right").unwrap_or(&Value::Null))?),
        }),
        Some("mask") => Ok(Term::Mask {
            policy: parse_mask_policy(o.get("policy").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        Some("group") => Ok(Term::Group {
            key: parse_group_key(o.get("key").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        Some("expand") => Ok(Term::Expand {
            role: parse_str_match(o.get("role").unwrap_or(&Value::Null), "expand.role")?,
            schema: parse_schema_ref(o.get("schema").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        Some("fix") => {
            let entity = o
                .get("entity")
                .and_then(Value::as_str)
                .ok_or("fix.entity must be a string")?;
            let bindings = match o.get("bindings") {
                None => None,
                Some(b) => {
                    let bo = b.as_object().ok_or("fix.bindings must be an object")?;
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
        Some("resolve") => Ok(Term::Resolve {
            schema: parse_schema(o.get("schema").unwrap_or(&Value::Null))?,
            of: Box::new(parse_term(o.get("in").unwrap_or(&Value::Null))?),
        }),
        Some("prune") => {
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
        other => Err(format!("unknown term op {other:?}")),
    }
}
