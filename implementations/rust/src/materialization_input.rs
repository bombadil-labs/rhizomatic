//! MR-21 ordered pure input phases. Host grant/current checks remain explicit gaps.
use crate::cbor::{encode, CborValue};
use crate::hash::content_address;
use crate::json_profile::{delta_debug_delivery_size, parse_delta};
use crate::materialization_basis::{
    basis_program, definitions_program, BasisProgram, DefinitionProgramInput,
};
use crate::materialization_data::{
    materialization_bytes, materialization_entity, materialization_number,
    materialization_operation_verb, materialization_ref, materialization_release_verbs,
    materialization_role, materialization_text, read_materialization_description,
    read_materialization_limits, MaterializationFields, MaterializationLimits, MaterializationVerb,
};
use crate::materialization_source::{
    decode_materialization_authority_spec, decode_materialization_binding_spec,
    decode_materialization_snapshot_evidence, MaterializationSourceSnapshot,
};
use crate::materialization_values::{
    cbor, field, limit, object, require, s, source_limits, text, Result,
};
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::{Delta, Primitive, Target};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone)]
pub struct MaterializationInputBoot {
    pub configuration: Delta,
    pub declarations: Vec<Delta>,
    pub bindings: Vec<Delta>,
}
#[derive(Debug, Clone)]
pub(crate) struct InputCatalog {
    pub configuration: Delta,
    pub receiver: String,
    pub fields: MaterializationFields,
    pub limits: MaterializationLimits,
    pub operations: BTreeMap<String, (Delta, MaterializationVerb)>,
    pub bindings: BTreeMap<String, Delta>,
    /// Release A installs gather/resolve only; release B installs all eight verbs (MR-08).
    pub release: char,
}
pub(crate) fn valid_at(d: &Delta, at: f64) -> bool {
    d.claims.valid_from <= at && d.claims.valid_until.is_none_or(|end| at < end)
}
pub(crate) fn catalog(boot: &MaterializationInputBoot) -> Result<InputCatalog> {
    let config = boot.configuration.clone();
    require(
        verify_canonical_delta(&config) == Verification::Verified,
        "invalid boot signature",
    )?;
    let fs = read_materialization_description(&config, None)?;
    require(
        materialization_text(&fs, "kind")? == "endpoint/1",
        "invalid boot kind",
    )?;
    let receiver = materialization_entity(&fs, "receiver")?;
    require(config.claims.author == receiver, "invalid boot authority")?;
    let mut operations = BTreeMap::new();
    let mut kinds = BTreeSet::new();
    for d in &boot.declarations {
        require(
            verify_canonical_delta(d) == Verification::Verified && d.claims.author == receiver,
            "invalid operation authority",
        )?;
        let f = read_materialization_description(d, None)?;
        require(
            materialization_text(&f, "kind")? == "operation/1",
            "invalid operation kind",
        )?;
        let verb = materialization_operation_verb(&materialization_entity(&f, "name")?)?;
        require(kinds.insert(verb.as_str()), "duplicate operation")?;
        operations.insert(d.id.clone(), (d.clone(), verb));
    }
    let refs = |k: &str| -> Result<Vec<String>> {
        fs.get(k)
            .into_iter()
            .flatten()
            .map(|t| materialization_ref(&BTreeMap::from([("x".into(), vec![t.clone()])]), "x"))
            .collect()
    };
    let release = ['A', 'B']
        .into_iter()
        .find(|r| {
            let verbs = materialization_release_verbs(*r);
            kinds.len() == verbs.len() && verbs.iter().all(|v| kinds.contains(v.as_str()))
        })
        .ok_or("invalid operation catalog")?;
    let installed = refs("installed")?;
    require(
        operations.len() == kinds.len()
            && boot.declarations.len() == kinds.len()
            && installed.len() == kinds.len()
            && installed.iter().all(|i| operations.contains_key(i)),
        "invalid operation catalog",
    )?;
    let mut bindings = BTreeMap::new();
    let mut source_ids = BTreeSet::new();
    for d in &boot.bindings {
        require(
            verify_canonical_delta(d) == Verification::Verified && d.claims.author == receiver,
            "invalid binding authority",
        )?;
        let f = read_materialization_description(d, None)?;
        require(
            materialization_text(&f, "kind")? == "source-binding/1"
                && materialization_entity(&f, "receiver")? == receiver,
            "invalid binding receiver",
        )?;
        let spec =
            decode_materialization_binding_spec(&materialization_bytes(&f, "spec")?, 16777216)
                .map_err(|e| e.to_string())?;
        require(
            source_ids.insert(spec.source_id) && bindings.insert(d.id.clone(), d.clone()).is_none(),
            "duplicate binding",
        )?;
    }
    let selected = refs("source-binding")?;
    require(
        selected.len() == bindings.len() && selected.iter().all(|i| bindings.contains_key(i)),
        "invalid selected bindings",
    )?;
    let limits = read_materialization_limits(&materialization_bytes(&fs, "limits")?)?;
    Ok(InputCatalog {
        configuration: config,
        receiver,
        fields: fs,
        limits,
        operations,
        bindings,
        release,
    })
}
#[derive(Debug, Clone)]
pub(crate) struct PreparedInput {
    pub fields: MaterializationFields,
    pub verb: MaterializationVerb,
    pub supplied: BTreeMap<String, Delta>,
    pub required_support: Vec<String>,
    pub capture: Option<Delta>,
    pub snapshot_bytes: Option<Vec<u8>>,
    pub evidence_body: Option<CborValue>,
}
pub(crate) fn check_delivery_counts(
    appearances: &[serde_json::Value],
    limits: &MaterializationLimits,
) -> Result<()> {
    limit(appearances.len(), limits["deliveryAppearances"])?;
    let counts = appearances
        .iter()
        .map(|v| {
            v.get("claims")
                .and_then(|v| v.get("pointers"))
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .ok_or_else(|| "invalid-appearance".to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    for count in counts {
        limit(count, limits["pointers"])?;
    }
    Ok(())
}
pub(crate) fn prepare(
    c: &InputCatalog,
    entry_id: &str,
    appearances: &[serde_json::Value],
    received_at: f64,
) -> Result<PreparedInput> {
    check_delivery_counts(appearances, &c.limits)?;
    let size = delta_debug_delivery_size(appearances, c.limits["deliveryBytes"])
        .map_err(|_| "invalid-appearance")?;
    limit(size, c.limits["deliveryBytes"])?;
    // id and sig are not claims bytes; reject invalid framing before cloning them.
    require(
        appearances.iter().all(|v| {
            v.get("id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(crate::command_data::is_content_id)
                && v.get("sig")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|s| {
                        s.len() == 128
                            && s.bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
        }),
        "invalid-appearance",
    )?;
    let deltas = appearances
        .iter()
        .map(parse_delta)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "invalid-appearance")?;
    require(
        deltas
            .iter()
            .all(|d| verify_canonical_delta(d) == Verification::Verified),
        "invalid-appearance",
    )?;
    let mut supplied: BTreeMap<String, Delta> = BTreeMap::new();
    for d in deltas {
        if supplied.get(&d.id).is_none_or(|old| d.sig < old.sig) {
            supplied.insert(d.id.clone(), d);
        }
    }
    let entry = supplied.get(entry_id).ok_or("entry-missing")?.clone();
    let common = read_materialization_description(&entry, None).map_err(|_| "invalid-request")?;
    require(
        materialization_text(&common, "kind")? == "request/1",
        "invalid-request",
    )?;
    require(valid_at(&entry, received_at), "request-outside-validity")?;
    let operation = c
        .operations
        .get(&materialization_ref(&common, "operation")?);
    require(
        materialization_entity(&common, "receiver")? == c.receiver
            && materialization_ref(&common, "configuration")? == c.configuration.id
            && valid_at(&c.configuration, received_at)
            && operation.is_none_or(|(d, _)| valid_at(d, received_at)),
        "configuration-mismatch",
    )?;
    let member = |role: &str| {
        c.fields.get(role).into_iter().flatten().any(
            |t| matches!(t,Target::Primitive(Primitive::Str(key)) if *key==entry.claims.author),
        )
    };
    require(member("caller"), "unauthorized")?;
    // MR-08: the five control verbs need an administrator; stage 3 refuses before any argument.
    if let Some((_, verb)) = operation {
        require(
            !matches!(
                verb,
                MaterializationVerb::Install
                    | MaterializationVerb::ReplaceSource
                    | MaterializationVerb::AdvanceTime
                    | MaterializationVerb::Retire
                    | MaterializationVerb::Restore
            ) || member("administrator"),
            "unauthorized",
        )?;
    }
    let verb = operation.ok_or("unsupported-operation")?.1;
    let fields =
        read_materialization_description(&entry, Some(verb)).map_err(|_| "invalid-arguments")?;
    if fields.contains_key("serving-at") {
        require(
            materialization_number(&fields, "serving-at")? == received_at,
            "invalid-arguments",
        )?;
    }
    let one =
        |t: &Target| materialization_ref(&BTreeMap::from([("x".into(), vec![t.clone()])]), "x");
    let mut required_support = Vec::new();
    // Direct delivered supports per verb (MR-12); stored support is never redelivered.
    let direct = match verb {
        MaterializationVerb::Gather => {
            required_support.extend([
                materialization_ref(&fields, "hyperschema")?,
                materialization_ref(&fields, "schema")?,
            ]);
            for t in fields.get("definition").into_iter().flatten() {
                required_support.push(one(t)?);
            }
            required_support.sort();
            [
                vec![
                    materialization_ref(&fields, "capture")?,
                    materialization_ref(&fields, "snapshot")?,
                ],
                required_support.clone(),
            ]
            .concat()
        }
        MaterializationVerb::Resolve => vec![materialization_ref(&fields, "evidence")?],
        MaterializationVerb::Install => vec![
            materialization_ref(&fields, "registration")?,
            materialization_ref(&fields, "capture")?,
            materialization_ref(&fields, "snapshot")?,
        ],
        MaterializationVerb::ReplaceSource => vec![
            materialization_ref(&fields, "capture")?,
            materialization_ref(&fields, "snapshot")?,
        ],
        MaterializationVerb::AdvanceTime | MaterializationVerb::Read => {
            vec![materialization_ref(&fields, "snapshot")?]
        }
        MaterializationVerb::Retire | MaterializationVerb::Restore => vec![],
    };
    require(
        direct.iter().all(|i| supplied.contains_key(i)),
        "missing-support",
    )?;
    let mut reachable: BTreeSet<String> =
        direct.into_iter().chain([entry_id.to_string()]).collect();
    if verb == MaterializationVerb::Install {
        // The named descriptor must be a registration act; its closure is delivered in full.
        let descriptor = read_materialization_description(
            &supplied[&materialization_ref(&fields, "registration")?],
            None,
        )
        .map_err(|_| "invalid-arguments")?;
        require(
            materialization_text(&descriptor, "kind")? == "registration/1",
            "invalid-arguments",
        )?;
        // MR-04: the complete root partition is bounded here, before any root is evaluated.
        limit(
            descriptor.get("roots").map_or(0, |ts| ts.len()),
            c.limits["roots"],
        )?;
        required_support = vec![
            materialization_ref(&descriptor, "hyperschema")?,
            materialization_ref(&descriptor, "schema")?,
        ];
        for t in descriptor.get("definition").into_iter().flatten() {
            required_support.push(one(t)?);
        }
        required_support.sort();
        require(
            required_support.iter().all(|i| supplied.contains_key(i)),
            "missing-support",
        )?;
        reachable.extend(required_support.iter().cloned());
    }
    let capture = if matches!(
        verb,
        MaterializationVerb::Gather
            | MaterializationVerb::Install
            | MaterializationVerb::ReplaceSource
    ) {
        Some(supplied[&materialization_ref(&fields, "capture")?].clone())
    } else {
        None
    };
    if let Some(cap) = &capture {
        let ps = cap
            .claims
            .pointers
            .iter()
            .filter(|p| p.role == materialization_role("authority"))
            .collect::<Vec<_>>();
        if ps.len() == 1 {
            if let Target::Delta(r) = &ps[0].target {
                if r.context.is_none() {
                    require(supplied.contains_key(&r.delta), "missing-support")?;
                    reachable.insert(r.delta.clone());
                }
            }
        }
    }
    require(
        supplied.keys().all(|i| reachable.contains(i)),
        "unexpected-support",
    )?;
    if matches!(
        verb,
        MaterializationVerb::Retire | MaterializationVerb::Restore
    ) {
        return Ok(PreparedInput {
            fields,
            verb,
            supplied,
            required_support,
            capture: None,
            snapshot_bytes: None,
            evidence_body: None,
        });
    }
    let (snapshot_bytes, evidence_body) = if verb == MaterializationVerb::Resolve {
        let ef = read_materialization_description(
            &supplied[&materialization_ref(&fields, "evidence")?],
            None,
        )
        .map_err(|_| "invalid-evidence")?;
        require(
            materialization_text(&ef, "kind")? == "evidence/1",
            "invalid-evidence",
        )?;
        (
            None,
            Some(cbor(
                &materialization_bytes(&ef, "result")?,
                c.limits["artifactBytes"],
                "invalid-evidence",
            )?),
        )
    } else {
        let sf = read_materialization_description(
            &supplied[&materialization_ref(&fields, "snapshot")?],
            None,
        )
        .map_err(|_| "invalid-source")?;
        require(
            materialization_text(&sf, "kind")? == "snapshot/1",
            "invalid-source",
        )?;
        let data = materialization_bytes(&sf, "data")?;
        let raw = cbor(&data, c.limits["artifactBytes"], "invalid-source")?;
        let CborValue::Map(fs) = raw else {
            return Err("invalid-source".into());
        };
        require(
            fs.iter()
                .any(|(k, x)| k == "format" && *x == s("rhizomatic.source-snapshot/1")),
            "invalid-source",
        )?;
        (Some(data), None)
    };
    Ok(PreparedInput {
        fields,
        verb,
        supplied,
        required_support,
        capture,
        snapshot_bytes,
        evidence_body,
    })
}
pub(crate) fn required_binding(p: &PreparedInput) -> Result<String> {
    let capture = p.capture.as_ref().ok_or("invalid-source")?;
    let targets = capture
        .claims
        .pointers
        .iter()
        .filter(|p| p.role == materialization_role("source-binding"))
        .collect::<Vec<_>>();
    require(targets.len() == 1, "invalid-source")?;
    match &targets[0].target {
        Target::Delta(r) if r.context.is_none() && crate::command_data::is_content_id(&r.delta) => {
            Ok(r.delta.clone())
        }
        _ => Err("invalid-source".into()),
    }
}

pub(crate) fn validate_source(
    c: &InputCatalog,
    p: &PreparedInput,
    received_at: f64,
) -> Result<MaterializationSourceSnapshot> {
    let binding_id = required_binding(p)?;
    let binding = c.bindings.get(&binding_id).ok_or("unauthorized")?;
    require(valid_at(binding, received_at), "configuration-mismatch")?;
    let validate = || -> Result<MaterializationSourceSnapshot> {
        let b = read_materialization_description(binding, None)?;
        let spec = decode_materialization_binding_spec(
            &materialization_bytes(&b, "spec")?,
            c.limits["artifactBytes"],
        )
        .map_err(|e| e.to_string())?;
        let capture = p.capture.as_ref().ok_or("invalid-source")?;
        let cf = read_materialization_description(capture, None)?;
        let authority = p
            .supplied
            .get(&materialization_ref(&cf, "authority")?)
            .ok_or("invalid-source")?;
        let af = read_materialization_description(authority, None)?;
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
        let cutoff = if p.fields.contains_key("historical-cutoff") {
            Some(materialization_number(&p.fields, "historical-cutoff")?)
        } else {
            None
        };
        require(
            capture.claims.author == spec.capturer
                && authority.claims.author == spec.capturer
                && materialization_ref(&af, "source-binding")? == binding_id
                && snap.binding == binding_id
                && snap.authority == authority.id
                && auth.root == spec.authority_root
                && snap.selection == content_address(&encode(&spec.selection))
                && capture.claims.timestamp == snap.serving_at
                && capture.claims.valid_from == snap.serving_at
                && valid_at(capture, snap.serving_at)
                && valid_at(authority, received_at)
                && snap.historical_cutoff == cutoff,
            "invalid-source",
        )?;
        checker
            .validate(&materialization_bytes(&cf, "basis")?)
            .map_err(|e| e.to_string())?;
        Ok(snap)
    };
    validate().map_err(|e| {
        if e == "resource-limit" {
            e
        } else {
            "invalid-source".into()
        }
    })
}
pub(crate) fn validate_program(c: &InputCatalog, p: &PreparedInput) -> Result<BasisProgram> {
    if p.verb == MaterializationVerb::Resolve {
        let fs = object(
            p.evidence_body.as_ref().ok_or("invalid-evidence")?,
            &["kind", "root", "basis", "envelope", "transport", "hview"],
            &[],
        )?;
        require(text(field(&fs, "kind")?)? == "gather", "invalid-evidence")?;
        return basis_program(field(&fs, "basis")?, &c.limits);
    }
    definitions_program(
        p.required_support
            .iter()
            .map(|i| p.supplied[i].clone())
            .collect(),
        DefinitionProgramInput {
            at: materialization_number(&p.fields, "definition-at")?,
            hyper: materialization_ref(&p.fields, "hyperschema")?,
            reading: materialization_ref(&p.fields, "schema")?,
            hyper_pin: materialization_text(&p.fields, "hyperschema-pin")?,
            reading_pin: materialization_text(&p.fields, "schema-pin")?,
            bindings: crate::command_data::read_bindings(&materialization_bytes(
                &p.fields, "bindings",
            )?)
            .map_err(|_| "invalid-arguments")?,
            embedded: false,
        },
        &c.limits,
    )
}
