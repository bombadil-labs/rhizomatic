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
const LIFECYCLE: &[&str] = &["expected-control", "registration", "expected-source"];
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MaterializationVerb {
    Gather,
    Resolve,
    Install,
    ReplaceSource,
    AdvanceTime,
    Retire,
    Read,
    Restore,
}
impl MaterializationVerb {
    pub const ALL: [MaterializationVerb; 8] = [
        Self::Gather,
        Self::Resolve,
        Self::Install,
        Self::ReplaceSource,
        Self::AdvanceTime,
        Self::Retire,
        Self::Read,
        Self::Restore,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gather => "gather",
            Self::Resolve => "resolve",
            Self::Install => "install",
            Self::ReplaceSource => "replace-source",
            Self::AdvanceTime => "advance-time",
            Self::Retire => "retire",
            Self::Read => "read",
            Self::Restore => "restore",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|v| v.as_str() == s)
    }
    /// MR-08: install, replace-source, advance-time and retire change control state.
    pub fn effect(self) -> &'static str {
        match self {
            Self::Install | Self::ReplaceSource | Self::AdvanceTime | Self::Retire => "control",
            _ => "none",
        }
    }
    /// Verb-specific request roles after the common fields (MR-08 table).
    fn roles(self) -> &'static [&'static str] {
        match self {
            Self::Gather => GATHER,
            Self::Resolve => &["evidence"],
            Self::Install => &[
                "expected-control",
                "registration",
                "capture",
                "snapshot",
                "at",
                "serving-at",
            ],
            Self::ReplaceSource => &[
                "expected-control",
                "registration",
                "expected-source",
                "capture",
                "snapshot",
                "serving-at",
            ],
            Self::AdvanceTime => &[
                "expected-control",
                "registration",
                "expected-source",
                "snapshot",
                "at",
                "serving-at",
            ],
            Self::Retire => &["expected-control", "registration"],
            Self::Read => &[
                "expected-control",
                "registration",
                "expected-source",
                "snapshot",
                "serving-at",
            ],
            Self::Restore => &["expected-control"],
        }
    }
}
/// Release A installs the first two verbs; release B installs all eight (MR-08).
pub fn materialization_release_verbs(release: char) -> &'static [MaterializationVerb] {
    match release {
        'A' => &MaterializationVerb::ALL[..2],
        _ => &MaterializationVerb::ALL,
    }
}
pub fn materialization_operation_verb(name: &str) -> Result<MaterializationVerb, String> {
    name.strip_prefix(&materialization_role(""))
        .and_then(MaterializationVerb::parse)
        .ok_or_else(|| ERROR.into())
}
pub const STATE_VERBS: &[&str] = &["install", "replace-source", "advance-time", "retire"];
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
        "request/1" => [COMMON, LIFECYCLE, GATHER, &["evidence"]].concat(),
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
        "registration/1" => vec![
            "kind",
            "source-binding",
            "hyperschema",
            "hyperschema-pin",
            "schema",
            "schema-pin",
            "definition",
            "roots",
            "bindings",
            "definition-at",
            "interpretation",
            "result-kind",
            "time-policy",
            "alias",
        ],
        "state/1" => vec![
            "kind",
            "registration",
            "generation",
            "prior-control",
            "prior-transition",
            "verb",
            "source-revision",
            "authority",
            "at",
            "definition-at",
            "hyperschema-pin",
            "schema-pin",
            "capture",
        ],
        "control-image/1" => vec!["kind", "data"],
        _ => return Err(ERROR.into()),
    })
}
/// Readers accept pointer permutations: set-valued roles read in their canonical sorted order.
pub fn materialization_fields(d: &Delta) -> Result<MaterializationFields, String> {
    let mut out: MaterializationFields = BTreeMap::new();
    for p in &d.claims.pointers {
        let key = p
            .role
            .strip_prefix(&materialization_role(""))
            .ok_or(ERROR)?;
        out.entry(key.into()).or_default().push(p.target.clone());
    }
    for k in SETS {
        if let Some(ts) = out.get_mut(*k) {
            if ts.len() > 1 {
                let mut keyed = ts
                    .iter()
                    .map(|t| set_key(t).map(|k| (k, t.clone())))
                    .collect::<Result<Vec<_>, _>>()?;
                keyed.sort_by(|a, b| a.0.cmp(&b.0));
                *ts = keyed.into_iter().map(|(_, t)| t).collect();
            }
        }
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
                require(unique.insert(set_key(t)?))?;
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
const SETS: &[&str] = &[
    "caller",
    "administrator",
    "installed",
    "source-binding",
    "definition",
    "roots",
    "alias",
];
fn set_key(t: &Target) -> Result<String, String> {
    match t {
        Target::Delta(r) => Ok(r.delta.clone()),
        Target::Primitive(Primitive::Str(s)) => Ok(s.clone()),
        Target::Entity(e) if e.context.is_none() => Ok(e.id.clone()),
        _ => Err(ERROR.into()),
    }
}
fn sorted_distinct_nonempty(f: &MaterializationFields, k: &str) -> Result<Vec<String>, String> {
    let keys = f
        .get(k)
        .into_iter()
        .flatten()
        .map(set_key)
        .collect::<Result<Vec<_>, _>>()?;
    require(keys.iter().all(|s| !s.is_empty()) && keys.windows(2).all(|w| w[0] < w[1]))?;
    Ok(keys)
}
fn is_n(n: f64) -> bool {
    n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9007199254740991.0
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
            &[COMMON, verb.roles()].concat(),
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
        if verb != MaterializationVerb::Gather {
            let control = materialization_text(&f, "expected-control")?;
            require(control.is_empty() || is_content_id(&control))?;
            for k in verb.roles() {
                match *k {
                    "registration" | "capture" | "snapshot" => {
                        materialization_ref(&f, k)?;
                    }
                    "expected-source" => {
                        require(is_content_id(&materialization_text(&f, k)?))?;
                    }
                    "at" | "serving-at" => {
                        materialization_number(&f, k)?;
                    }
                    _ => {}
                }
            }
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
        if kind == "state/1" { &["capture"] } else { &[] },
        if kind == "endpoint/1" {
            &["caller", "administrator", "installed", "source-binding"]
        } else if kind == "registration/1" {
            &["definition", "roots", "alias"]
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
                && f.get("installed")
                    .is_some_and(|ts| ts.len() == 2 || ts.len() == 8),
        )?;
        for k in ["installed", "source-binding"] {
            for t in f.get(k).into_iter().flatten() {
                materialization_ref(&BTreeMap::from([("x".into(), vec![t.clone()])]), "x")?;
            }
        }
        read_materialization_limits(&materialization_bytes(&f, "limits")?)?;
    }
    if kind == "operation/1" {
        let verb = materialization_operation_verb(&materialization_entity(&f, "name")?)?;
        let name = verb.as_str();
        for (k, v) in [
            ("interpreter", materialization_role(&format!("{name}/1"))),
            ("input-contract", materialization_role(&format!("{name}/1"))),
            ("output-contract", materialization_role("outcome/1")),
            ("effect", verb.effect().into()),
            ("replay", "re-evaluate/1".into()),
            ("dependencies", "explicit-support/1".into()),
        ] {
            require(materialization_text(&f, k)? == v)?;
        }
    }
    if kind == "registration/1" {
        for k in ["source-binding", "hyperschema", "schema"] {
            materialization_ref(&f, k)?;
        }
        for k in ["hyperschema-pin", "schema-pin"] {
            require(is_content_id(&materialization_text(&f, k)?))?;
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
        require(!sorted_distinct_nonempty(&f, "roots")?.is_empty())?;
        sorted_distinct_nonempty(&f, "alias")?;
        read_bindings(&materialization_bytes(&f, "bindings")?)?;
        materialization_number(&f, "definition-at")?;
        require(
            materialization_text(&f, "interpretation")? == "core/1"
                && materialization_text(&f, "result-kind")? == "hview-and-view/1"
                && materialization_text(&f, "time-policy")? == "live-time/1",
        )?;
    }
    if kind == "state/1" {
        materialization_ref(&f, "registration")?;
        let generation = materialization_number(&f, "generation")?;
        require(is_n(generation) && generation >= 1.0)?;
        for k in ["prior-control", "prior-transition"] {
            let v = materialization_text(&f, k)?;
            require(v.is_empty() || is_content_id(&v))?;
        }
        let verb = materialization_text(&f, "verb")?;
        require(STATE_VERBS.contains(&verb.as_str()))?;
        for k in [
            "source-revision",
            "authority",
            "hyperschema-pin",
            "schema-pin",
        ] {
            require(is_content_id(&materialization_text(&f, k)?))?;
        }
        for k in ["at", "definition-at"] {
            materialization_number(&f, k)?;
        }
        require((verb == "retire") != f.contains_key("capture"))?;
        if f.contains_key("capture") {
            materialization_ref(&f, "capture")?;
        }
        require(d.claims.timestamp == d.claims.valid_from && d.claims.valid_until.is_none())?;
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
    if kind == "control-image/1" {
        materialization_bytes(&f, "data")?;
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
        if SETS.contains(&k) {
            let mut keyed = ts
                .into_iter()
                .map(|t| Ok((set_key(&t)?, t)))
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
