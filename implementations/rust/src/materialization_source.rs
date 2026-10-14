//! SPEC-16 MR-09/10: full source testimony. No serialized object installs a native grant.
use crate::anchored::{scope_ids, DeltaSource};
use crate::cbor::{encode, CborPathPart, CborValue};
use crate::delta::canonical_bytes;
use crate::evidence_codec::{bytes, canonical_guard, fields, get, text, EvidenceCodecError};
use crate::hash::content_address;
use crate::json_profile::parse_claims;
use crate::set::DeltaSet;
use crate::sign::{verify_canonical_delta, Verification};
use crate::term_io::cbor_to_json;
use crate::types::{Delta, Target};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationSourceError {
    InvalidSource,
    ResourceLimit,
}
impl std::fmt::Display for MaterializationSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidSource => "invalid-source",
            Self::ResourceLimit => "resource-limit",
        })
    }
}
impl std::error::Error for MaterializationSourceError {}
impl From<EvidenceCodecError> for MaterializationSourceError {
    fn from(e: EvidenceCodecError) -> Self {
        match e {
            EvidenceCodecError::ResourceLimit => Self::ResourceLimit,
            _ => Self::InvalidSource,
        }
    }
}
type Result<T> = std::result::Result<T, MaterializationSourceError>;
const INVALID: MaterializationSourceError = MaterializationSourceError::InvalidSource;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaterializationSourceLimits {
    pub artifact_bytes: usize,
    pub appearances: usize,
    pub pointers: usize,
    pub components: usize,
    pub inventory_ids: usize,
}
impl Default for MaterializationSourceLimits {
    fn default() -> Self {
        Self {
            artifact_bytes: 16777216,
            appearances: 4096,
            pointers: 256,
            components: 64,
            inventory_ids: 16384,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationSourceFailure {
    Unauthorized,
    SourceChanged,
    SourceUnavailable,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationCapture {
    pub capture: Delta,
    pub authority: Delta,
    pub snapshot: Delta,
}
/// Host policy and current physical membership are native capabilities, never inferred from bytes.
pub trait MaterializationSourceCapability {
    fn capture(
        &mut self,
        binding_id: &str,
        serving_at: f64,
        cutoff: Option<f64>,
    ) -> std::result::Result<MaterializationCapture, MaterializationSourceFailure>;
    fn check_current(
        &mut self,
        binding_id: &str,
        revision: &str,
        authority: &str,
        serving_at: f64,
        cutoff: Option<f64>,
        required_support: &[String],
    ) -> std::result::Result<(), MaterializationSourceFailure>;
    /// The current check for a scoped capture (SPEC-17 §7.5): `scope` names the captured
    /// entities, so the host recomputes the revision from its index. Hosts that serve only full
    /// captures keep the default.
    #[allow(clippy::too_many_arguments)]
    fn check_current_scoped(
        &mut self,
        binding_id: &str,
        revision: &str,
        authority: &str,
        serving_at: f64,
        cutoff: Option<f64>,
        required_support: &[String],
        _scope: Option<&[String]>,
    ) -> std::result::Result<(), MaterializationSourceFailure> {
        self.check_current(
            binding_id,
            revision,
            authority,
            serving_at,
            cutoff,
            required_support,
        )
    }
    fn reacquire_snapshot(
        &mut self,
        binding_id: &str,
        exact_capture: &Delta,
        serving_at: f64,
    ) -> std::result::Result<Vec<u8>, MaterializationSourceFailure>;
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationBindingSpec {
    pub source_id: String,
    pub capturer: String,
    pub authority_root: String,
    pub selection: CborValue,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationAuthoritySpec {
    pub root: String,
    pub epoch: u64,
    pub context: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationSourceSnapshot {
    pub value: CborValue,
    pub binding: String,
    pub authority: String,
    pub selection: String,
    pub revision: String,
    pub membership: String,
    pub appearance_digest: String,
    pub serving_at: f64,
    pub historical_cutoff: Option<f64>,
    /// Present for a scoped capture (SPEC-17 §7): the entities whose scope S(E) the operands are.
    pub scope: Option<Vec<String>>,
    pub components: Vec<CborValue>,
    pub deltas: Vec<Delta>,
}
fn checked_limits(l: MaterializationSourceLimits) -> Result<()> {
    let d = MaterializationSourceLimits::default();
    require(
        [
            (l.artifact_bytes, d.artifact_bytes),
            (l.appearances, d.appearances),
            (l.pointers, d.pointers),
            (l.components, d.components),
            (l.inventory_ids, d.inventory_ids),
        ]
        .iter()
        .all(|(v, max)| *v > 0 && v <= max),
    )
}
fn require(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(INVALID)
    }
}
fn limit(n: usize, max: usize) -> Result<()> {
    if n > max {
        Err(MaterializationSourceError::ResourceLimit)
    } else {
        Ok(())
    }
}
fn id(s: &str) -> Result<String> {
    require(
        s.len() == 68
            && s.starts_with("1e20")
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    )?;
    Ok(s.into())
}
fn peer(s: &str) -> Result<String> {
    let tail = s.strip_prefix("ed25519:").ok_or(INVALID)?;
    require(
        tail.len() == 64
            && tail
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    )?;
    Ok(s.into())
}
fn string(s: &str) -> CborValue {
    CborValue::Tstr(s.into())
}
fn map(fs: Vec<(&str, CborValue)>) -> CborValue {
    CborValue::Map(fs.into_iter().map(|(k, x)| (k.into(), x)).collect())
}
fn exact<'a>(
    v: &'a CborValue,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<&'a str, &'a CborValue>> {
    let f = fields(v, &[required, optional].concat())?;
    require(required.iter().all(|k| f.contains_key(k)))?;
    Ok(f)
}
fn list(v: &CborValue) -> Result<&[CborValue]> {
    if let CborValue::Array(xs) = v {
        Ok(xs)
    } else {
        Err(INVALID)
    }
}
fn number(v: &CborValue) -> Result<f64> {
    if let CborValue::Float(n) = v {
        require(n.is_finite())?;
        Ok(*n)
    } else {
        Err(INVALID)
    }
}
fn ordered(xs: &[String]) -> Result<()> {
    require(xs.windows(2).all(|w| w[0] < w[1]))
}
fn ids(v: &CborValue, is_peer: bool) -> Result<Vec<String>> {
    let xs = list(v)?
        .iter()
        .map(|x| {
            let s = text(x)?;
            if is_peer {
                peer(s)
            } else {
                id(s)
            }
        })
        .collect::<Result<Vec<_>>>()?;
    ordered(&xs)?;
    Ok(xs)
}
fn canonical(input: &[u8], max: usize) -> Result<CborValue> {
    require(max > 0 && max <= 16777216)?;
    Ok(canonical_guard(input, max, &mut |_, _, _| Ok(()))?)
}
fn guard_limit(n: usize, max: usize) -> std::result::Result<(), EvidenceCodecError> {
    if n > max {
        Err(EvidenceCodecError::ResourceLimit)
    } else {
        Ok(())
    }
}
pub fn encode_materialization_appearance(
    d: &Delta,
    limits: MaterializationSourceLimits,
) -> Result<Vec<u8>> {
    checked_limits(limits)?;
    limit(d.claims.pointers.len(), limits.pointers)?;
    let claims = canonical_bytes(&d.claims).map_err(|_| INVALID)?;
    limit(claims.len(), limits.artifact_bytes)?;
    require(verify_canonical_delta(d) == Verification::Verified)?;
    let sig = d.sig.as_ref().ok_or(INVALID)?;
    let out = encode(&map(vec![
        ("id", string(&d.id)),
        ("claims", CborValue::Bstr(claims)),
        (
            "sig",
            CborValue::Bstr(hex::decode(sig).map_err(|_| INVALID)?),
        ),
    ]));
    limit(out.len(), limits.artifact_bytes)?;
    Ok(out)
}
pub fn decode_materialization_appearance(
    input: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<Delta> {
    checked_limits(limits)?;
    let raw = canonical(input, limits.artifact_bytes)?;
    let f = exact(&raw, &["id", "claims", "sig"], &[])?;
    let claims = canonical_guard(
        bytes(get(&f, "claims")?)?,
        limits.artifact_bytes,
        &mut |path, is_map, n| {
            if !is_map && path == [CborPathPart::Key("pointers".into())] {
                guard_limit(n, limits.pointers)?;
            }
            Ok(())
        },
    )?;
    let d = Delta {
        id: id(text(get(&f, "id")?)?)?,
        claims: parse_claims(&cbor_to_json(&claims)).map_err(|_| INVALID)?,
        sig: Some(hex::encode(bytes(get(&f, "sig")?)?)),
    };
    require(encode_materialization_appearance(&d, limits)? == input)?;
    Ok(d)
}
/// The full authorized source (MR-09), or one read's scope S(E) (SPEC-17 §7).
pub const SCOPED_SNAPSHOT_PROFILE: &str = "scoped-snapshot/1";
const SOURCE_PROFILES: [&str; 2] = ["host-authorized-snapshot/1", SCOPED_SNAPSHOT_PROFILE];
/// Does this binding's selection promise scoped captures?
pub fn materialization_binding_scoped(spec: &MaterializationBindingSpec) -> bool {
    exact(&spec.selection, &["profile", "parameters"], &[])
        .and_then(|s| Ok(text(get(&s, "profile")?)? == SCOPED_SNAPSHOT_PROFILE))
        .unwrap_or(false)
}
// A scope is a nonempty, sorted, distinct list of entity ids (SPEC-17 §7.2).
fn scope_of(v: &CborValue, limits: MaterializationSourceLimits) -> Result<Vec<String>> {
    let xs = list(v)?
        .iter()
        .map(|x| text(x).map(str::to_string).map_err(|_| INVALID))
        .collect::<Result<Vec<_>>>()?;
    limit(xs.len(), limits.inventory_ids)?;
    require(!xs.is_empty() && xs.iter().all(|x| !x.is_empty()))?;
    ordered(&xs)?;
    Ok(xs)
}
// The operands as a delta source, indexed once: the scope check reads them, never the store.
struct OperandSource<'a> {
    by_id: BTreeMap<&'a str, &'a Delta>,
    targets: BTreeMap<String, Vec<String>>,
    negators: BTreeMap<String, Vec<String>>,
}
impl<'a> OperandSource<'a> {
    fn new(deltas: &'a [Delta]) -> Self {
        let mut source = OperandSource {
            by_id: deltas.iter().map(|d| (d.id.as_str(), d)).collect(),
            targets: BTreeMap::new(),
            negators: BTreeMap::new(),
        };
        for d in deltas {
            for ptr in &d.claims.pointers {
                match &ptr.target {
                    Target::Entity(e) => source
                        .targets
                        .entry(e.id.clone())
                        .or_default()
                        .push(d.id.clone()),
                    Target::Delta(r) if ptr.role == "negates" => source
                        .negators
                        .entry(r.delta.clone())
                        .or_default()
                        .push(d.id.clone()),
                    _ => {}
                }
            }
        }
        source
    }
}
impl DeltaSource for OperandSource<'_> {
    fn get(&self, id: &str) -> Option<&Delta> {
        self.by_id.get(id).copied()
    }
    fn targets(&self, entity: &str) -> Vec<String> {
        self.targets.get(entity).cloned().unwrap_or_default()
    }
    fn negators(&self, id: &str) -> Vec<String> {
        self.negators.get(id).cloned().unwrap_or_default()
    }
}
pub fn decode_materialization_binding_spec(
    input: &[u8],
    max: usize,
) -> Result<MaterializationBindingSpec> {
    let raw = canonical(input, max)?;
    let f = exact(
        &raw,
        &["sourceId", "capturer", "authorityRoot", "selection"],
        &[],
    )?;
    let selection = get(&f, "selection")?;
    let s = exact(selection, &["profile", "parameters"], &[])?;
    let source_id = text(get(&f, "sourceId")?)?;
    require(!source_id.is_empty() && SOURCE_PROFILES.contains(&text(get(&s, "profile")?)?))?;
    require(matches!(
        canonical(bytes(get(&s, "parameters")?)?, max)?,
        CborValue::Map(_)
    ))?;
    Ok(MaterializationBindingSpec {
        source_id: source_id.into(),
        capturer: peer(text(get(&f, "capturer")?)?)?,
        authority_root: id(text(get(&f, "authorityRoot")?)?)?,
        selection: selection.clone(),
    })
}
pub fn decode_materialization_authority_spec(
    input: &[u8],
    max: usize,
) -> Result<MaterializationAuthoritySpec> {
    let raw = canonical(input, max)?;
    let f = exact(&raw, &["root", "epoch", "context"], &[])?;
    let epoch = number(get(&f, "epoch")?)?;
    require((0.0..=9007199254740991.0).contains(&epoch) && epoch.fract() == 0.0)?;
    let context = bytes(get(&f, "context")?)?;
    require(matches!(canonical(context, max)?, CborValue::Map(_)))?;
    Ok(MaterializationAuthoritySpec {
        root: id(text(get(&f, "root")?)?)?,
        epoch: epoch as u64,
        context: context.to_vec(),
    })
}
const SNAPSHOT_FIELDS: &[&str] = &[
    "format",
    "binding",
    "authority",
    "selection",
    "revision",
    "servingAt",
    "components",
    "appearances",
    "operands",
    "exclusions",
    "membership",
    "appearanceDigest",
];
pub fn decode_materialization_snapshot(
    input: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<MaterializationSourceSnapshot> {
    checked_limits(limits)?;
    let value = canonical_guard(input, limits.artifact_bytes, &mut |path, is_map, n| {
        if is_map {
            return Ok(());
        }
        if path.len() == 1 {
            match &path[0] {
                CborPathPart::Key(k) if k == "components" => guard_limit(n, limits.components)?,
                CborPathPart::Key(k) if k == "appearances" || k == "operands" => {
                    guard_limit(n, limits.appearances)?
                }
                CborPathPart::Key(k) if k == "exclusions" => guard_limit(n, limits.inventory_ids)?,
                _ => {}
            }
        }
        if let Some(CborPathPart::Key(k)) = path.last() {
            if k == "rawIds" || k == "operandIds" {
                guard_limit(n, limits.inventory_ids)?;
            }
            if k == "peers" {
                guard_limit(n, limits.components)?;
            }
        }
        Ok(())
    })?;
    let f = exact(&value, SNAPSHOT_FIELDS, &["historicalCutoff", "scope"])?;
    require(text(get(&f, "format")?)? == "rhizomatic.source-snapshot/1")?;
    let get_id = |k| -> Result<String> { id(text(get(&f, k)?)?) };
    let binding = get_id("binding")?;
    let authority = get_id("authority")?;
    let selection = get_id("selection")?;
    let revision = get_id("revision")?;
    let membership = get_id("membership")?;
    let appearance_digest = get_id("appearanceDigest")?;
    let serving_at = number(get(&f, "servingAt")?)?;
    let historical_cutoff = f.get("historicalCutoff").map(|x| number(x)).transpose()?;
    let scope = f.get("scope").map(|x| scope_of(x, limits)).transpose()?;
    let components = list(get(&f, "components")?)?;
    require(!components.is_empty())?;
    let mut raw: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut eligible: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut component_peers = Vec::new();
    let mut component_bases = Vec::new();
    for c in components {
        let fs = exact(
            c,
            &["peer", "revision", "capturedAt", "rawIds", "operandIds"],
            &[],
        )?;
        let p = peer(text(get(&fs, "peer")?)?)?;
        component_peers.push(p.clone());
        id(text(get(&fs, "revision")?)?)?;
        number(get(&fs, "capturedAt")?)?;
        let raws = ids(get(&fs, "rawIds")?, false)?;
        let ops = ids(get(&fs, "operandIds")?, false)?;
        let raw_set: BTreeSet<&String> = raws.iter().collect();
        require(ops.iter().all(|x| raw_set.contains(x)))?;
        for x in raws {
            raw.entry(x).or_default().insert(p.clone());
        }
        for x in ops {
            eligible.entry(x).or_default().insert(p.clone());
        }
        component_bases.push(CborValue::Map(
            fs.iter()
                .filter(|(k, _)| **k != "capturedAt")
                .map(|(k, v)| ((*k).into(), (*v).clone()))
                .collect(),
        ));
    }
    ordered(&component_peers)?;
    limit(raw.len(), limits.inventory_ids)?;
    let mut table_keys = Vec::new();
    let mut appearance_bytes = BTreeMap::new();
    for record in list(get(&f, "appearances")?)? {
        let r = exact(record, &["key", "value"], &[])?;
        let k = id(text(get(&r, "key")?)?)?;
        let b = bytes(get(&r, "value")?)?;
        require(content_address(b) == k)?;
        table_keys.push(k.clone());
        appearance_bytes.insert(k, b);
        let appearance = canonical(b, limits.artifact_bytes)?;
        let af = exact(&appearance, &["id", "claims", "sig"], &[])?;
        canonical_guard(
            bytes(get(&af, "claims")?)?,
            limits.artifact_bytes,
            &mut |path, is_map, n| {
                if !is_map && path == [CborPathPart::Key("pointers".into())] {
                    guard_limit(n, limits.pointers)?;
                }
                Ok(())
            },
        )?;
    }
    ordered(&table_keys)?;
    let mut selected = BTreeMap::new();
    for (k, b) in appearance_bytes {
        selected.insert(k, decode_materialization_appearance(b, limits)?);
    }
    let mut operand_ids = Vec::new();
    let mut used = BTreeSet::new();
    let mut deltas = Vec::new();
    for o in list(get(&f, "operands")?)? {
        let of = exact(o, &["id", "appearance", "peers"], &[])?;
        let i = id(text(get(&of, "id")?)?)?;
        let a = id(text(get(&of, "appearance")?)?)?;
        let ps = ids(get(&of, "peers")?, true)?;
        let d = selected.get(&a).ok_or(INVALID)?;
        require(
            d.id == i
                && !ps.is_empty()
                && ps
                    == eligible
                        .get(&i)
                        .map(|s| s.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
        )?;
        operand_ids.push(i);
        used.insert(a);
        deltas.push(d.clone());
    }
    ordered(&operand_ids)?;
    require(used.len() == table_keys.len() && eligible.len() == operand_ids.len())?;
    let mut exclusion_ids = Vec::new();
    for e in list(get(&f, "exclusions")?)? {
        let ef = exact(e, &["id", "peers", "reason"], &[])?;
        let i = id(text(get(&ef, "id")?)?)?;
        let ps = ids(get(&ef, "peers")?, true)?;
        require(
            !text(get(&ef, "reason")?)?.is_empty()
                && !eligible.contains_key(&i)
                && !ps.is_empty()
                && ps
                    == raw
                        .get(&i)
                        .map(|s| s.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
        )?;
        exclusion_ids.push(i);
    }
    ordered(&exclusion_ids)?;
    require(raw.len() == operand_ids.len() + exclusion_ids.len())?;
    require(
        DeltaSet::from_deltas(deltas.clone())
            .map_err(|_| INVALID)?
            .digest()
            == membership
            && content_address(&encode(&CborValue::Array(
                table_keys.iter().map(|k| string(k)).collect(),
            ))) == appearance_digest,
    )?;
    let expected = content_address(&encode(&map(vec![
        ("binding", string(&binding)),
        ("authority", string(&authority)),
        ("selection", string(&selection)),
        ("components", CborValue::Array(component_bases)),
        ("membership", string(&membership)),
        ("appearanceDigest", string(&appearance_digest)),
        ("exclusions", get(&f, "exclusions")?.clone()),
    ]
    .into_iter()
    .chain(scope.as_ref().map(|_| ("scope", f["scope"].clone())))
    .collect())));
    require(revision == expected)?;
    // A scoped capture carries exactly S(scope) over its own operands: nothing outside the scope's
    // closure rides along. Completeness against the host's store stays host testimony (MR-10).
    if let Some(scope) = &scope {
        let closed = scope_ids(
            &OperandSource::new(&deltas),
            scope.iter().map(String::as_str),
            None,
        );
        require(closed == operand_ids)?;
    }
    Ok(MaterializationSourceSnapshot {
        value: value.clone(),
        binding,
        authority,
        selection,
        revision,
        membership,
        appearance_digest,
        serving_at,
        historical_cutoff,
        scope,
        components: components.to_vec(),
        deltas,
    })
}
fn capture_basis(snapshot: &MaterializationSourceSnapshot, commitment: &str) -> Result<Vec<u8>> {
    let CborValue::Map(fs) = &snapshot.value else {
        return Err(INVALID);
    };
    let mut fs: Vec<_> = fs
        .iter()
        .filter(|(k, _)| k != "appearances" && k != "format")
        .cloned()
        .collect();
    fs.push(("format".into(), string("rhizomatic.source-basis/1")));
    fs.push(("snapshot".into(), string(commitment)));
    Ok(encode(&CborValue::Map(fs)))
}
/// The metadata a capture basis commits to (MR-10); operand bytes never appear here.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationCaptureBasis {
    pub binding: String,
    pub authority: String,
    pub selection: String,
    pub revision: String,
    pub serving_at: f64,
    pub historical_cutoff: Option<f64>,
    pub scope: Option<Vec<String>>,
    pub membership: String,
    pub appearance_digest: String,
    pub snapshot: String,
}
const CAPTURE_BASIS_FIELDS: &[&str] = &[
    "format",
    "binding",
    "authority",
    "selection",
    "revision",
    "servingAt",
    "components",
    "operands",
    "exclusions",
    "membership",
    "appearanceDigest",
    "snapshot",
];
/// Decode a complete capture basis without its snapshot: the exact MR-10 field set, bounded
/// inventories, sorted components and the revision recomputed from the metadata it names. A
/// basis that drops or adds a field, or whose revision does not follow from its own fields, is
/// invalid. Nothing here proves the operand bytes; that stays with the snapshot checker.
pub fn decode_materialization_capture_basis(
    input: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<MaterializationCaptureBasis> {
    checked_limits(limits)?;
    let value = canonical_guard(input, limits.artifact_bytes, &mut |path, is_map, n| {
        if is_map {
            return Ok(());
        }
        if path.len() == 1 {
            match &path[0] {
                CborPathPart::Key(k) if k == "components" => guard_limit(n, limits.components)?,
                CborPathPart::Key(k) if k == "operands" => guard_limit(n, limits.appearances)?,
                CborPathPart::Key(k) if k == "exclusions" => guard_limit(n, limits.inventory_ids)?,
                _ => {}
            }
        }
        if let Some(CborPathPart::Key(k)) = path.last() {
            if k == "rawIds" || k == "operandIds" {
                guard_limit(n, limits.inventory_ids)?;
            }
            if k == "peers" {
                guard_limit(n, limits.components)?;
            }
        }
        Ok(())
    })?;
    let f = exact(&value, CAPTURE_BASIS_FIELDS, &["historicalCutoff", "scope"])?;
    require(text(get(&f, "format")?)? == "rhizomatic.source-basis/1")?;
    let get_id = |k| -> Result<String> { id(text(get(&f, k)?)?) };
    let binding = get_id("binding")?;
    let authority = get_id("authority")?;
    let selection = get_id("selection")?;
    let revision = get_id("revision")?;
    let membership = get_id("membership")?;
    let appearance_digest = get_id("appearanceDigest")?;
    let snapshot = get_id("snapshot")?;
    let serving_at = number(get(&f, "servingAt")?)?;
    let historical_cutoff = f.get("historicalCutoff").map(|x| number(x)).transpose()?;
    let scope = f.get("scope").map(|x| scope_of(x, limits)).transpose()?;
    let components = list(get(&f, "components")?)?;
    require(!components.is_empty())?;
    // The same inventory rules as the snapshot: every operand and exclusion names exactly the
    // contributing peers, and the two digests follow from the operand ids and appearance keys.
    let mut raw: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut eligible: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut component_peers = Vec::new();
    let mut component_bases = Vec::new();
    for c in components {
        let fs = exact(
            c,
            &["peer", "revision", "capturedAt", "rawIds", "operandIds"],
            &[],
        )?;
        let p = peer(text(get(&fs, "peer")?)?)?;
        component_peers.push(p.clone());
        id(text(get(&fs, "revision")?)?)?;
        number(get(&fs, "capturedAt")?)?;
        let raws = ids(get(&fs, "rawIds")?, false)?;
        let ops = ids(get(&fs, "operandIds")?, false)?;
        let raw_set: BTreeSet<&String> = raws.iter().collect();
        require(ops.iter().all(|x| raw_set.contains(x)))?;
        for x in raws {
            raw.entry(x).or_default().insert(p.clone());
        }
        for x in ops {
            eligible.entry(x).or_default().insert(p.clone());
        }
        component_bases.push(CborValue::Map(
            fs.iter()
                .filter(|(k, _)| **k != "capturedAt")
                .map(|(k, v)| ((*k).into(), (*v).clone()))
                .collect(),
        ));
    }
    ordered(&component_peers)?;
    limit(raw.len(), limits.inventory_ids)?;
    let mut operand_ids = Vec::new();
    let mut used = BTreeSet::new();
    for o in list(get(&f, "operands")?)? {
        let of = exact(o, &["id", "appearance", "peers"], &[])?;
        let i = id(text(get(&of, "id")?)?)?;
        let a = id(text(get(&of, "appearance")?)?)?;
        let ps = ids(get(&of, "peers")?, true)?;
        require(
            !ps.is_empty()
                && ps
                    == eligible
                        .get(&i)
                        .map(|s| s.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
        )?;
        operand_ids.push(i);
        used.insert(a);
    }
    ordered(&operand_ids)?;
    require(used.len() == operand_ids.len() && eligible.len() == operand_ids.len())?;
    let mut exclusion_ids = Vec::new();
    for e in list(get(&f, "exclusions")?)? {
        let ef = exact(e, &["id", "peers", "reason"], &[])?;
        let i = id(text(get(&ef, "id")?)?)?;
        let ps = ids(get(&ef, "peers")?, true)?;
        require(
            !text(get(&ef, "reason")?)?.is_empty()
                && !eligible.contains_key(&i)
                && !ps.is_empty()
                && ps
                    == raw
                        .get(&i)
                        .map(|s| s.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
        )?;
        exclusion_ids.push(i);
    }
    ordered(&exclusion_ids)?;
    require(raw.len() == operand_ids.len() + exclusion_ids.len())?;
    require(
        content_address(&encode(&CborValue::Array(
            operand_ids.iter().map(|k| string(k)).collect(),
        ))) == membership
            && content_address(&encode(&CborValue::Array(
                used.iter().map(|k| string(k)).collect(),
            ))) == appearance_digest,
    )?;
    let expected = content_address(&encode(&CborValue::Map(
        vec![
            ("binding".into(), CborValue::Tstr(binding.clone())),
            ("authority".into(), CborValue::Tstr(authority.clone())),
            ("selection".into(), CborValue::Tstr(selection.clone())),
            ("components".into(), CborValue::Array(component_bases)),
            ("membership".into(), CborValue::Tstr(membership.clone())),
            (
                "appearanceDigest".into(),
                CborValue::Tstr(appearance_digest.clone()),
            ),
            ("exclusions".into(), get(&f, "exclusions")?.clone()),
        ]
        .into_iter()
        .chain(scope.as_ref().map(|_| ("scope".into(), f["scope"].clone())))
        .collect(),
    )));
    require(revision == expected)?;
    Ok(MaterializationCaptureBasis {
        binding,
        authority,
        selection,
        revision,
        serving_at,
        historical_cutoff,
        scope,
        membership,
        appearance_digest,
        snapshot,
    })
}
/// Private owned commitment: never created from caller-supplied decoded evidence.
pub(crate) struct CaptureBasisChecker {
    expected: Vec<u8>,
    maximum: usize,
}
impl CaptureBasisChecker {
    pub(crate) fn validate(&self, basis: &[u8]) -> Result<()> {
        canonical(basis, self.maximum)?;
        limit(self.expected.len(), self.maximum)?;
        require(self.expected == basis)
    }
}
pub(crate) fn decode_materialization_snapshot_evidence(
    input: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<(MaterializationSourceSnapshot, CaptureBasisChecker)> {
    let snapshot = decode_materialization_snapshot(input, limits)?;
    let expected = capture_basis(&snapshot, &content_address(input))?;
    Ok((
        snapshot,
        CaptureBasisChecker {
            expected,
            maximum: limits.artifact_bytes,
        },
    ))
}
pub fn materialization_capture_basis(
    snapshot_bytes: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<Vec<u8>> {
    let snapshot = decode_materialization_snapshot(snapshot_bytes, limits)?;
    let out = capture_basis(&snapshot, &content_address(snapshot_bytes))?;
    limit(out.len(), limits.artifact_bytes)?;
    Ok(out)
}
pub fn validate_materialization_capture_basis(
    basis_bytes: &[u8],
    snapshot_bytes: &[u8],
    limits: MaterializationSourceLimits,
) -> Result<()> {
    canonical(basis_bytes, limits.artifact_bytes)?;
    require(materialization_capture_basis(snapshot_bytes, limits)? == basis_bytes)
}
pub fn materialization_component_commitments(
    snapshot: &MaterializationSourceSnapshot,
) -> Result<CborValue> {
    Ok(CborValue::Array(
        snapshot
            .components
            .iter()
            .map(|c| {
                let fs = exact(
                    c,
                    &["peer", "revision", "capturedAt", "rawIds", "operandIds"],
                    &[],
                )?;
                Ok(map(["peer", "revision", "capturedAt"]
                    .into_iter()
                    .map(|k| Ok((k, get(&fs, k)?.clone())))
                    .collect::<Result<Vec<_>>>()?))
            })
            .collect::<Result<Vec<_>>>()?,
    ))
}

#[cfg(test)]
#[test]
fn capture_checker_owns_its_basis_after_native_source_mutation() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/source-snapshot.json"
    ))
    .unwrap();
    let f = fixtures["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "one")
        .unwrap();
    let mut raw = hex::decode(f["snapshotHex"].as_str().unwrap()).unwrap();
    let basis = hex::decode(f["basisHex"].as_str().unwrap()).unwrap();
    let (mut snapshot, checker) =
        decode_materialization_snapshot_evidence(&raw, Default::default()).unwrap();
    snapshot.deltas[0].claims.pointers.clear();
    snapshot.value = CborValue::Map(vec![]);
    snapshot.components.clear();
    raw.fill(0);
    checker.validate(&basis).unwrap();
    assert_eq!(checker.validate(&[0]).unwrap_err(), INVALID);
    // New calls always re-enter raw decode: no receipt/proof argument exists.
    assert!(decode_materialization_snapshot_evidence(&raw, Default::default()).is_err());
}
/// One peer's contribution to a produced capture (MR-10).
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationSourceComponentInput {
    pub peer: String,
    /// A host-attested identity covering this peer's inventory and authority (MR-10).
    pub revision: String,
    pub captured_at: f64,
    /// The operands this peer contributes: signed, admitted deltas.
    pub operands: Vec<Delta>,
    /// Ids this peer holds but does not contribute (raw only). An id no peer contributes must
    /// also be named in `exclusions`.
    pub held_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationSourceInput {
    pub binding: String,
    pub authority: String,
    /// The binding's selection map, exactly as its spec carries it.
    pub selection: CborValue,
    pub serving_at: f64,
    pub historical_cutoff: Option<f64>,
    /// A scoped capture's entities (SPEC-17 §7); operands must then be exactly S(scope).
    pub scope: Option<Vec<String>>,
    pub components: Vec<MaterializationSourceComponentInput>,
    /// (id, reason) for every id no peer contributes.
    pub exclusions: Vec<(String, String)>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ProducedMaterializationSource {
    pub snapshot_bytes: Vec<u8>,
    pub basis_bytes: Vec<u8>,
    pub revision: String,
}
/// Produce source-snapshot/1 and source-basis/1 bytes from a host's selection (MR-10, SPEC-17
/// §7). The host supplies what it selected and its testimony; the library owns the format, the
/// digests and the revision. The result is decoded once before it is returned, so a producer can
/// never emit bytes the decoder refuses.
pub fn produce_materialization_snapshot(
    input: &MaterializationSourceInput,
    limits: MaterializationSourceLimits,
) -> Result<ProducedMaterializationSource> {
    let mut components = input.components.clone();
    components.sort_by(|a, b| a.peer.cmp(&b.peer));
    // One appearance per operand id: the lexically least signature among the contributors (MR-10).
    let mut chosen: BTreeMap<String, (Delta, Vec<u8>, String)> = BTreeMap::new();
    let mut contributors: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut holders: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut component_maps = Vec::new();
    for c in &components {
        let mut ops = BTreeSet::new();
        for d in &c.operands {
            let bytes = encode_materialization_appearance(d, limits)?;
            let replace = chosen
                .get(&d.id)
                .is_none_or(|(held, _, _)| d.sig < held.sig);
            if replace {
                let key = content_address(&bytes);
                chosen.insert(d.id.clone(), (d.clone(), bytes, key));
            }
            contributors
                .entry(d.id.clone())
                .or_default()
                .insert(c.peer.clone());
            holders
                .entry(d.id.clone())
                .or_default()
                .insert(c.peer.clone());
            ops.insert(d.id.clone());
        }
        for x in &c.held_ids {
            holders.entry(x.clone()).or_default().insert(c.peer.clone());
        }
        let raws: BTreeSet<String> = ops.iter().cloned().chain(c.held_ids.clone()).collect();
        component_maps.push(map(vec![
            ("peer", string(&c.peer)),
            ("revision", string(&c.revision)),
            ("capturedAt", CborValue::Float(c.captured_at)),
            (
                "rawIds",
                CborValue::Array(raws.iter().map(|x| string(x)).collect()),
            ),
            (
                "operandIds",
                CborValue::Array(ops.iter().map(|x| string(x)).collect()),
            ),
        ]));
    }
    let strings = |xs: &BTreeSet<String>| CborValue::Array(xs.iter().map(|x| string(x)).collect());
    let operands: Vec<CborValue> = chosen
        .iter()
        .map(|(i, (_, _, key))| {
            map(vec![
                ("id", string(i)),
                ("appearance", string(key)),
                ("peers", strings(&contributors[i])),
            ])
        })
        .collect();
    let mut exclusions = input.exclusions.clone();
    exclusions.sort();
    let exclusions = CborValue::Array(
        exclusions
            .iter()
            .map(|(i, reason)| {
                map(vec![
                    ("id", string(i)),
                    ("peers", strings(holders.get(i).unwrap_or(&BTreeSet::new()))),
                    ("reason", string(reason)),
                ])
            })
            .collect(),
    );
    let keys: BTreeSet<String> = chosen.values().map(|(_, _, k)| k.clone()).collect();
    let membership = content_address(&encode(&CborValue::Array(
        chosen.keys().map(|k| string(k)).collect(),
    )));
    let appearance_digest = content_address(&encode(&CborValue::Array(
        keys.iter().map(|k| string(k)).collect(),
    )));
    let selection = content_address(&encode(&input.selection));
    let scope = input
        .scope
        .as_ref()
        .map(|xs| CborValue::Array(xs.iter().map(|x| string(x)).collect()));
    let bases = component_maps
        .iter()
        .map(|c| match c {
            CborValue::Map(fs) => CborValue::Map(
                fs.iter()
                    .filter(|(k, _)| k != "capturedAt")
                    .cloned()
                    .collect(),
            ),
            other => other.clone(),
        })
        .collect();
    let revision = content_address(&encode(&map(vec![
        ("binding", string(&input.binding)),
        ("authority", string(&input.authority)),
        ("selection", string(&selection)),
        ("components", CborValue::Array(bases)),
        ("membership", string(&membership)),
        ("appearanceDigest", string(&appearance_digest)),
        ("exclusions", exclusions.clone()),
    ]
    .into_iter()
    .chain(scope.clone().map(|s| ("scope", s)))
    .collect())));
    let by_key: BTreeMap<&String, &Vec<u8>> = chosen
        .values()
        .map(|(_, bytes, key)| (key, bytes))
        .collect();
    let mut fields = vec![
        ("format", string("rhizomatic.source-snapshot/1")),
        ("binding", string(&input.binding)),
        ("authority", string(&input.authority)),
        ("selection", string(&selection)),
        ("revision", string(&revision)),
        ("servingAt", CborValue::Float(input.serving_at)),
        ("components", CborValue::Array(component_maps)),
        ("operands", CborValue::Array(operands)),
        ("exclusions", exclusions),
        ("membership", string(&membership)),
        ("appearanceDigest", string(&appearance_digest)),
        (
            "appearances",
            CborValue::Array(
                keys.iter()
                    .map(|k| {
                        map(vec![
                            ("key", string(k)),
                            ("value", CborValue::Bstr(by_key[k].clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ];
    if let Some(cutoff) = input.historical_cutoff {
        fields.push(("historicalCutoff", CborValue::Float(cutoff)));
    }
    if let Some(scope) = scope {
        fields.push(("scope", scope));
    }
    let snapshot_bytes = encode(&map(fields));
    let basis_bytes = materialization_capture_basis(&snapshot_bytes, limits)?;
    Ok(ProducedMaterializationSource {
        snapshot_bytes,
        basis_bytes,
        revision,
    })
}
