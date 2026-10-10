//! SPEC-16 MR-13..18: the six maintained verbs. Stage 5 reads and classifies the durable control
//! image, stage 6 checks the explicit source, stage 7 the stored or supplied program, stage 8
//! computes every root and the prospective transition and image, and stage 9 performs the CAS.
//! Nothing here reaches a store except through the explicit boot capability.
use crate::cbor::{encode, CborValue};
use crate::delta::canonical_bytes;
use crate::eval::{bind_program_reading, eval_materialization_term_at, EvalResult};
use crate::hash::content_address;
use crate::materialization_basis::{
    definitions_program, gather_basis, BasisProgram, DefinitionProgramInput,
};
use crate::materialization_command::{MaterializationDiagnostic, MaterializationSigner};
use crate::materialization_data::{
    materialization_bytes, materialization_description_claims, materialization_number,
    materialization_ref, materialization_text, read_materialization_description,
    MaterializationFields, MaterializationLimits, MaterializationVerb,
};
use crate::materialization_evidence::missing_reading;
use crate::materialization_input::{valid_at, InputCatalog, PreparedInput};
use crate::materialization_peer::{
    decode_materialization_control, empty_materialization_control, encode_materialization_control,
    materialization_appearance_key, materialization_control_image,
    materialization_control_revision, plan_materialization_control, MaterializationControlActive,
    MaterializationControlEntry, MaterializationControlImage, MaterializationControlInitialize,
    MaterializationControlLimits, MaterializationControlPlan, MaterializationControlSelected,
    MaterializationControlSelection, MaterializationControlStatus, MaterializationControlStore,
    MaterializationControlTransition, MaterializationControlWrite,
};
use crate::materialization_source::{
    decode_materialization_appearance, decode_materialization_authority_spec,
    decode_materialization_binding_spec, decode_materialization_snapshot_evidence,
    encode_materialization_appearance, MaterializationSourceCapability,
    MaterializationSourceFailure, MaterializationSourceSnapshot,
};
use crate::materialization_values::{
    cbor, envelope_limits, limit, map, require, s, source_limits, Result,
};
use crate::resolution::{resolve_view, view_canonical_hex};
use crate::resolve_evidence::{encode_hview_envelope, hview_canonical_hex};
use crate::set::DeltaSet;
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::{Delta, DeltaRef, Primitive, Target};
use std::collections::{BTreeMap, BTreeSet};

/// A host fault hook: receives the confirmed control revision and may report a known failure.
pub type MaterializationFaultHook<'a> = Box<dyn Fn(&str) -> std::result::Result<(), String> + 'a>;
/// Named post-CAS fault point (MR-16): a host may inject a known failure after confirmed CAS.
#[derive(Default)]
pub struct MaterializationLifecycleHooks<'a> {
    pub post_cas_result_materialization: Option<MaterializationFaultHook<'a>>,
}
pub(crate) struct LifecycleHost<'h, 'a> {
    pub catalog: &'h InputCatalog,
    pub signer: &'h dyn MaterializationSigner,
    pub grants: &'h mut BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
    pub store: &'h mut dyn MaterializationControlStore,
    pub hooks: &'h MaterializationLifecycleHooks<'a>,
    pub diagnostic: &'h MaterializationDiagnostic<'a>,
}
pub(crate) enum LifecycleOutcome {
    Completed(CborValue),
    Indeterminate(CborValue),
}
pub(crate) fn is_lifecycle_verb(v: MaterializationVerb) -> bool {
    !matches!(
        v,
        MaterializationVerb::Gather | MaterializationVerb::Resolve
    )
}

/// Normalized registration descriptor fields (MR-13).
#[derive(Debug, Clone)]
pub(crate) struct Descriptor {
    pub delta: Delta,
    pub binding: String,
    pub hyper: String,
    pub hyper_pin: String,
    pub reading: String,
    pub reading_pin: String,
    pub definitions: Vec<String>,
    pub roots: Vec<String>,
    pub bindings: Vec<u8>,
    pub definition_at: f64,
}
pub(crate) fn read_registration_descriptor(delta: &Delta) -> Option<Descriptor> {
    let f = read_materialization_description(delta, None).ok()?;
    if materialization_text(&f, "kind").ok()? != "registration/1" {
        return None;
    }
    let one =
        |t: &Target| materialization_ref(&BTreeMap::from([("x".into(), vec![t.clone()])]), "x");
    let definitions = f
        .get("definition")
        .into_iter()
        .flatten()
        .map(one)
        .collect::<Result<Vec<_>>>()
        .ok()?;
    let roots = f
        .get("roots")
        .into_iter()
        .flatten()
        .map(|t| match t {
            Target::Entity(e) => Ok(e.id.clone()),
            _ => Err("invalid-arguments".to_string()),
        })
        .collect::<Result<Vec<_>>>()
        .ok()?;
    Some(Descriptor {
        delta: delta.clone(),
        binding: materialization_ref(&f, "source-binding").ok()?,
        hyper: materialization_ref(&f, "hyperschema").ok()?,
        hyper_pin: materialization_text(&f, "hyperschema-pin").ok()?,
        reading: materialization_ref(&f, "schema").ok()?,
        reading_pin: materialization_text(&f, "schema-pin").ok()?,
        definitions,
        roots,
        bindings: materialization_bytes(&f, "bindings").ok()?,
        definition_at: materialization_number(&f, "definition-at").ok()?,
    })
}
/// Closure IDs a descriptor names: both top acts and every definition support (MR-11).
pub(crate) fn descriptor_closure(d: &Descriptor) -> Vec<String> {
    let mut ids = vec![d.hyper.clone(), d.reading.clone()];
    ids.extend(d.definitions.iter().cloned());
    ids.sort();
    ids
}

/// One active entry's verified stored support after restore classification (MR-17).
pub(crate) struct StoredEntry {
    pub entry: MaterializationControlEntry,
    pub transition: Delta,
    pub descriptor: Option<Descriptor>,
    pub definitions: Vec<Delta>,
    pub capture: Option<Delta>,
    pub authority: Option<Delta>,
    pub support: BTreeMap<String, Vec<u8>>,
}
pub(crate) struct ControlState {
    pub revision: String,
    pub image: MaterializationControlImage,
    pub selection: MaterializationControlSelection,
    pub stored: BTreeMap<String, StoredEntry>,
}
fn control_limits(l: &MaterializationLimits) -> MaterializationControlLimits {
    MaterializationControlLimits {
        artifact_bytes: l["artifactBytes"],
        registrations: l["registrations"],
        definitions: l["definitions"],
    }
}
const INVALID_CONTROL: &str = "invalid-control";
/// The source commitments a capture basis carries (MR-10); the bytes are canonical CBOR.
fn capture_commitments(
    basis: &[u8],
    limits: &MaterializationLimits,
) -> Result<(String, String, String)> {
    let decoded = cbor(basis, limits["artifactBytes"], INVALID_CONTROL)?;
    let CborValue::Map(fs) = &decoded else {
        return Err(INVALID_CONTROL.into());
    };
    let text = |k: &str| -> Result<String> {
        match fs.iter().find(|(key, _)| key == k) {
            Some((_, CborValue::Tstr(s))) => Ok(s.clone()),
            _ => Err(INVALID_CONTROL.into()),
        }
    };
    require(
        text("format")? == "rhizomatic.source-basis/1",
        INVALID_CONTROL,
    )?;
    Ok((text("revision")?, text("binding")?, text("authority")?))
}

struct Act {
    delta: Delta,
    key: String,
    fields: Option<MaterializationFields>,
}
/// Stage 5: read, decode and classify the complete image; every reachable support is exact.
fn read_control(host: &mut LifecycleHost) -> Result<ControlState> {
    let c = host.catalog;
    let (bytes, named) = match host
        .store
        .read(&c.receiver, &c.configuration.id)
        .map_err(|_| "control-unavailable")?
    {
        crate::materialization_peer::MaterializationControlRead::Image { bytes, revision } => {
            (bytes, revision)
        }
        _ => return Err("control-unavailable".into()),
    };
    let state = classify_control(&bytes, &c.receiver, &c.configuration.id, &c.limits)?;
    require(named == state.revision, INVALID_CONTROL)?;
    Ok(state)
}
/// Pure stage-5 classification of one control image (MR-17): decode, verify every reachable
/// appearance exactly, and derive the stored entries. Readback (MR-20) shares this reader.
pub(crate) fn classify_control(
    bytes: &[u8],
    receiver: &str,
    configuration: &str,
    limits: &MaterializationLimits,
) -> Result<ControlState> {
    let image = decode_materialization_control(bytes, &control_limits(limits))
        .map_err(|e| e.to_string())?;
    require(
        image.receiver == receiver && image.configuration == configuration,
        INVALID_CONTROL,
    )?;
    let revision = materialization_control_revision(bytes, image.generation);
    // Decode every appearance once; signatures and canonical bytes are verified here.
    let mut acts: BTreeMap<String, Act> = BTreeMap::new();
    let mut by_id: BTreeMap<String, String> = BTreeMap::new();
    for (key, raw) in &image.deltas {
        let delta = decode_materialization_appearance(raw, source_limits(limits)).map_err(|e| {
            if e.to_string() == "resource-limit" {
                "resource-limit".to_string()
            } else {
                INVALID_CONTROL.to_string()
            }
        })?;
        require(!by_id.contains_key(&delta.id), INVALID_CONTROL)?;
        by_id.insert(delta.id.clone(), key.clone());
        let fields = read_materialization_description(&delta, None).ok();
        acts.insert(
            key.clone(),
            Act {
                delta,
                key: key.clone(),
                fields,
            },
        );
    }
    let act = |id: &str| by_id.get(id).and_then(|k| acts.get(k));
    let mut stored = BTreeMap::new();
    let mut reachable = BTreeSet::new();
    let mut latest = 0.0_f64;
    let mut generations = BTreeSet::new();
    for entry in &image.entries {
        let t = act(&entry.transition).ok_or(INVALID_CONTROL)?;
        let tf = t.fields.as_ref().ok_or(INVALID_CONTROL)?;
        require(
            materialization_text(tf, "kind")? == "state/1",
            INVALID_CONTROL,
        )?;
        let generation = materialization_number(tf, "generation")?;
        let capture = if tf.contains_key("capture") {
            Some(materialization_ref(tf, "capture")?)
        } else {
            None
        };
        require(
            t.delta.claims.author == receiver
                && materialization_ref(tf, "registration")? == entry.registration
                && (materialization_text(tf, "verb")? == "retire")
                    == (entry.status == MaterializationControlStatus::Retired)
                && materialization_text(tf, "source-revision")? == entry.source_revision
                && materialization_text(tf, "authority")? == entry.authority
                && materialization_number(tf, "at")? == entry.at
                && materialization_number(tf, "definition-at")? == entry.definition_at
                && materialization_text(tf, "hyperschema-pin")? == entry.hyperschema_pin
                && materialization_text(tf, "schema-pin")? == entry.schema_pin
                && capture == entry.capture
                && generation <= image.generation
                && generations.insert(generation.to_bits()),
            INVALID_CONTROL,
        )?;
        latest = latest.max(generation);
        let mut support = BTreeMap::from([(t.key.clone(), image.deltas[&t.key].clone())]);
        reachable.insert(t.key.clone());
        if entry.status == MaterializationControlStatus::Retired {
            stored.insert(
                entry.registration.clone(),
                StoredEntry {
                    entry: entry.clone(),
                    transition: t.delta.clone(),
                    descriptor: None,
                    definitions: vec![],
                    capture: None,
                    authority: None,
                    support,
                },
            );
            continue;
        }
        let d = act(&entry.registration).ok_or(INVALID_CONTROL)?;
        let descriptor = read_registration_descriptor(&d.delta).ok_or(INVALID_CONTROL)?;
        require(
            descriptor.hyper_pin == entry.hyperschema_pin
                && descriptor.reading_pin == entry.schema_pin
                && descriptor.definition_at == entry.definition_at,
            INVALID_CONTROL,
        )?;
        limit(descriptor.roots.len(), limits["roots"])?;
        support.insert(d.key.clone(), image.deltas[&d.key].clone());
        reachable.insert(d.key.clone());
        let mut definitions = Vec::new();
        for id in descriptor_closure(&descriptor) {
            let a = act(&id).ok_or(INVALID_CONTROL)?;
            definitions.push(a.delta.clone());
            support.insert(a.key.clone(), image.deltas[&a.key].clone());
            reachable.insert(a.key.clone());
        }
        let cap = act(entry.capture.as_deref().ok_or(INVALID_CONTROL)?).ok_or(INVALID_CONTROL)?;
        let cf = cap.fields.as_ref().ok_or(INVALID_CONTROL)?;
        require(
            materialization_text(cf, "kind")? == "capture/1"
                && materialization_ref(cf, "source-binding")? == descriptor.binding,
            INVALID_CONTROL,
        )?;
        let auth = act(&materialization_ref(cf, "authority")?).ok_or(INVALID_CONTROL)?;
        let af = auth.fields.as_ref().ok_or(INVALID_CONTROL)?;
        require(
            materialization_text(af, "kind")? == "authority/1" && auth.delta.id == entry.authority,
            INVALID_CONTROL,
        )?;
        // MR-17: the stored capture commits to the entry's source revision, binding and authority.
        let (revision, binding, authority) =
            capture_commitments(&materialization_bytes(cf, "basis")?, limits)?;
        require(
            revision == entry.source_revision
                && binding == descriptor.binding
                && authority == entry.authority,
            INVALID_CONTROL,
        )?;
        support.insert(cap.key.clone(), image.deltas[&cap.key].clone());
        support.insert(auth.key.clone(), image.deltas[&auth.key].clone());
        reachable.insert(cap.key.clone());
        reachable.insert(auth.key.clone());
        stored.insert(
            entry.registration.clone(),
            StoredEntry {
                entry: entry.clone(),
                transition: t.delta.clone(),
                descriptor: Some(descriptor),
                definitions,
                capture: Some(cap.delta.clone()),
                authority: Some(auth.delta.clone()),
                support,
            },
        );
    }
    require(
        image.entries.is_empty() || latest == image.generation,
        INVALID_CONTROL,
    )?;
    require(reachable.len() == image.deltas.len(), INVALID_CONTROL)?;
    let selection = MaterializationControlSelection {
        receiver: image.receiver.clone(),
        configuration: image.configuration.clone(),
        generation: image.generation,
        entries: stored
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    MaterializationControlSelected {
                        entry: v.entry.clone(),
                        support: v.support.clone(),
                    },
                )
            })
            .collect(),
    };
    Ok(ControlState {
        revision,
        image,
        selection,
        stored,
    })
}

struct SourceCheck {
    binding: String,
    snapshot: MaterializationSourceSnapshot,
    capture: Delta,
    authority: Delta,
}
/// Stage 6 for a maintained verb: grant, binding, supplied or committed snapshot, authority.
fn check_source(
    host: &LifecycleHost,
    p: &PreparedInput,
    descriptor: &Descriptor,
    stored: Option<&StoredEntry>,
    received_at: f64,
) -> Result<SourceCheck> {
    require(
        host.grants.contains_key(&descriptor.binding),
        "unauthorized",
    )?;
    check_source_structure(host.catalog, p, descriptor, stored, received_at)
}
/// The supplied-input half of stage 6: everything but the native grant and current check.
fn check_source_structure(
    c: &InputCatalog,
    p: &PreparedInput,
    descriptor: &Descriptor,
    stored: Option<&StoredEntry>,
    received_at: f64,
) -> Result<SourceCheck> {
    let binding = c.bindings.get(&descriptor.binding).ok_or("unauthorized")?;
    require(valid_at(binding, received_at), "configuration-mismatch")?;
    let fresh = matches!(
        p.verb,
        MaterializationVerb::Install | MaterializationVerb::ReplaceSource
    );
    let validate = || -> Result<SourceCheck> {
        let b = read_materialization_description(binding, None)?;
        let spec = decode_materialization_binding_spec(
            &materialization_bytes(&b, "spec")?,
            c.limits["artifactBytes"],
        )
        .map_err(|e| e.to_string())?;
        let capture = if fresh {
            p.capture.clone().ok_or("invalid-source")?
        } else {
            stored
                .and_then(|s| s.capture.clone())
                .ok_or("invalid-source")?
        };
        let cf = read_materialization_description(&capture, None)?;
        let authority = if fresh {
            p.supplied
                .get(&materialization_ref(&cf, "authority")?)
                .cloned()
                .ok_or("invalid-source")?
        } else {
            stored
                .and_then(|s| s.authority.clone())
                .ok_or("invalid-source")?
        };
        let af = read_materialization_description(&authority, None)?;
        require(
            materialization_text(&af, "kind")? == "authority/1",
            "invalid-source",
        )?;
        let auth = decode_materialization_authority_spec(
            &materialization_bytes(&af, "spec")?,
            c.limits["artifactBytes"],
        )
        .map_err(|e| e.to_string())?;
        let (snap, checker) = decode_materialization_snapshot_evidence(
            p.snapshot_bytes.as_ref().ok_or("invalid-source")?,
            source_limits(&c.limits),
        )
        .map_err(|e| e.to_string())?;
        require(
            capture.claims.author == spec.capturer
                && authority.claims.author == spec.capturer
                && materialization_ref(&af, "source-binding")? == descriptor.binding
                && materialization_ref(&cf, "source-binding")? == descriptor.binding
                && snap.binding == descriptor.binding
                && snap.authority == authority.id
                && auth.root == spec.authority_root
                && snap.selection == content_address(&encode(&spec.selection))
                && capture.claims.timestamp == snap.serving_at
                && capture.claims.valid_from == snap.serving_at
                && valid_at(&capture, snap.serving_at)
                && valid_at(&authority, received_at)
                && snap.historical_cutoff.is_none(),
            "invalid-source",
        )?;
        // The committed capture commits to the exact snapshot bytes (MR-10); a fresh carrier may
        // carry them, and a replacement capture must stay on the same binding.
        checker
            .validate(&materialization_bytes(&cf, "basis")?)
            .map_err(|e| e.to_string())?;
        if let (false, Some(st)) = (fresh, stored) {
            require(
                snap.revision == st.entry.source_revision && snap.authority == st.entry.authority,
                "invalid-source",
            )?;
        }
        Ok(SourceCheck {
            binding: descriptor.binding.clone(),
            snapshot: snap,
            capture,
            authority,
        })
    };
    validate().map_err(|e| {
        if e == "resource-limit" {
            e
        } else {
            "invalid-source".into()
        }
    })
}
/// Stage 7: exact acts valid at the descriptor's definition-at; descriptor valid now.
fn check_program(
    c: &InputCatalog,
    descriptor: &Descriptor,
    deltas: Vec<Delta>,
    received_at: f64,
) -> Result<BasisProgram> {
    require(
        valid_at(&descriptor.delta, received_at),
        "invalid-definition",
    )?;
    let bindings = crate::command_data::read_bindings(&descriptor.bindings)
        .map_err(|_| "invalid-definition")?;
    definitions_program(
        deltas,
        DefinitionProgramInput {
            at: descriptor.definition_at,
            hyper: descriptor.hyper.clone(),
            reading: descriptor.reading.clone(),
            hyper_pin: descriptor.hyper_pin.clone(),
            reading_pin: descriptor.reading_pin.clone(),
            bindings,
            embedded: false,
        },
        &c.limits,
    )
}
/// Stage 8: one root's complete envelope and View (MR-19 RootResult).
fn materialize_root(
    c: &InputCatalog,
    program: &BasisProgram,
    snapshot: &MaterializationSourceSnapshot,
    at: f64,
    root: &str,
    diagnostic: &MaterializationDiagnostic,
) -> Result<CborValue> {
    let source = DeltaSet::from_deltas(snapshot.deltas.clone()).map_err(|_| "invalid-source")?;
    let gathered = eval_materialization_term_at(
        &program.selected.gather.body,
        &source,
        at,
        crate::evaluation_budget::MaterializationEvaluationLimits {
            nodes: c.limits["nodes"],
            entries: c.limits["entries"],
            buckets: c.limits["buckets"],
            depth: c.limits["depth"],
        },
        Some(root),
        Some(&program.selected.registry),
        &program.bindings,
    )
    .map_err(|e| {
        if e == "resource-limit" {
            return "resource-limit".to_string();
        }
        diagnostic(&e);
        "execution-failed".to_string()
    })?;
    let EvalResult::HView(hview) = gathered else {
        return Err("execution-failed".into());
    };
    let envelope =
        encode_hview_envelope(&hview, envelope_limits(&c.limits)).map_err(|e| e.to_string())?;
    require(!missing_reading(&hview), "missing-reading")?;
    let reading = bind_program_reading(&program.selected.reading, Some(&program.bindings))
        .map_err(|_| "invalid-program")?;
    let view = resolve_view(&reading, &hview).map_err(|e| {
        diagnostic(&e);
        "execution-failed".to_string()
    })?;
    let value = hex::decode(view_canonical_hex(&view)).map_err(|_| "execution-failed")?;
    limit(value.len(), c.limits["artifactBytes"])?;
    Ok(map(vec![
        ("root", s(root)),
        ("transport", s(&content_address(&envelope))),
        ("envelope", CborValue::Bstr(envelope)),
        (
            "hview",
            s(&content_address(
                &hex::decode(hview_canonical_hex(&hview)).map_err(|_| "invalid-evidence")?,
            )),
        ),
        ("view", s(&content_address(&value))),
        ("value", CborValue::Bstr(value)),
    ]))
}
fn basis_fields(descriptor: &Descriptor, at: f64, serving_at: f64) -> MaterializationFields {
    let p = |v: f64| vec![Target::Primitive(Primitive::Num(v))];
    let t = |v: &str| vec![Target::Primitive(Primitive::Str(v.into()))];
    let r = |v: &str| {
        vec![Target::Delta(DeltaRef {
            delta: v.into(),
            context: None,
        })]
    };
    BTreeMap::from([
        ("at".to_string(), p(at)),
        ("serving-at".into(), p(serving_at)),
        (
            "bindings".into(),
            vec![Target::Bytes {
                mime: "application/cbor".into(),
                value: descriptor.bindings.clone(),
            }],
        ),
        ("definition-at".into(), p(descriptor.definition_at)),
        ("hyperschema".into(), r(&descriptor.hyper)),
        ("hyperschema-pin".into(), t(&descriptor.hyper_pin)),
        ("schema".into(), r(&descriptor.reading)),
        ("schema-pin".into(), t(&descriptor.reading_pin)),
    ])
}
fn check_current(
    host: &mut LifecycleHost,
    source: &SourceCheck,
    received_at: f64,
    required_support: &[String],
) -> Result<()> {
    host.grants
        .get_mut(&source.binding)
        .ok_or("unauthorized")?
        .check_current(
            &source.binding,
            &source.snapshot.revision,
            &source.snapshot.authority,
            received_at,
            None,
            required_support,
        )
        .map_err(|e| {
            match e {
                MaterializationSourceFailure::Unauthorized => "unauthorized",
                MaterializationSourceFailure::SourceChanged => "source-changed",
                MaterializationSourceFailure::SourceUnavailable => "source-unavailable",
            }
            .into()
        })
}
fn entity_text(e: &MaterializationControlEntry) -> Vec<(&'static str, CborValue)> {
    vec![
        ("registration", s(&e.registration)),
        ("status", s(e.status_text())),
        ("sourceRevision", s(&e.source_revision)),
        ("authority", s(&e.authority)),
        ("at", CborValue::Float(e.at)),
        ("definitionAt", CborValue::Float(e.definition_at)),
        ("hyperschemaPin", s(&e.hyperschema_pin)),
        ("schemaPin", s(&e.schema_pin)),
        (
            "availability",
            s(if e.status == MaterializationControlStatus::Active {
                "unchecked"
            } else {
                "retired"
            }),
        ),
    ]
}
trait StatusText {
    fn status_text(&self) -> &'static str;
}
impl StatusText for MaterializationControlEntry {
    fn status_text(&self) -> &'static str {
        match self.status {
            MaterializationControlStatus::Active => "active",
            MaterializationControlStatus::Retired => "retired",
        }
    }
}

/// Runs one maintained attempt after stages 1-4; every refusal is a known category.
pub(crate) fn run_lifecycle(
    mut host: LifecycleHost,
    p: &PreparedInput,
    received_at: f64,
) -> Result<LifecycleOutcome> {
    let c = host.catalog;
    let verb = p.verb;
    let f = &p.fields;
    let control = read_control(&mut host)?;
    require(
        materialization_text(f, "expected-control")? == control.revision,
        "precondition-failed",
    )?;
    if verb == MaterializationVerb::Restore {
        return Ok(LifecycleOutcome::Completed(map(vec![
            ("kind", s("restore")),
            ("control", s(&control.revision)),
            ("generation", CborValue::Float(control.image.generation)),
            (
                "selections",
                CborValue::Array(
                    control
                        .image
                        .entries
                        .iter()
                        .map(|e| map(entity_text(e)))
                        .collect(),
                ),
            ),
        ])));
    }
    let registration = materialization_ref(f, "registration")?;
    let stored = control.stored.get(&registration);
    if verb == MaterializationVerb::Install {
        if let Some(st) = stored {
            return Err(
                if st.entry.status == MaterializationControlStatus::Retired {
                    "retired".into()
                } else {
                    "already-installed".into()
                },
            );
        }
        require(
            control.image.entries.len() < c.limits["registrations"],
            "resource-limit",
        )?;
    } else {
        let st = stored.ok_or("registration-missing")?;
        require(
            st.entry.status == MaterializationControlStatus::Active,
            "retired",
        )?;
        if verb == MaterializationVerb::AdvanceTime {
            require(
                materialization_number(f, "at")? >= st.entry.at,
                "time-regression",
            )?;
        }
    }
    let descriptor = if verb == MaterializationVerb::Install {
        read_registration_descriptor(p.supplied.get(&registration).ok_or("invalid-arguments")?)
            .ok_or("invalid-arguments")?
    } else {
        stored
            .and_then(|s| s.descriptor.clone())
            .ok_or(INVALID_CONTROL)?
    };
    let generation = control.image.generation + 1.0;
    require(generation <= 9007199254740991.0, "resource-limit")?;
    let mut at = stored.map(|s| s.entry.at).unwrap_or(0.0);
    if verb == MaterializationVerb::Retire {
        let prepared = prepare_transition(
            &host,
            &control,
            stored,
            &descriptor,
            None,
            None,
            Prospective {
                verb,
                registration,
                generation,
                at,
                received_at,
                basis: None,
                results: vec![],
            },
        )?;
        return commit(&mut host, &control, prepared);
    }
    let source = check_source(&host, p, &descriptor, stored, received_at)?;
    // MR-21 stage 6: expected-source compares after the grant, binding, capture, snapshot and
    // authority checks and before the host's current check.
    if verb != MaterializationVerb::Install {
        require(
            materialization_text(f, "expected-source")? == stored.unwrap().entry.source_revision,
            "precondition-failed",
        )?;
    }
    let mut required_support = descriptor_closure(&descriptor);
    required_support.push(descriptor.delta.id.clone());
    required_support.sort();
    check_current(&mut host, &source, received_at, &required_support)?;
    let deltas = if verb == MaterializationVerb::Install {
        descriptor_closure(&descriptor)
            .iter()
            .map(|id| {
                p.supplied
                    .get(id)
                    .cloned()
                    .ok_or("missing-support".to_string())
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        stored.unwrap().definitions.clone()
    };
    let program = check_program(c, &descriptor, deltas, received_at)?;
    if matches!(
        verb,
        MaterializationVerb::Install | MaterializationVerb::AdvanceTime
    ) {
        at = materialization_number(f, "at")?;
    }
    let results = descriptor
        .roots
        .iter()
        .map(|root| materialize_root(c, &program, &source.snapshot, at, root, host.diagnostic))
        .collect::<Result<Vec<_>>>()?;
    let basis = gather_basis(
        &basis_fields(&descriptor, at, received_at),
        &source.snapshot,
        &program.deltas,
        &c.limits,
    )?;
    if verb == MaterializationVerb::Read {
        let body = map(vec![
            ("kind", s("read")),
            ("registration", s(&registration)),
            ("control", s(&control.revision)),
            ("generation", CborValue::Float(control.image.generation)),
            ("basis", basis),
            ("results", CborValue::Array(results)),
        ]);
        limit(encode(&body).len(), c.limits["artifactBytes"])?;
        check_current(&mut host, &source, received_at, &required_support)?;
        return Ok(LifecycleOutcome::Completed(body));
    }
    let prepared = prepare_transition(
        &host,
        &control,
        stored,
        &descriptor,
        Some(&source),
        Some(&program),
        Prospective {
            verb,
            registration,
            generation,
            at,
            received_at,
            basis: Some(basis),
            results,
        },
    )?;
    check_current(&mut host, &source, received_at, &required_support)?;
    commit(&mut host, &control, prepared)
}

struct Prospective {
    verb: MaterializationVerb,
    registration: String,
    generation: f64,
    at: f64,
    received_at: f64,
    basis: Option<CborValue>,
    results: Vec<CborValue>,
}
struct PreparedTransition {
    bytes: Vec<u8>,
    next: String,
    body: CborValue,
}
/// Sign the transition, plan the next selection, and bound the image before CAS (MR-16).
fn prepare_transition(
    host: &LifecycleHost,
    control: &ControlState,
    stored: Option<&StoredEntry>,
    descriptor: &Descriptor,
    source: Option<&SourceCheck>,
    program: Option<&BasisProgram>,
    x: Prospective,
) -> Result<PreparedTransition> {
    let c = host.catalog;
    let p = |v: f64| vec![Target::Primitive(Primitive::Num(v))];
    let t = |v: &str| vec![Target::Primitive(Primitive::Str(v.into()))];
    let r = |v: &str| {
        vec![Target::Delta(DeltaRef {
            delta: v.into(),
            context: None,
        })]
    };
    let entry = stored.map(|s| &s.entry);
    let source_revision = match (source, entry) {
        (Some(src), _) => src.snapshot.revision.clone(),
        (None, Some(e)) => e.source_revision.clone(),
        _ => return Err(INVALID_CONTROL.into()),
    };
    let authority = match (source, entry) {
        (Some(src), _) => src.authority.id.clone(),
        (None, Some(e)) => e.authority.clone(),
        _ => return Err(INVALID_CONTROL.into()),
    };
    let mut fields: MaterializationFields = BTreeMap::from([
        ("registration".to_string(), r(&x.registration)),
        ("generation".into(), p(x.generation)),
        ("prior-control".into(), t(&control.revision)),
        (
            "prior-transition".into(),
            t(entry.map(|e| e.transition.as_str()).unwrap_or("")),
        ),
        ("verb".into(), t(x.verb.as_str())),
        ("source-revision".into(), t(&source_revision)),
        ("authority".into(), t(&authority)),
        ("at".into(), p(x.at)),
        ("definition-at".into(), p(descriptor.definition_at)),
        ("hyperschema-pin".into(), t(&descriptor.hyper_pin)),
        ("schema-pin".into(), t(&descriptor.reading_pin)),
    ]);
    if x.verb != MaterializationVerb::Retire {
        fields.insert("capture".into(), r(&source.unwrap().capture.id));
    }
    let claims =
        materialization_description_claims(&c.receiver, x.received_at, "state/1", &fields)?;
    let expected = canonical_bytes(&claims)?;
    let transition = host.signer.sign(&claims)?;
    require(
        verify_canonical_delta(&transition) == Verification::Verified
            && canonical_bytes(&transition.claims)? == expected,
        "invalid materialization transition signer",
    )?;
    let appearance = |d: &Delta| -> Result<(String, Vec<u8>)> {
        let bytes = encode_materialization_appearance(d, source_limits(&c.limits))
            .map_err(|e| e.to_string())?;
        Ok((materialization_appearance_key(&bytes), bytes))
    };
    let plan = match x.verb {
        MaterializationVerb::Install => {
            let src = source.unwrap();
            let mut support = BTreeMap::new();
            for d in std::iter::once(&descriptor.delta)
                .chain(program.unwrap().deltas.iter())
                .chain([&src.capture, &src.authority, &transition])
            {
                let (k, v) = appearance(d)?;
                support.insert(k, v);
            }
            MaterializationControlTransition::Install {
                entry: MaterializationControlActive {
                    registration: x.registration.clone(),
                    source_revision: source_revision.clone(),
                    authority: authority.clone(),
                    at: x.at,
                    definition_at: descriptor.definition_at,
                    hyperschema_pin: descriptor.hyper_pin.clone(),
                    schema_pin: descriptor.reading_pin.clone(),
                    capture: src.capture.id.clone(),
                },
                transition: transition.id.clone(),
                support,
            }
        }
        MaterializationVerb::Retire => MaterializationControlTransition::Retire {
            registration: x.registration.clone(),
            transition: transition.id.clone(),
            support: BTreeMap::from([appearance(&transition)?]),
        },
        _ => {
            let st = stored.unwrap();
            let mut superseded = vec![appearance(&st.transition)?.0];
            let mut support = BTreeMap::from([appearance(&transition)?]);
            if x.verb == MaterializationVerb::ReplaceSource {
                let src = source.unwrap();
                superseded.push(appearance(st.capture.as_ref().unwrap())?.0);
                superseded.push(appearance(st.authority.as_ref().unwrap())?.0);
                for d in [&src.capture, &src.authority] {
                    let (k, v) = appearance(d)?;
                    support.insert(k, v);
                }
                MaterializationControlTransition::ReplaceSource {
                    registration: x.registration.clone(),
                    source_revision: source_revision.clone(),
                    authority: authority.clone(),
                    capture: src.capture.id.clone(),
                    transition: transition.id.clone(),
                    support,
                    superseded,
                }
            } else {
                MaterializationControlTransition::AdvanceTime {
                    registration: x.registration.clone(),
                    at: x.at,
                    transition: transition.id.clone(),
                    support,
                    superseded,
                }
            }
        }
    };
    let cl = control_limits(&c.limits);
    let selection = match plan_materialization_control(&control.selection, &plan, &cl)
        .map_err(|e| e.to_string())?
    {
        MaterializationControlPlan::Planned(sel) => sel,
        MaterializationControlPlan::Refused(code) => return Err(code.code().into()),
    };
    let bytes = encode_materialization_control(
        &materialization_control_image(&selection, &cl).map_err(|e| e.to_string())?,
        &cl,
    )
    .map_err(|e| e.to_string())?;
    let next = materialization_control_revision(&bytes, x.generation);
    let body = if x.verb == MaterializationVerb::Retire {
        map(vec![
            ("kind", s("retire")),
            ("registration", s(&x.registration)),
            ("transition", s(&transition.id)),
            ("control", s(&next)),
            ("generation", CborValue::Float(x.generation)),
        ])
    } else {
        map(vec![
            ("kind", s(x.verb.as_str())),
            ("registration", s(&x.registration)),
            ("transition", s(&transition.id)),
            ("control", s(&next)),
            ("generation", CborValue::Float(x.generation)),
            ("basis", x.basis.unwrap()),
            ("results", CborValue::Array(x.results)),
        ])
    };
    limit(encode(&body).len(), c.limits["artifactBytes"])?;
    Ok(PreparedTransition { bytes, next, body })
}
/// Stage 9: the CAS and its exact outcome mapping (MR-15, MR-18).
fn commit(
    host: &mut LifecycleHost,
    control: &ControlState,
    prepared: PreparedTransition,
) -> Result<LifecycleOutcome> {
    let c = host.catalog;
    let write = match host.store.compare_and_set(
        &c.receiver,
        &c.configuration.id,
        &control.revision,
        &prepared.bytes,
        &prepared.next,
    ) {
        Ok(w) => w,
        Err(fault) => {
            (host.diagnostic)(&fault);
            return Ok(LifecycleOutcome::Indeterminate(map(vec![(
                "code",
                s("commit-unconfirmed"),
            )])));
        }
    };
    match write {
        MaterializationControlWrite::Conflict => Err("write-conflict".into()),
        MaterializationControlWrite::Rejected { .. } => Err("control-rejected".into()),
        MaterializationControlWrite::CommittedUnconfirmed { .. } => Ok(
            LifecycleOutcome::Indeterminate(map(vec![("code", s("commit-unconfirmed"))])),
        ),
        MaterializationControlWrite::Durable { revision } => {
            require(
                revision == prepared.next,
                "control store named a different revision",
            )?;
            if let Some(hook) = &host.hooks.post_cas_result_materialization {
                if let Err(fault) = hook(&prepared.next) {
                    (host.diagnostic)(&fault);
                    return Ok(LifecycleOutcome::Indeterminate(map(vec![
                        ("code", s("result-unavailable")),
                        ("control", s(&prepared.next)),
                    ])));
                }
            }
            Ok(LifecycleOutcome::Completed(prepared.body))
        }
    }
}
/// Pure preflight projection for a maintained verb (MR-21): stage 5 and every control-dependent
/// check are unsupported, so only install can project its supplied source and program.
pub(crate) fn preflight_lifecycle(
    c: &InputCatalog,
    p: &PreparedInput,
    received_at: f64,
) -> Result<()> {
    if p.verb != MaterializationVerb::Install {
        return Ok(());
    }
    let registration = materialization_ref(&p.fields, "registration")?;
    let descriptor =
        read_registration_descriptor(p.supplied.get(&registration).ok_or("invalid-arguments")?)
            .ok_or("invalid-arguments")?;
    check_source_structure(c, p, &descriptor, None, received_at)?;
    let deltas = descriptor_closure(&descriptor)
        .iter()
        .map(|id| {
            p.supplied
                .get(id)
                .cloned()
                .ok_or("missing-support".to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    check_program(c, &descriptor, deltas, received_at)?;
    Ok(())
}
/// Explicit host initialization of the empty image (MR-14/15); never lazy.
pub fn initialize_materialization_control(
    store: &mut dyn MaterializationControlStore,
    receiver: &str,
    configuration: &str,
    limits: &MaterializationLimits,
) -> Result<()> {
    let l = control_limits(limits);
    let empty = encode_materialization_control(
        &materialization_control_image(
            &empty_materialization_control(receiver, configuration).map_err(|e| e.to_string())?,
            &l,
        )
        .map_err(|e| e.to_string())?,
        &l,
    )
    .map_err(|e| e.to_string())?;
    if let MaterializationControlInitialize::Existing { bytes, revision } =
        store.initialize(receiver, configuration, &empty)?
    {
        let image = decode_materialization_control(&bytes, &l).map_err(|e| e.to_string())?;
        require(
            image.receiver == receiver
                && image.configuration == configuration
                && revision == materialization_control_revision(&bytes, image.generation),
            "invalid materialization control store",
        )?;
    }
    Ok(())
}
