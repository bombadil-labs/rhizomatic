//! Parse the JSON term profile (ERRATA-2 E1) into Term/Pred. Mirrors ../ts/src/term-json.ts.
//! Strings are NFC-normalized at parse time.

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::eval::{MaskPolicy, Term};
use crate::pred::{Cmp, Field, MatchConst, PPred, Pred, StrMatch, ValMatch};
use crate::types::Primitive;

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
    Err(format!("{what}: StrMatch must be exact | prefix | inSet"))
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
        let value = parse_primitive(
            vo.get("value").unwrap_or(&Value::Null),
            &format!("{what}.vcmp"),
        )?;
        if cmp == Cmp::Prefix && !matches!(value, Primitive::Str(_)) {
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
        out.target_entity = Some(nfc(e.as_str().ok_or("targetEntity must be a string")?));
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
    Err("pred must be true | false | match | hasPointer | and | or | not".to_string())
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
        other => Err(format!("unknown term op {other:?}")),
    }
}
