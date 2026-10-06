//! SPEC-16 MR-04/08: closed delta-only release-A grammar; parsing grants no capability.
use crate::cbor::{decode, encode, CborValue};
use crate::command_data::{is_author, is_content_id, read_bindings};
use crate::delta::canonical_bytes;
use crate::types::{Claims, Delta, Pointer, Primitive, Target, VOCAB_PREFIX};
use std::collections::{BTreeMap, BTreeSet};

pub type MaterializationFields = BTreeMap<String, Vec<Target>>;
pub type MaterializationLimits = BTreeMap<String, usize>;
const ERROR: &str = "invalid materialization description";
const COMMON: &[&str] = &["kind", "receiver", "configuration", "operation"];
const GATHER: &[&str] = &[
    "capture",
    "snapshot",
    "root",
    "at",
    "serving-at",
    "interpretation",
    "hyperschema",
    "hyperschema-pin",
    "schema",
    "schema-pin",
    "bindings",
    "definition-at",
    "definition",
    "historical-cutoff",
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationVerb {
    Gather,
    Resolve,
}
impl MaterializationVerb {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gather => "gather",
            Self::Resolve => "resolve",
        }
    }
}
pub fn materialization_role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.materialization.{suffix}")
}
pub fn materialization_max_limits() -> MaterializationLimits {
    [
        ("artifactBytes", 16777216),
        ("deliveryAppearances", 8192),
        ("deliveryBytes", 33554432),
        ("appearances", 4096),
        ("entries", 16384),
        ("nodes", 4096),
        ("depth", 32),
        ("pointers", 256),
        ("buckets", 256),
        ("readings", 256),
        ("definitions", 256),
        ("syntaxDepth", 64),
        ("syntaxNodes", 16384),
        ("roots", 64),
        ("registrations", 64),
        ("components", 64),
        ("inventoryIds", 16384),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect()
}
fn require(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}
fn order(kind: &str) -> Result<Vec<&'static str>, String> {
    Ok(match kind {
        "endpoint/1" => vec![
            "kind",
            "receiver",
            "caller",
            "administrator",
            "installed",
            "source-binding",
            "limits",
        ],
        "operation/1" => vec![
            "kind",
            "name",
            "interpreter",
            "input-contract",
            "output-contract",
            "effect",
            "replay",
            "dependencies",
        ],
        "request/1" => [COMMON, GATHER, &["evidence"]].concat(),
        "source-binding/1" => vec!["kind", "receiver", "spec"],
        "authority/1" => vec!["kind", "source-binding", "spec"],
        "capture/1" => vec!["kind", "source-binding", "authority", "basis"],
        "snapshot/1" => vec!["kind", "data"],
        "evidence/1" => vec!["kind", "result"],
        "outcome/1" => vec![
            "kind",
            "receiver",
            "configuration",
            "request",
            "status",
            "result",
        ],
        _ => return Err(ERROR.into()),
    })
}
pub fn materialization_fields(d: &Delta) -> Result<MaterializationFields, String> {
    let mut out: MaterializationFields = BTreeMap::new();
    for p in &d.claims.pointers {
        let key = p
            .role
            .strip_prefix(&materialization_role(""))
            .ok_or(ERROR)?;
        out.entry(key.into()).or_default().push(p.target.clone());
    }
    Ok(out)
}
fn one<'a>(f: &'a MaterializationFields, k: &str) -> Result<&'a Target, String> {
    let ts = f.get(k).ok_or(ERROR)?;
    require(ts.len() == 1)?;
    Ok(&ts[0])
}
pub fn materialization_text(f: &MaterializationFields, k: &str) -> Result<String, String> {
    match one(f, k)? {
        Target::Primitive(Primitive::Str(s)) => Ok(s.clone()),
        _ => Err(ERROR.into()),
    }
}
pub fn materialization_number(f: &MaterializationFields, k: &str) -> Result<f64, String> {
    match one(f, k)? {
        Target::Primitive(Primitive::Num(n)) if n.is_finite() => Ok(*n),
        _ => Err(ERROR.into()),
    }
}
pub fn materialization_entity(f: &MaterializationFields, k: &str) -> Result<String, String> {
    match one(f, k)? {
        Target::Entity(e) if e.context.is_none() => Ok(e.id.clone()),
        _ => Err(ERROR.into()),
    }
}
pub fn materialization_ref(f: &MaterializationFields, k: &str) -> Result<String, String> {
    match one(f, k)? {
        Target::Delta(e) if e.context.is_none() && is_content_id(&e.delta) => Ok(e.delta.clone()),
        _ => Err(ERROR.into()),
    }
}
pub fn materialization_bytes(f: &MaterializationFields, k: &str) -> Result<Vec<u8>, String> {
    match one(f, k)? {
        Target::Bytes { mime, value } if mime == "application/cbor" => Ok(value.clone()),
        _ => Err(ERROR.into()),
    }
}
fn shape(
    f: &MaterializationFields,
    allowed: &[&str],
    optional: &[&str],
    sets: &[&str],
) -> Result<(), String> {
    require(f.keys().all(|k| allowed.contains(&k.as_str())))?;
    for k in allowed {
        let ts = f.get(*k).map(Vec::as_slice).unwrap_or(&[]);
        if sets.contains(k) {
            let mut unique = BTreeSet::new();
            for t in ts {
                let key = match t {
                    Target::Delta(r) => r.delta.clone(),
                    Target::Primitive(Primitive::Str(s)) => s.clone(),
                    _ => return Err(ERROR.into()),
                };
                require(unique.insert(key))?;
            }
        } else {
            require(if optional.contains(k) {
                ts.len() <= 1
            } else {
                ts.len() == 1
            })?;
        }
    }
    Ok(())
}
fn unique(v: &CborValue) -> Result<(), String> {
    match v {
        CborValue::Map(fs) => {
            let mut keys = BTreeSet::new();
            for (k, x) in fs {
                require(keys.insert(k))?;
                unique(x)?;
            }
        }
        CborValue::Array(xs) => {
            for x in xs {
                unique(x)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn read_materialization_limits(bytes: &[u8]) -> Result<MaterializationLimits, String> {
    let v = decode(bytes)?;
    unique(&v)?;
    require(encode(&v) == bytes)?;
    let CborValue::Map(fs) = v else {
        return Err(ERROR.into());
    };
    let maxima = materialization_max_limits();
    require(fs.len() == maxima.len())?;
    let mut out = BTreeMap::new();
    for (k, x) in fs {
        let CborValue::Float(n) = x else {
            return Err(ERROR.into());
        };
        let max = maxima.get(&k).ok_or(ERROR)?;
        require(n.is_finite() && n >= 1.0 && n.fract() == 0.0 && n <= *max as f64)?;
        out.insert(k, n as usize);
    }
    Ok(out)
}
pub fn encode_materialization_limits(limits: &MaterializationLimits) -> Result<Vec<u8>, String> {
    let bytes = encode(&CborValue::Map(
        limits
            .iter()
            .map(|(k, v)| (k.clone(), CborValue::Float(*v as f64)))
            .collect(),
    ));
    read_materialization_limits(&bytes)?;
    Ok(bytes)
}
/// None validates only common request fields at MR-21 stage 2.
pub fn read_materialization_description(
    d: &Delta,
    verb: Option<MaterializationVerb>,
) -> Result<MaterializationFields, String> {
    let f = materialization_fields(d)?;
    let kind = materialization_text(&f, "kind")?;
    let allowed = order(&kind)?;
    if kind == "request/1" {
        for k in COMMON {
            one(&f, k)?;
        }
        require(is_author(&materialization_entity(&f, "receiver")?))?;
        materialization_ref(&f, "configuration")?;
        materialization_ref(&f, "operation")?;
        let Some(verb) = verb else { return Ok(f) };
        shape(
            &f,
            &[
                COMMON,
                if verb == MaterializationVerb::Gather {
                    GATHER
                } else {
                    &["evidence"]
                },
            ]
            .concat(),
            if verb == MaterializationVerb::Gather {
                &["historical-cutoff"]
            } else {
                &[]
            },
            if verb == MaterializationVerb::Gather {
                &["definition"]
            } else {
                &[]
            },
        )?;
        if verb == MaterializationVerb::Resolve {
            materialization_ref(&f, "evidence")?;
            return Ok(f);
        }
        for k in ["capture", "snapshot", "hyperschema", "schema"] {
            materialization_ref(&f, k)?;
        }
        for k in ["hyperschema-pin", "schema-pin"] {
            require(is_content_id(&materialization_text(&f, k)?))?;
        }
        require(
            !materialization_entity(&f, "root")?.is_empty()
                && materialization_text(&f, "interpretation")? == "core/1",
        )?;
        for k in ["at", "serving-at", "definition-at"] {
            materialization_number(&f, k)?;
        }
        if f.contains_key("historical-cutoff") {
            require(
                materialization_number(&f, "at")?
                    == materialization_number(&f, "historical-cutoff")?,
            )?;
        }
        let mut ids = BTreeSet::from([
            materialization_ref(&f, "hyperschema")?,
            materialization_ref(&f, "schema")?,
        ]);
        require(ids.len() == 2)?;
        for t in f.get("definition").into_iter().flatten() {
            let single = BTreeMap::from([("x".into(), vec![t.clone()])]);
            require(ids.insert(materialization_ref(&single, "x")?))?;
        }
        read_bindings(&materialization_bytes(&f, "bindings")?)?;
        return Ok(f);
    }
    shape(
        &f,
        &allowed,
        &[],
        if kind == "endpoint/1" {
            &["caller", "administrator", "installed", "source-binding"]
        } else {
            &[]
        },
    )?;
    if ["endpoint/1", "source-binding/1", "outcome/1"].contains(&kind.as_str()) {
        require(is_author(&materialization_entity(&f, "receiver")?))?;
    }
    if kind == "endpoint/1" {
        let keys = |k: &str| -> Result<Vec<String>, String> {
            f.get(k)
                .into_iter()
                .flatten()
                .map(|t| match t {
                    Target::Primitive(Primitive::Str(s)) if is_author(s) => Ok(s.clone()),
                    _ => Err(ERROR.into()),
                })
                .collect()
        };
        let callers = keys("caller")?;
        let admins = keys("administrator")?;
        require(
            !callers.is_empty()
                && !admins.is_empty()
                && admins.iter().all(|a| callers.contains(a))
                && f.get("installed").is_some_and(|ts| ts.len() == 2),
        )?;
        for k in ["installed", "source-binding"] {
            for t in f.get(k).into_iter().flatten() {
                materialization_ref(&BTreeMap::from([("x".into(), vec![t.clone()])]), "x")?;
            }
        }
        read_materialization_limits(&materialization_bytes(&f, "limits")?)?;
    }
    if kind == "operation/1" {
        let name = materialization_entity(&f, "name")?;
        let verb = if name == materialization_role("gather") {
            "gather"
        } else if name == materialization_role("resolve") {
            "resolve"
        } else {
            return Err(ERROR.into());
        };
        for (k, v) in [
            ("interpreter", materialization_role(&format!("{verb}/1"))),
            ("input-contract", materialization_role(&format!("{verb}/1"))),
            ("output-contract", materialization_role("outcome/1")),
            ("effect", "none".into()),
            ("replay", "re-evaluate/1".into()),
            ("dependencies", "explicit-support/1".into()),
        ] {
            require(materialization_text(&f, k)? == v)?;
        }
    }
    if ["authority/1", "capture/1"].contains(&kind.as_str()) {
        materialization_ref(&f, "source-binding")?;
    }
    if kind == "capture/1" {
        materialization_ref(&f, "authority")?;
    }
    for k in ["spec", "basis", "data", "result"] {
        if f.contains_key(k) {
            materialization_bytes(&f, k)?;
        }
    }
    if kind == "outcome/1" {
        materialization_ref(&f, "configuration")?;
        materialization_ref(&f, "request")?;
        require(
            d.claims.author == materialization_entity(&f, "receiver")?
                && d.claims.timestamp == d.claims.valid_from
                && d.claims.valid_until.is_none()
                && ["completed", "refused", "indeterminate"]
                    .contains(&materialization_text(&f, "status")?.as_str()),
        )?;
    }
    Ok(f)
}
pub fn materialization_description_claims(
    author: &str,
    at: f64,
    kind: &str,
    fields: &MaterializationFields,
) -> Result<Claims, String> {
    require(is_author(author))?;
    let mut fs = fields.clone();
    fs.insert(
        "kind".into(),
        vec![Target::Primitive(Primitive::Str(kind.into()))],
    );
    let allowed = order(kind)?;
    require(fs.keys().all(|k| allowed.contains(&k.as_str())))?;
    let mut pointers = Vec::new();
    for k in allowed {
        let mut ts = fs.remove(k).unwrap_or_default();
        if [
            "caller",
            "administrator",
            "installed",
            "source-binding",
            "definition",
        ]
        .contains(&k)
        {
            let key = |t: &Target| -> Result<String, String> {
                match t {
                    Target::Delta(r) => Ok(r.delta.clone()),
                    Target::Primitive(Primitive::Str(s)) => Ok(s.clone()),
                    _ => Err(ERROR.into()),
                }
            };
            let mut keyed = ts
                .into_iter()
                .map(|t| Ok((key(&t)?, t)))
                .collect::<Result<Vec<_>, String>>()?;
            keyed.sort_by(|a, b| a.0.cmp(&b.0));
            ts = keyed.into_iter().map(|(_, t)| t).collect();
        }
        pointers.extend(ts.into_iter().map(|target| Pointer {
            role: materialization_role(k),
            target,
        }));
    }
    let claims = Claims {
        author: author.into(),
        timestamp: at,
        valid_from: at,
        valid_until: None,
        pointers,
    };
    canonical_bytes(&claims)?;
    Ok(claims)
}
