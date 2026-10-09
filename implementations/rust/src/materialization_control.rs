//! SPEC-16 MR-13/14/16/17: normalized maintained selections, the canonical control image codec
//! and the pure conditional transition planner. Input is already verified by command; this owner
//! validates structure and lifetime only. Caches, sources and signing live elsewhere.
use crate::cbor::{decode, encode, CborValue};
use crate::hash::content_address;
use std::collections::BTreeMap;

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// Existing content address spelling: `1e20` plus 64 lowercase hex digits (MR-04).
fn is_content_id(s: &str) -> bool {
    s.strip_prefix("1e20").is_some_and(is_hex64)
}
/// Existing peer key spelling: `ed25519:` plus 64 lowercase hex digits (MR-04).
fn is_author(s: &str) -> bool {
    s.strip_prefix("ed25519:").is_some_and(is_hex64)
}

pub const MATERIALIZATION_CONTROL_FORMAT: &str = "rhizomatic.materialization-control/1";
/// External name of the initialized empty generation-0 image (MR-14).
pub const MATERIALIZATION_CONTROL_EMPTY_REVISION: &str = "";
const MAX_GENERATION: f64 = 9007199254740991.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationControlError {
    InvalidControl,
    ResourceLimit,
}
impl std::fmt::Display for MaterializationControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidControl => "invalid-control",
            Self::ResourceLimit => "resource-limit",
        })
    }
}
impl std::error::Error for MaterializationControlError {}
type Result<T> = std::result::Result<T, MaterializationControlError>;
const INVALID: MaterializationControlError = MaterializationControlError::InvalidControl;
fn require(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(INVALID)
    }
}
fn limit(n: usize, max: usize) -> Result<()> {
    if n > max {
        Err(MaterializationControlError::ResourceLimit)
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MaterializationControlLimits {
    pub artifact_bytes: usize,
    pub registrations: usize,
    pub definitions: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationControlStatus {
    Active,
    Retired,
}
impl MaterializationControlStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Retired => "retired",
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationControlEntry {
    pub registration: String,
    pub status: MaterializationControlStatus,
    pub transition: String,
    pub source_revision: String,
    pub authority: String,
    pub at: f64,
    pub definition_at: f64,
    pub hyperschema_pin: String,
    pub schema_pin: String,
    pub capture: Option<String>,
}
/// Flat decoded image: entries sorted by registration, deltas keyed by full appearance key.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationControlImage {
    pub receiver: String,
    pub configuration: String,
    pub generation: f64,
    pub entries: Vec<MaterializationControlEntry>,
    pub deltas: BTreeMap<String, Vec<u8>>,
}
/// Normalized selection: each entry names the support it keeps reachable (MR-14).
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationControlSelection {
    pub receiver: String,
    pub configuration: String,
    pub generation: f64,
    pub entries: BTreeMap<String, MaterializationControlSelected>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationControlSelected {
    pub entry: MaterializationControlEntry,
    pub support: BTreeMap<String, Vec<u8>>,
}

/// Full appearance transport key: H(C(Appearance)) over the exact stored bytes.
pub fn materialization_appearance_key(bytes: &[u8]) -> String {
    content_address(bytes)
}
pub fn empty_materialization_control(
    receiver: &str,
    configuration: &str,
) -> Result<MaterializationControlSelection> {
    require(is_author(receiver) && is_content_id(configuration))?;
    Ok(MaterializationControlSelection {
        receiver: receiver.into(),
        configuration: configuration.into(),
        generation: 0.0,
        entries: BTreeMap::new(),
    })
}
fn check_entry(e: &MaterializationControlEntry) -> Result<()> {
    for id in [
        &e.registration,
        &e.transition,
        &e.source_revision,
        &e.authority,
        &e.hyperschema_pin,
        &e.schema_pin,
    ] {
        require(is_content_id(id))?;
    }
    require(e.at.is_finite() && e.definition_at.is_finite())?;
    match (e.status, &e.capture) {
        (MaterializationControlStatus::Active, Some(c)) => require(is_content_id(c)),
        (MaterializationControlStatus::Retired, None) => Ok(()),
        _ => Err(INVALID),
    }
}
fn encode_entry(e: &MaterializationControlEntry) -> CborValue {
    let s = |v: &str| CborValue::Tstr(v.into());
    let mut fs = vec![
        ("registration".to_string(), s(&e.registration)),
        ("status".into(), s(e.status.as_str())),
        ("transition".into(), s(&e.transition)),
        ("sourceRevision".into(), s(&e.source_revision)),
        ("authority".into(), s(&e.authority)),
        ("at".into(), CborValue::Float(e.at)),
        ("definitionAt".into(), CborValue::Float(e.definition_at)),
        ("hyperschemaPin".into(), s(&e.hyperschema_pin)),
        ("schemaPin".into(), s(&e.schema_pin)),
    ];
    if let Some(c) = &e.capture {
        fs.push(("capture".into(), s(c)));
    }
    CborValue::Map(fs)
}
fn check_generation(generation: f64, entry_count: usize) -> Result<()> {
    require(
        generation.is_finite()
            && (0.0..=MAX_GENERATION).contains(&generation)
            && generation.fract() == 0.0,
    )?;
    require((generation == 0.0) == (entry_count == 0))
}

/// Derive the flat image from a selection: deltas are the distinct reachable union.
pub fn materialization_control_image(
    selection: &MaterializationControlSelection,
    limits: &MaterializationControlLimits,
) -> Result<MaterializationControlImage> {
    require(is_author(&selection.receiver) && is_content_id(&selection.configuration))?;
    limit(selection.entries.len(), limits.registrations)?;
    check_generation(selection.generation, selection.entries.len())?;
    let mut deltas: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut entries = Vec::new();
    for (registration, selected) in &selection.entries {
        let e = &selected.entry;
        require(registration == &e.registration)?;
        check_entry(e)?;
        // Support is opaque here; command binds the single retired act to entry.transition.
        if e.status == MaterializationControlStatus::Retired {
            require(selected.support.len() == 1)?;
        }
        for (key, bytes) in &selected.support {
            require(&materialization_appearance_key(bytes) == key)?;
            if let Some(old) = deltas.get(key) {
                require(old == bytes)?;
            }
            deltas.insert(key.clone(), bytes.clone());
        }
        entries.push(e.clone());
    }
    Ok(MaterializationControlImage {
        receiver: selection.receiver.clone(),
        configuration: selection.configuration.clone(),
        generation: selection.generation,
        entries,
        deltas,
    })
}
pub fn encode_materialization_control(
    image: &MaterializationControlImage,
    limits: &MaterializationControlLimits,
) -> Result<Vec<u8>> {
    require(is_author(&image.receiver) && is_content_id(&image.configuration))?;
    limit(image.entries.len(), limits.registrations)?;
    check_generation(image.generation, image.entries.len())?;
    limit(
        image.deltas.len(),
        limits.registrations * (limits.definitions + 4),
    )?;
    for (i, e) in image.entries.iter().enumerate() {
        check_entry(e)?;
        if i > 0 {
            require(image.entries[i - 1].registration < e.registration)?;
        }
    }
    for (key, bytes) in &image.deltas {
        limit(bytes.len(), limits.artifact_bytes)?;
        require(&materialization_appearance_key(bytes) == key)?;
    }
    let bytes = encode(&CborValue::Map(vec![
        (
            "format".into(),
            CborValue::Tstr(MATERIALIZATION_CONTROL_FORMAT.into()),
        ),
        ("receiver".into(), CborValue::Tstr(image.receiver.clone())),
        (
            "configuration".into(),
            CborValue::Tstr(image.configuration.clone()),
        ),
        ("generation".into(), CborValue::Float(image.generation)),
        (
            "entries".into(),
            CborValue::Array(image.entries.iter().map(encode_entry).collect()),
        ),
        (
            "deltas".into(),
            CborValue::Array(
                image
                    .deltas
                    .values()
                    .map(|b| CborValue::Bstr(b.clone()))
                    .collect(),
            ),
        ),
    ]));
    limit(bytes.len(), limits.artifact_bytes)?;
    Ok(bytes)
}
fn fields<'a>(
    v: &'a CborValue,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<&'a str, &'a CborValue>> {
    let CborValue::Map(entries) = v else {
        return Err(INVALID);
    };
    let mut fs = BTreeMap::new();
    for (k, x) in entries {
        require(!fs.contains_key(k.as_str()))?;
        require(required.contains(&k.as_str()) || optional.contains(&k.as_str()))?;
        fs.insert(k.as_str(), x);
    }
    require(required.iter().all(|k| fs.contains_key(k)))?;
    Ok(fs)
}
fn text<'a>(fs: &BTreeMap<&str, &'a CborValue>, k: &str) -> Result<&'a str> {
    match fs.get(k) {
        Some(CborValue::Tstr(s)) => Ok(s),
        _ => Err(INVALID),
    }
}
fn id(fs: &BTreeMap<&str, &CborValue>, k: &str) -> Result<String> {
    let s = text(fs, k)?;
    require(is_content_id(s))?;
    Ok(s.into())
}
fn number(fs: &BTreeMap<&str, &CborValue>, k: &str) -> Result<f64> {
    match fs.get(k) {
        Some(CborValue::Float(n)) if n.is_finite() => Ok(*n),
        _ => Err(INVALID),
    }
}
/// Strict bounded decode with exact re-encoding; count bounds precede allocation.
pub fn decode_materialization_control(
    input: &[u8],
    limits: &MaterializationControlLimits,
) -> Result<MaterializationControlImage> {
    limit(input.len(), limits.artifact_bytes)?;
    // Exact re-encoding below is the canonical-form check; duplicate keys fail in `fields`.
    let value = decode(input).map_err(|_| INVALID)?;
    let fs = fields(
        &value,
        &[
            "format",
            "receiver",
            "configuration",
            "generation",
            "entries",
            "deltas",
        ],
        &[],
    )?;
    require(text(&fs, "format")? == MATERIALIZATION_CONTROL_FORMAT)?;
    let receiver = text(&fs, "receiver")?.to_string();
    require(is_author(&receiver))?;
    let configuration = id(&fs, "configuration")?;
    let generation = number(&fs, "generation")?;
    let (Some(CborValue::Array(raw_entries)), Some(CborValue::Array(raw_deltas))) =
        (fs.get("entries"), fs.get("deltas"))
    else {
        return Err(INVALID);
    };
    limit(raw_entries.len(), limits.registrations)?;
    limit(
        raw_deltas.len(),
        limits.registrations * (limits.definitions + 4),
    )?;
    let mut entries = Vec::with_capacity(raw_entries.len());
    for e in raw_entries {
        let f = fields(
            e,
            &[
                "registration",
                "status",
                "transition",
                "sourceRevision",
                "authority",
                "at",
                "definitionAt",
                "hyperschemaPin",
                "schemaPin",
            ],
            &["capture"],
        )?;
        let status = match text(&f, "status")? {
            "active" => MaterializationControlStatus::Active,
            "retired" => MaterializationControlStatus::Retired,
            _ => return Err(INVALID),
        };
        let entry = MaterializationControlEntry {
            registration: id(&f, "registration")?,
            status,
            transition: id(&f, "transition")?,
            source_revision: id(&f, "sourceRevision")?,
            authority: id(&f, "authority")?,
            at: number(&f, "at")?,
            definition_at: number(&f, "definitionAt")?,
            hyperschema_pin: id(&f, "hyperschemaPin")?,
            schema_pin: id(&f, "schemaPin")?,
            capture: if f.contains_key("capture") {
                Some(id(&f, "capture")?)
            } else {
                None
            },
        };
        check_entry(&entry)?;
        entries.push(entry);
    }
    let mut deltas = BTreeMap::new();
    for d in raw_deltas {
        let CborValue::Bstr(bytes) = d else {
            return Err(INVALID);
        };
        deltas.insert(materialization_appearance_key(bytes), bytes.clone());
    }
    let image = MaterializationControlImage {
        receiver,
        configuration,
        generation,
        entries,
        deltas,
    };
    require(encode_materialization_control(&image, limits)? == input)?;
    Ok(image)
}
/// External revision name: empty text for generation 0, else H(imageBytes).
pub fn materialization_control_revision(bytes: &[u8], generation: f64) -> String {
    if generation == 0.0 {
        MATERIALIZATION_CONTROL_EMPTY_REVISION.into()
    } else {
        content_address(bytes)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationControlActive {
    pub registration: String,
    pub source_revision: String,
    pub authority: String,
    pub at: f64,
    pub definition_at: f64,
    pub hyperschema_pin: String,
    pub schema_pin: String,
    pub capture: String,
}
#[derive(Debug, Clone, PartialEq)]
pub enum MaterializationControlTransition {
    Install {
        entry: MaterializationControlActive,
        transition: String,
        /// Descriptor, complete definition closure, capture, authority and the transition act.
        support: BTreeMap<String, Vec<u8>>,
    },
    ReplaceSource {
        registration: String,
        source_revision: String,
        authority: String,
        capture: String,
        transition: String,
        /// Replacement capture, authority and transition acts.
        support: BTreeMap<String, Vec<u8>>,
        /// Keys of the superseded capture, authority and transition acts.
        superseded: Vec<String>,
    },
    AdvanceTime {
        registration: String,
        at: f64,
        transition: String,
        support: BTreeMap<String, Vec<u8>>,
        superseded: Vec<String>,
    },
    Retire {
        registration: String,
        transition: String,
        /// The terminal retire transition act only.
        support: BTreeMap<String, Vec<u8>>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializationControlRefusal {
    ResourceLimit,
    RegistrationMissing,
    Retired,
    AlreadyInstalled,
    TimeRegression,
}
impl MaterializationControlRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::ResourceLimit => "resource-limit",
            Self::RegistrationMissing => "registration-missing",
            Self::Retired => "retired",
            Self::AlreadyInstalled => "already-installed",
            Self::TimeRegression => "time-regression",
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum MaterializationControlPlan {
    Planned(MaterializationControlSelection),
    Refused(MaterializationControlRefusal),
}
fn with_support(
    support: &BTreeMap<String, Vec<u8>>,
    superseded: &[String],
    add: &BTreeMap<String, Vec<u8>>,
) -> BTreeMap<String, Vec<u8>> {
    let mut out: BTreeMap<String, Vec<u8>> = support
        .iter()
        .filter(|(k, _)| !superseded.contains(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in add {
        out.insert(k.clone(), v.clone());
    }
    out
}
/// Pure conditional planner: returns the prospective selection or the MR-16 known refusal.
pub fn plan_materialization_control(
    current: &MaterializationControlSelection,
    transition: &MaterializationControlTransition,
    limits: &MaterializationControlLimits,
) -> Result<MaterializationControlPlan> {
    use MaterializationControlPlan::Refused;
    use MaterializationControlRefusal as R;
    use MaterializationControlTransition as T;
    let registration = match transition {
        T::Install { entry, .. } => &entry.registration,
        T::ReplaceSource { registration, .. }
        | T::AdvanceTime { registration, .. }
        | T::Retire { registration, .. } => registration,
    };
    let existing = current.entries.get(registration);
    match (transition, existing) {
        (T::Install { .. }, Some(x)) => {
            return Ok(Refused(
                if x.entry.status == MaterializationControlStatus::Retired {
                    R::Retired
                } else {
                    R::AlreadyInstalled
                },
            ))
        }
        (T::Install { .. }, None) => {
            if current.entries.len() + 1 > limits.registrations {
                return Ok(Refused(R::ResourceLimit));
            }
        }
        (_, None) => return Ok(Refused(R::RegistrationMissing)),
        (_, Some(x)) if x.entry.status == MaterializationControlStatus::Retired => {
            return Ok(Refused(R::Retired))
        }
        (T::AdvanceTime { at, .. }, Some(x)) if *at < x.entry.at => {
            return Ok(Refused(R::TimeRegression))
        }
        _ => {}
    }
    let generation = current.generation + 1.0;
    if generation > MAX_GENERATION {
        return Ok(Refused(R::ResourceLimit));
    }
    let support = match transition {
        T::Install { support, .. }
        | T::ReplaceSource { support, .. }
        | T::AdvanceTime { support, .. }
        | T::Retire { support, .. } => support,
    };
    for (k, bytes) in support {
        require(&materialization_appearance_key(bytes) == k)?;
    }
    let mut entries = current.entries.clone();
    let selected = match transition {
        T::Install {
            entry: e,
            transition,
            support,
        } => {
            let entry = MaterializationControlEntry {
                registration: e.registration.clone(),
                status: MaterializationControlStatus::Active,
                transition: transition.clone(),
                source_revision: e.source_revision.clone(),
                authority: e.authority.clone(),
                at: e.at,
                definition_at: e.definition_at,
                hyperschema_pin: e.hyperschema_pin.clone(),
                schema_pin: e.schema_pin.clone(),
                capture: Some(e.capture.clone()),
            };
            check_entry(&entry)?;
            MaterializationControlSelected {
                entry,
                support: support.clone(),
            }
        }
        T::Retire {
            transition,
            support,
            ..
        } => {
            require(support.len() == 1)?;
            let mut entry = existing.unwrap().entry.clone();
            entry.status = MaterializationControlStatus::Retired;
            entry.capture = None;
            entry.transition = transition.clone();
            MaterializationControlSelected {
                entry,
                support: support.clone(),
            }
        }
        T::ReplaceSource {
            source_revision,
            authority,
            capture,
            transition,
            support,
            superseded,
            ..
        } => {
            let x = existing.unwrap();
            let mut entry = x.entry.clone();
            entry.source_revision = source_revision.clone();
            entry.authority = authority.clone();
            entry.capture = Some(capture.clone());
            entry.transition = transition.clone();
            check_entry(&entry)?;
            MaterializationControlSelected {
                entry,
                support: with_support(&x.support, superseded, support),
            }
        }
        T::AdvanceTime {
            at,
            transition,
            support,
            superseded,
            ..
        } => {
            let x = existing.unwrap();
            let mut entry = x.entry.clone();
            entry.at = *at;
            entry.transition = transition.clone();
            check_entry(&entry)?;
            MaterializationControlSelected {
                entry,
                support: with_support(&x.support, superseded, support),
            }
        }
    };
    entries.insert(registration.clone(), selected);
    Ok(MaterializationControlPlan::Planned(
        MaterializationControlSelection {
            receiver: current.receiver.clone(),
            configuration: current.configuration.clone(),
            generation,
            entries,
        },
    ))
}
