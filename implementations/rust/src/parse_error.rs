//! Stable diagnostics for the JSON Term and Pred authoring profile (SPEC-2 §8).
//! Parsing still uses `term_json`; this module diagnoses its rejected input without
//! interpreting the human-readable error text.

use serde_json::{Map, Value};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseErrorKind {
    UnknownOp,
    UnknownKey,
    InvalidShape,
}

impl ParseErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownOp => "unknown-op",
            Self::UnknownKey => "unknown-key",
            Self::InvalidShape => "invalid-shape",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseError {
    pub kind: ParseErrorKind,
    /// RFC 6901 JSON Pointer; the empty string names the root.
    pub path: String,
    pub field: Option<String>,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}

impl std::error::Error for ParseError {}

fn segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn at(path: &str, key: &str) -> String {
    format!("{path}/{}", segment(key))
}

fn fault(kind: ParseErrorKind, path: String, field: Option<&str>) -> ParseError {
    ParseError {
        kind,
        path,
        field: field.map(str::to_owned),
        message: String::new(),
    }
}

fn unknown_key(o: &Map<String, Value>, path: &str, known: &[&str]) -> Option<ParseError> {
    o.keys()
        .find(|key| !known.contains(&key.as_str()))
        .map(|key| fault(ParseErrorKind::UnknownKey, at(path, key), Some(key)))
}

pub(crate) fn diagnose_term(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    let op = match o.get("op").and_then(Value::as_str) {
        Some(op) => op,
        None => return Some(fault(ParseErrorKind::UnknownOp, at(path, "op"), Some("op"))),
    };
    let known = match crate::term_json::TERM_KEYS.iter().find(|(name, _)| *name == op) {
        Some((_, keys)) => *keys,
        None => return Some(fault(ParseErrorKind::UnknownOp, at(path, "op"), Some("op"))),
    };
    if let Some(err) = unknown_key(o, path, known) {
        return Some(err);
    }
    match op {
        "select" => {
            if let Some(pred) = o.get("pred") {
                if let Some(err) = diagnose_pred(pred, &at(path, "pred")) {
                    return Some(err);
                }
            }
        }
        "resolve" => {
            if let Some(schema) = o.get("schema") {
                if let Some(err) = diagnose_schema(schema, &at(path, "schema")) {
                    return Some(err);
                }
            }
        }
        "mask" => {
            if let Some(policy) = o.get("policy") {
                if let Some(err) = diagnose_mask(policy, &at(path, "policy")) {
                    return Some(err);
                }
            }
        }
        "group" => {
            if let Some(key) = o.get("key") {
                if let Some(err) = diagnose_tag(key, &at(path, "key"), &["const"]) {
                    return Some(err);
                }
            }
        }
        "expand" => {
            if let Some(role) = o.get("role") {
                if let Some(err) = diagnose_match(role, &at(path, "role"), &["exact", "prefix", "inSet", "aliased"]) {
                    return Some(err);
                }
            }
            for key in ["schema", "reading"] {
                if let Some(value) = o.get(key) {
                    if let Some(err) = diagnose_tag(value, &at(path, key), &["pinned"]) {
                        return Some(err);
                    }
                }
            }
        }
        "fix" => {
            if let Some(value) = o.get("schema") {
                if let Some(err) = diagnose_tag(value, &at(path, "schema"), &["pinned"]) {
                    return Some(err);
                }
            }
        }
        "prune" => {
            if let Some(value) = o.get("keep") {
                if let Some(err) = diagnose_match(value, &at(path, "keep"), &["exact", "prefix", "inSet", "aliased"]) {
                    return Some(err);
                }
            }
        }
        _ => {}
    }
    for child in ["in", "left", "right", "of", "without"] {
        if let Some(value) = o.get(child) {
            if let Some(err) = diagnose_term(value, &at(path, child)) {
                return Some(err);
            }
        }
    }
    None
}

pub(crate) fn diagnose_pred(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    const TAGS: &[&str] = &["match", "hasPointer", "and", "or", "not", "inView"];
    if let Some(err) = unknown_key(o, path, TAGS) {
        return Some(err);
    }
    if let Some(m) = o.get("match").and_then(Value::as_object) {
        let mpath = at(path, "match");
        if let Some(err) = unknown_key(m, &mpath, &["field", "cmp", "const"]) {
            return Some(err);
        }
        if let Some(value) = m.get("const") {
            return diagnose_hole(value, &at(&mpath, "const"));
        }
    }
    if let Some(p) = o.get("hasPointer").and_then(Value::as_object) {
        let ppath = at(path, "hasPointer");
        if let Some(err) = unknown_key(
            p,
            &ppath,
            &["role", "targetEntity", "targetDelta", "context", "targetIsPrimitive", "targetValue"],
        ) {
            return Some(err);
        }
        for child in ["role", "context"] {
            if let Some(value) = p.get(child) {
                if let Some(err) = diagnose_match(value, &at(&ppath, child), &["exact", "prefix", "inSet", "aliased"]) {
                    return Some(err);
                }
            }
        }
        if let Some(value) = p.get("targetEntity") {
            if let Some(err) = diagnose_hole(value, &at(&ppath, "targetEntity")) {
                return Some(err);
            }
            if !value.as_object().is_some_and(|o| o.contains_key("hole")) {
                if let Some(err) = diagnose_tag(value, &at(&ppath, "targetEntity"), &["var"]) {
                    return Some(err);
                }
            }
        }
        if let Some(value) = p.get("targetValue") {
            return diagnose_match(value, &at(&ppath, "targetValue"), &["vcmp", "between", "inSet"]);
        }
    }
    for tag in ["and", "or"] {
        if let Some(arr) = o.get(tag).and_then(Value::as_array) {
            for (i, value) in arr.iter().enumerate() {
                if let Some(err) = diagnose_pred(value, &format!("{}/{i}", at(path, tag))) {
                    return Some(err);
                }
            }
        }
    }
    if let Some(value) = o.get("not") {
        return diagnose_pred(value, &at(path, "not"));
    }
    if let Some(iv) = o.get("inView").and_then(Value::as_object) {
        let ivpath = at(path, "inView");
        if let Some(err) = unknown_key(iv, &ivpath, &["term", "field", "extract"]) {
            return Some(err);
        }
        if let Some(value) = iv.get("term") {
            if let Some(err) = diagnose_term(value, &at(&ivpath, "term")) {
                return Some(err);
            }
        }
        if let Some(value) = iv.get("extract") {
            return diagnose_tag(value, &at(&ivpath, "extract"), &["field", "role"]);
        }
    }
    None
}

fn diagnose_match(raw: &Value, path: &str, tags: &[&str]) -> Option<ParseError> {
    let o = raw.as_object()?;
    if let Some(err) = unknown_key(o, path, tags) {
        return Some(err);
    }
    if let Some(value) = o.get("aliased").and_then(Value::as_object) {
        let p = at(path, "aliased");
        if let Some(err) = unknown_key(value, &p, &["name", "via", "trust"]) {
            return Some(err);
        }
        if let Some(trust) = value.get("trust") {
            return diagnose_pred(trust, &at(&p, "trust"));
        }
    }
    if let Some(value) = o.get("vcmp").and_then(Value::as_object) {
        let vpath = at(path, "vcmp");
        if let Some(err) = unknown_key(value, &vpath, &["cmp", "value"]) {
            return Some(err);
        }
        if let Some(value) = value.get("value") {
            return diagnose_hole(value, &at(&vpath, "value"));
        }
    }
    None
}

fn diagnose_schema(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    if let Some(err) = unknown_key(o, path, &["props", "default", "name", "alg"]) {
        return Some(err);
    }
    if let Some(props) = o.get("props").and_then(Value::as_object) {
        for (key, value) in props {
            if let Some(err) = diagnose_policy(value, &at(&at(path, "props"), key)) {
                return Some(err);
            }
        }
    }
    if let Some(value) = o.get("default") {
        return diagnose_policy(value, &at(path, "default"));
    }
    None
}

fn diagnose_tag(raw: &Value, path: &str, tags: &[&str]) -> Option<ParseError> {
    raw.as_object().and_then(|o| unknown_key(o, path, tags))
}

fn diagnose_hole(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    if o.contains_key("hole") {
        return unknown_key(o, path, &["hole"]);
    }
    None
}

fn diagnose_mask(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    if let Some(err) = unknown_key(o, path, &["trust"]) {
        return Some(err);
    }
    o.get("trust").and_then(|v| diagnose_pred(v, &at(path, "trust")))
}

fn diagnose_policy(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    if let Some(err) = unknown_key(o, path, &["pick", "all", "merge", "conflicts", "absentAs"]) {
        return Some(err);
    }
    for (tag, keys) in [
        ("pick", &["order"][..]),
        ("all", &["order", "distinct"][..]),
        ("conflicts", &["order"][..]),
        ("absentAs", &["const", "then"][..]),
    ] {
        if let Some(value) = o.get(tag).and_then(Value::as_object) {
            let p = at(path, tag);
            if let Some(err) = unknown_key(value, &p, keys) {
                return Some(err);
            }
            if let Some(order) = value.get("order") {
                if let Some(err) = diagnose_order(order, &at(&p, "order")) {
                    return Some(err);
                }
            }
            if let Some(next) = value.get("then") {
                return diagnose_policy(next, &at(&p, "then"));
            }
        }
    }
    None
}

fn diagnose_order(raw: &Value, path: &str) -> Option<ParseError> {
    let o = raw.as_object()?;
    if let Some(err) = unknown_key(o, path, &["byTimestamp", "byAuthorRank", "byPred", "chain"]) {
        return Some(err);
    }
    if let Some(bp) = o.get("byPred").and_then(Value::as_object) {
        let p = at(path, "byPred");
        if let Some(err) = unknown_key(bp, &p, &["pred", "then"]) {
            return Some(err);
        }
        if let Some(value) = bp.get("pred") {
            if let Some(err) = diagnose_pred(value, &at(&p, "pred")) {
                return Some(err);
            }
        }
        if let Some(value) = bp.get("then") {
            return diagnose_order(value, &at(&p, "then"));
        }
    }
    if let Some(chain) = o.get("chain").and_then(Value::as_array) {
        for (i, value) in chain.iter().enumerate() {
            if let Some(err) = diagnose_order(value, &format!("{}/{i}", at(path, "chain"))) {
                return Some(err);
            }
        }
    }
    None
}

pub(crate) fn finish(mut diagnosis: ParseError, message: String) -> ParseError {
    diagnosis.message = message;
    diagnosis
}

pub(crate) fn invalid(message: String) -> ParseError {
    finish(fault(ParseErrorKind::InvalidShape, String::new(), None), message)
}
