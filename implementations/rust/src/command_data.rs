//! Pure command profile 1 description codecs. Parsing grants no execution authority.
use crate::cbor::{decode, encode, CborValue};
use crate::types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target, VOCAB_PREFIX};
use std::collections::{BTreeMap, BTreeSet};

pub fn role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.command.{suffix}")
}
pub fn is_content_id(s: &str) -> bool {
    s.len() == 68
        && s.starts_with("1e20")
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn is_author(s: &str) -> bool {
    s.strip_prefix("ed25519:").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn is_head(s: &str) -> bool {
    s.is_empty() || is_content_id(s)
}
fn require(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err("command-data: invalid description".into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationKind {
    Retain,
    Evaluate,
}
impl OperationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Retain => "retain",
            Self::Evaluate => "evaluate",
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Configuration {
    pub receiver: String,
    pub callers: Vec<String>,
    pub installed: Vec<String>,
    pub quota: u64,
    pub max_deltas: u64,
    pub max_bytes: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct CommonRequest {
    pub receiver: String,
    pub configuration: String,
    pub operation: String,
    pub expected_head: Option<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct EvaluateArguments {
    pub source: String,
    pub expected_digest: Option<String>,
    pub root: String,
    pub at: f64,
    pub interpretation: String,
    pub hyperschema: String,
    pub hyperschema_pin: String,
    pub schema: String,
    pub schema_pin: String,
    pub definitions: Vec<String>,
    pub bindings: BTreeMap<String, Primitive>,
}
#[derive(Debug, Clone, PartialEq)]
pub enum RequestArguments {
    Retain(Vec<String>),
    Evaluate(Box<EvaluateArguments>),
}
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub common: CommonRequest,
    pub arguments: RequestArguments,
}
#[derive(Debug, Clone, PartialEq)]
pub enum OutcomeBody {
    Retain {
        before_head: String,
        head: String,
        before_digest: String,
        digest: String,
        admitted: Vec<String>,
        duplicate: Vec<String>,
    },
    Evaluate {
        source: String,
        digest: String,
        definition_digest: String,
        head: Option<String>,
        at: f64,
        interpretation: String,
        hyperschema_pin: String,
        schema_pin: String,
        value: Vec<u8>,
    },
    Refused {
        code: String,
    },
    Indeterminate,
}
impl OutcomeBody {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Retain { .. } | Self::Evaluate { .. } => "completed",
            Self::Refused { .. } => "refused",
            Self::Indeterminate => "indeterminate",
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub receiver: String,
    pub configuration: String,
    pub request: String,
    pub body: OutcomeBody,
}

struct Fields<'a>(BTreeMap<String, Vec<&'a Target>>);
impl<'a> Fields<'a> {
    fn new(d: &'a Delta) -> Result<Self, String> {
        let mut m = BTreeMap::new();
        for p in &d.claims.pointers {
            let s = p
                .role
                .strip_prefix(&role(""))
                .ok_or("command-data: unknown role")?;
            m.entry(s.to_string())
                .or_insert_with(Vec::new)
                .push(&p.target);
        }
        Ok(Self(m))
    }
    fn only(&self, allowed: &[&str]) -> Result<(), String> {
        require(self.0.keys().all(|k| allowed.contains(&k.as_str())))
    }
    fn one(&self, k: &str) -> Result<&'a Target, String> {
        let v = self.0.get(k).ok_or("command-data: missing role")?;
        require(v.len() == 1)?;
        Ok(v[0])
    }
    fn text(&self, k: &str) -> Result<String, String> {
        match self.one(k)? {
            Target::Primitive(Primitive::Str(s)) => Ok(s.clone()),
            _ => Err("command-data: text required".into()),
        }
    }
    fn number(&self, k: &str) -> Result<f64, String> {
        match self.one(k)? {
            Target::Primitive(Primitive::Num(n)) if n.is_finite() => Ok(*n),
            _ => Err("command-data: number required".into()),
        }
    }
    fn integer(&self, k: &str) -> Result<u64, String> {
        let n = self.number(k)?;
        require((0.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0)?;
        Ok(n as u64)
    }
    fn entity(&self, k: &str) -> Result<String, String> {
        match self.one(k)? {
            Target::Entity(EntityRef { id, context: None }) => Ok(id.clone()),
            _ => Err("command-data: context-free entity required".into()),
        }
    }
    fn reference(&self, k: &str) -> Result<String, String> {
        match self.one(k)? {
            Target::Delta(DeltaRef {
                delta,
                context: None,
            }) if is_content_id(delta) => Ok(delta.clone()),
            _ => Err("command-data: canonical context-free reference required".into()),
        }
    }
    fn optional_text(&self, k: &str) -> Result<Option<String>, String> {
        if self.0.contains_key(k) {
            self.text(k).map(Some)
        } else {
            Ok(None)
        }
    }
    fn set(&self, k: &str, refs: bool, min: usize) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for t in self.0.get(k).into_iter().flatten() {
            let s = match (refs, t) {
                (
                    true,
                    Target::Delta(DeltaRef {
                        delta,
                        context: None,
                    }),
                ) if is_content_id(delta) => delta.clone(),
                (false, Target::Primitive(Primitive::Str(s))) if is_author(s) => s.clone(),
                _ => return Err("command-data: invalid set member".into()),
            };
            out.push(s);
        }
        let unique: BTreeSet<_> = out.iter().collect();
        require(out.len() >= min && unique.len() == out.len())?;
        out.sort();
        Ok(out)
    }
    fn bytes(&self, k: &str) -> Result<Vec<u8>, String> {
        match self.one(k)? {
            Target::Bytes { mime, value } if mime == "application/cbor" => Ok(value.clone()),
            _ => Err("command-data: application/cbor bytes required".into()),
        }
    }
    fn kind(&self, k: &str) -> Result<(), String> {
        require(self.text("kind")? == k)
    }
}

pub fn read_configuration(d: &Delta) -> Result<Configuration, String> {
    let f = Fields::new(d)?;
    f.only(&[
        "kind",
        "receiver",
        "caller",
        "installed",
        "quota",
        "max-deltas",
        "max-bytes",
    ])?;
    f.kind("endpoint/1")?;
    let c = Configuration {
        receiver: f.entity("receiver")?,
        callers: f.set("caller", false, 1)?,
        installed: f.set("installed", true, 2)?,
        quota: f.integer("quota")?,
        max_deltas: f.integer("max-deltas")?,
        max_bytes: f.integer("max-bytes")?,
    };
    require(
        is_author(&c.receiver) && c.installed.len() == 2 && c.max_deltas > 0 && c.max_bytes > 0,
    )?;
    Ok(c)
}
pub fn read_operation(d: &Delta) -> Result<OperationKind, String> {
    let f = Fields::new(d)?;
    f.only(&[
        "kind",
        "name",
        "interpreter",
        "input-contract",
        "output-contract",
        "effect",
        "replay",
        "dependencies",
    ])?;
    f.kind("operation/1")?;
    let name = f.entity("name")?;
    let k = if name == role("retain") {
        OperationKind::Retain
    } else if name == role("evaluate") {
        OperationKind::Evaluate
    } else {
        return Err("command-data: unsupported operation".into());
    };
    let contract = format!("{}/1", role(k.as_str()));
    require(
        f.text("interpreter")? == contract
            && f.text("input-contract")? == contract
            && f.text("output-contract")? == format!("{}/1", role("outcome"))
            && f.text("effect")?
                == if k == OperationKind::Retain {
                    "admission"
                } else {
                    "none"
                }
            && f.text("replay")? == "re-evaluate/1"
            && f.text("dependencies")? == "explicit-support/1",
    )?;
    Ok(k)
}
pub fn read_common_request(d: &Delta) -> Result<CommonRequest, String> {
    let f = Fields::new(d)?;
    f.kind("request/1")?;
    let c = CommonRequest {
        receiver: f.entity("receiver")?,
        configuration: f.reference("configuration")?,
        operation: f.reference("operation")?,
        expected_head: f.optional_text("expected-head")?,
    };
    require(is_author(&c.receiver) && c.expected_head.as_ref().is_none_or(|h| is_head(h)))?;
    Ok(c)
}
pub fn read_request(d: &Delta, k: OperationKind) -> Result<Request, String> {
    let common = read_common_request(d)?;
    let f = Fields::new(d)?;
    let args = match k {
        OperationKind::Retain => {
            f.only(&[
                "kind",
                "receiver",
                "configuration",
                "operation",
                "expected-head",
                "payload",
            ])?;
            RequestArguments::Retain(f.set("payload", true, 1)?)
        }
        OperationKind::Evaluate => {
            f.only(&[
                "kind",
                "receiver",
                "configuration",
                "operation",
                "expected-head",
                "source",
                "expected-digest",
                "root",
                "at",
                "interpretation",
                "hyperschema",
                "hyperschema-pin",
                "schema",
                "schema-pin",
                "definition",
                "bindings",
            ])?;
            let a = EvaluateArguments {
                source: f.text("source")?,
                expected_digest: f.optional_text("expected-digest")?,
                root: f.entity("root")?,
                at: f.number("at")?,
                interpretation: f.text("interpretation")?,
                hyperschema: f.reference("hyperschema")?,
                hyperschema_pin: f.text("hyperschema-pin")?,
                schema: f.reference("schema")?,
                schema_pin: f.text("schema-pin")?,
                definitions: f.set("definition", true, 0)?,
                bindings: read_bindings(&f.bytes("bindings")?)?,
            };
            require(
                matches!(a.source.as_str(), "admitted" | "catalog")
                    && valid_interpretation(&a.interpretation)
                    && is_content_id(&a.hyperschema_pin)
                    && is_content_id(&a.schema_pin)
                    && a.expected_digest.as_ref().is_none_or(|s| is_content_id(s))
                    && !a.bindings.contains_key("root")
                    && a.hyperschema != a.schema
                    && !a.definitions.contains(&a.hyperschema)
                    && !a.definitions.contains(&a.schema)
                    && (a.source != "catalog" || common.expected_head.is_none()),
            )?;
            RequestArguments::Evaluate(Box::new(a))
        }
    };
    Ok(Request {
        common,
        arguments: args,
    })
}
pub fn valid_interpretation(s: &str) -> bool {
    matches!(
        s,
        "core/1" | "principal-sameAuthor/1" | "principal-rootOrSameAuthor/1"
    )
}

fn canonical_map(bytes: &[u8]) -> Result<BTreeMap<String, CborValue>, String> {
    let value = decode(bytes)?;
    require(encode(&value) == bytes)?;
    let CborValue::Map(entries) = value else {
        return Err("command-data: map required".into());
    };
    let mut out = BTreeMap::new();
    for (k, v) in entries {
        require(out.insert(k, v).is_none())?;
    }
    Ok(out)
}
fn prim_cbor(p: &Primitive) -> CborValue {
    match p {
        Primitive::Str(s) => CborValue::Tstr(s.clone()),
        Primitive::Num(n) => CborValue::Float(*n),
        Primitive::Bool(b) => CborValue::Bool(*b),
    }
}
pub fn read_bindings(bytes: &[u8]) -> Result<BTreeMap<String, Primitive>, String> {
    canonical_map(bytes)?
        .into_iter()
        .map(|(k, v)| {
            require(k != "root")?;
            let p = match v {
                CborValue::Tstr(s) => Primitive::Str(s),
                CborValue::Float(n) => Primitive::Num(n),
                CborValue::Bool(b) => Primitive::Bool(b),
                _ => return Err("command-data: primitive binding required".into()),
            };
            Ok((k, p))
        })
        .collect()
}
pub fn write_bindings(bindings: &BTreeMap<String, Primitive>) -> Result<Vec<u8>, String> {
    require(
        !bindings.contains_key("root")
            && bindings
                .values()
                .all(|p| !matches!(p,Primitive::Num(n) if !n.is_finite())),
    )?;
    Ok(encode(&CborValue::Map(
        bindings
            .iter()
            .map(|(k, v)| (k.clone(), prim_cbor(v)))
            .collect(),
    )))
}
fn text(s: &str) -> Target {
    Target::Primitive(Primitive::Str(s.to_string()))
}
fn entity(s: &str) -> Target {
    Target::Entity(EntityRef {
        id: s.to_string(),
        context: None,
    })
}
fn reference(s: &str) -> Target {
    Target::Delta(DeltaRef {
        delta: s.to_string(),
        context: None,
    })
}
fn pointer(s: &str, t: Target) -> Pointer {
    Pointer {
        role: role(s),
        target: t,
    }
}
fn sorted_set(xs: &[String]) -> Result<Vec<String>, String> {
    let mut xs = xs.to_vec();
    xs.sort();
    require(xs.windows(2).all(|x| x[0] != x[1]))?;
    Ok(xs)
}
pub fn configuration_pointers(c: &Configuration) -> Result<Vec<Pointer>, String> {
    let mut p = vec![
        pointer("kind", text("endpoint/1")),
        pointer("receiver", entity(&c.receiver)),
    ];
    for s in sorted_set(&c.callers)? {
        p.push(pointer("caller", text(&s)));
    }
    for s in sorted_set(&c.installed)? {
        p.push(pointer("installed", reference(&s)));
    }
    for (k, v) in [
        ("quota", c.quota),
        ("max-deltas", c.max_deltas),
        ("max-bytes", c.max_bytes),
    ] {
        p.push(pointer(k, Target::Primitive(Primitive::Num(v as f64))));
    }
    validate_pointers(&p, |d| read_configuration(d).map(|_| ()))?;
    Ok(p)
}
pub fn operation_pointers(k: OperationKind) -> Vec<Pointer> {
    let contract = format!("{}/1", role(k.as_str()));
    vec![
        pointer("kind", text("operation/1")),
        pointer("name", entity(&role(k.as_str()))),
        pointer("interpreter", text(&contract)),
        pointer("input-contract", text(&contract)),
        pointer("output-contract", text(&format!("{}/1", role("outcome")))),
        pointer(
            "effect",
            text(if k == OperationKind::Retain {
                "admission"
            } else {
                "none"
            }),
        ),
        pointer("replay", text("re-evaluate/1")),
        pointer("dependencies", text("explicit-support/1")),
    ]
}
pub fn request_pointers(r: &Request) -> Result<Vec<Pointer>, String> {
    let c = &r.common;
    let mut p = vec![
        pointer("kind", text("request/1")),
        pointer("receiver", entity(&c.receiver)),
        pointer("configuration", reference(&c.configuration)),
        pointer("operation", reference(&c.operation)),
    ];
    if let Some(h) = &c.expected_head {
        p.push(pointer("expected-head", text(h)));
    }
    let k = match &r.arguments {
        RequestArguments::Retain(xs) => {
            for s in sorted_set(xs)? {
                p.push(pointer("payload", reference(&s)));
            }
            OperationKind::Retain
        }
        RequestArguments::Evaluate(a) => {
            p.push(pointer("source", text(&a.source)));
            if let Some(d) = &a.expected_digest {
                p.push(pointer("expected-digest", text(d)));
            }
            p.extend([
                pointer("root", entity(&a.root)),
                pointer("at", Target::Primitive(Primitive::Num(a.at))),
                pointer("interpretation", text(&a.interpretation)),
                pointer("hyperschema", reference(&a.hyperschema)),
                pointer("hyperschema-pin", text(&a.hyperschema_pin)),
                pointer("schema", reference(&a.schema)),
                pointer("schema-pin", text(&a.schema_pin)),
            ]);
            for s in sorted_set(&a.definitions)? {
                p.push(pointer("definition", reference(&s)));
            }
            p.push(pointer(
                "bindings",
                Target::Bytes {
                    mime: "application/cbor".into(),
                    value: write_bindings(&a.bindings)?,
                },
            ));
            OperationKind::Evaluate
        }
    };
    validate_pointers(&p, |d| read_request(d, k).map(|_| ()))?;
    Ok(p)
}
fn validate_pointers(
    p: &[Pointer],
    f: impl FnOnce(&Delta) -> Result<(), String>,
) -> Result<(), String> {
    f(&Delta {
        id: String::new(),
        sig: None,
        claims: Claims {
            author: p
                .iter()
                .find_map(|pointer| match &pointer.target {
                    Target::Entity(e) if pointer.role == role("receiver") => Some(e.id.clone()),
                    _ => None,
                })
                .unwrap_or_default(),
            timestamp: 0.0,
            valid_from: 0.0,
            valid_until: None,
            pointers: p.to_vec(),
        },
    })
}

pub const REFUSAL_CODES: &[&str] = &[
    "invalid-appearance",
    "invalid-request",
    "invalid-arguments",
    "invalid-definition",
    "pin-mismatch",
    "ambiguous-definition",
    "definition-closure",
    "definition-cycle",
    "invalid-program",
    "entry-missing",
    "request-outside-validity",
    "configuration-mismatch",
    "unauthorized",
    "unsupported-operation",
    "missing-support",
    "unexpected-support",
    "admission-rejected",
    "write-conflict",
    "source-changed",
    "source-unavailable",
    "precondition-failed",
    "resource-limit",
    "resource-exhausted",
];
struct BodyFields(BTreeMap<String, CborValue>);
impl BodyFields {
    fn only(&self, keys: &[&str]) -> Result<(), String> {
        require(self.0.len() == keys.len() && self.0.keys().all(|k| keys.contains(&k.as_str())))
    }
    fn text(&self, k: &str) -> Result<String, String> {
        match self.0.get(k) {
            Some(CborValue::Tstr(s)) => Ok(s.clone()),
            _ => Err("command-data: body text required".into()),
        }
    }
    fn ids(&self, k: &str) -> Result<Vec<String>, String> {
        let Some(CborValue::Array(xs)) = self.0.get(k) else {
            return Err("command-data: ID array required".into());
        };
        let ids = xs
            .iter()
            .map(|v| match v {
                CborValue::Tstr(s) if is_content_id(s) => Ok(s.clone()),
                _ => Err("command-data: invalid ID".into()),
            })
            .collect::<Result<Vec<_>, String>>()?;
        require(ids.windows(2).all(|x| x[0] < x[1]))?;
        Ok(ids)
    }
}
pub fn read_outcome_body(status: &str, bytes: &[u8]) -> Result<OutcomeBody, String> {
    let f = BodyFields(canonical_map(bytes)?);
    match status {
        "refused" => {
            f.only(&["code"])?;
            let code = f.text("code")?;
            require(REFUSAL_CODES.contains(&code.as_str()))?;
            Ok(OutcomeBody::Refused { code })
        }
        "indeterminate" => {
            f.only(&["code"])?;
            require(f.text("code")? == "commit-unconfirmed")?;
            Ok(OutcomeBody::Indeterminate)
        }
        "completed" => match f.text("kind")?.as_str() {
            "retain" => {
                f.only(&[
                    "kind",
                    "beforeHead",
                    "head",
                    "beforeDigest",
                    "digest",
                    "admitted",
                    "duplicate",
                ])?;
                let before_head = f.text("beforeHead")?;
                let head = f.text("head")?;
                let before_digest = f.text("beforeDigest")?;
                let digest = f.text("digest")?;
                let admitted = f.ids("admitted")?;
                let duplicate = f.ids("duplicate")?;
                require(
                    is_head(&before_head)
                        && is_head(&head)
                        && is_content_id(&before_digest)
                        && is_content_id(&digest)
                        && admitted.iter().all(|id| !duplicate.contains(id)),
                )?;
                Ok(OutcomeBody::Retain {
                    before_head,
                    head,
                    before_digest,
                    digest,
                    admitted,
                    duplicate,
                })
            }
            "evaluate" => {
                let source = f.text("source")?;
                let head = if source == "admitted" {
                    f.only(&[
                        "kind",
                        "source",
                        "digest",
                        "definitionDigest",
                        "head",
                        "at",
                        "interpretation",
                        "hyperschemaPin",
                        "schemaPin",
                        "value",
                    ])?;
                    Some(f.text("head")?)
                } else {
                    require(source == "catalog")?;
                    f.only(&[
                        "kind",
                        "source",
                        "digest",
                        "definitionDigest",
                        "at",
                        "interpretation",
                        "hyperschemaPin",
                        "schemaPin",
                        "value",
                    ])?;
                    None
                };
                let digest = f.text("digest")?;
                let definition_digest = f.text("definitionDigest")?;
                let interpretation = f.text("interpretation")?;
                let hyperschema_pin = f.text("hyperschemaPin")?;
                let schema_pin = f.text("schemaPin")?;
                let Some(CborValue::Float(at)) = f.0.get("at") else {
                    return Err("command-data: body number required".into());
                };
                let Some(CborValue::Bstr(value)) = f.0.get("value") else {
                    return Err("command-data: value bytes required".into());
                };
                require(
                    is_content_id(&digest)
                        && is_content_id(&definition_digest)
                        && is_content_id(&hyperschema_pin)
                        && is_content_id(&schema_pin)
                        && valid_interpretation(&interpretation)
                        && head.as_ref().is_none_or(|h| is_head(h)),
                )?;
                Ok(OutcomeBody::Evaluate {
                    source,
                    digest,
                    definition_digest,
                    head,
                    at: *at,
                    interpretation,
                    hyperschema_pin,
                    schema_pin,
                    value: value.clone(),
                })
            }
            _ => Err("command-data: unknown completed kind".into()),
        },
        _ => Err("command-data: unknown status".into()),
    }
}
pub fn write_outcome_body(body: &OutcomeBody) -> Result<Vec<u8>, String> {
    fn s(v: &str) -> CborValue {
        CborValue::Tstr(v.into())
    }
    fn ids(v: &[String]) -> CborValue {
        CborValue::Array(v.iter().map(|v| s(v)).collect())
    }
    let fields = match body {
        OutcomeBody::Retain {
            before_head,
            head,
            before_digest,
            digest,
            admitted,
            duplicate,
        } => vec![
            ("kind", s("retain")),
            ("beforeHead", s(before_head)),
            ("head", s(head)),
            ("beforeDigest", s(before_digest)),
            ("digest", s(digest)),
            ("admitted", ids(admitted)),
            ("duplicate", ids(duplicate)),
        ],
        OutcomeBody::Evaluate {
            source,
            digest,
            definition_digest,
            head,
            at,
            interpretation,
            hyperschema_pin,
            schema_pin,
            value,
        } => {
            require(at.is_finite())?;
            let mut f = vec![
                ("kind", s("evaluate")),
                ("source", s(source)),
                ("digest", s(digest)),
                ("definitionDigest", s(definition_digest)),
                ("at", CborValue::Float(*at)),
                ("interpretation", s(interpretation)),
                ("hyperschemaPin", s(hyperschema_pin)),
                ("schemaPin", s(schema_pin)),
                ("value", CborValue::Bstr(value.clone())),
            ];
            if let Some(h) = head {
                f.push(("head", s(h)));
            }
            f
        }
        OutcomeBody::Refused { code } => vec![("code", s(code))],
        OutcomeBody::Indeterminate => vec![("code", s("commit-unconfirmed"))],
    };
    let bytes = encode(&CborValue::Map(
        fields.into_iter().map(|(k, v)| (k.into(), v)).collect(),
    ));
    read_outcome_body(body.status(), &bytes)?;
    Ok(bytes)
}
pub fn read_outcome(d: &Delta) -> Result<Outcome, String> {
    let f = Fields::new(d)?;
    f.only(&[
        "kind",
        "receiver",
        "configuration",
        "request",
        "status",
        "result",
    ])?;
    f.kind("outcome/1")?;
    let receiver = f.entity("receiver")?;
    require(
        is_author(&receiver)
            && d.claims.author == receiver
            && d.claims.timestamp == d.claims.valid_from
            && d.claims.valid_until.is_none(),
    )?;
    Ok(Outcome {
        receiver,
        configuration: f.reference("configuration")?,
        request: f.reference("request")?,
        body: read_outcome_body(&f.text("status")?, &f.bytes("result")?)?,
    })
}
pub fn outcome_pointers(o: &Outcome) -> Result<Vec<Pointer>, String> {
    let p = vec![
        pointer("kind", text("outcome/1")),
        pointer("receiver", entity(&o.receiver)),
        pointer("configuration", reference(&o.configuration)),
        pointer("request", reference(&o.request)),
        pointer("status", text(o.body.status())),
        pointer(
            "result",
            Target::Bytes {
                mime: "application/cbor".into(),
                value: write_outcome_body(&o.body)?,
            },
        ),
    ];
    validate_pointers(&p, |d| read_outcome(d).map(|_| ()))?;
    Ok(p)
}
