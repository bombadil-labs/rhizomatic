//! Release-A gather/resolve and pure supplied-input preflight; no maintained control runtime.
use crate::cbor::{encode, CborValue};
use crate::delta::canonical_bytes;
use crate::eval::{bind_program_reading, eval_materialization_term_at, EvalResult};
use crate::hash::content_address;
use crate::materialization_basis::gather_basis;
use crate::materialization_data::{
    materialization_description_claims, materialization_entity, materialization_number,
    MaterializationVerb,
};
use crate::materialization_evidence::{missing_reading, validate_gather_evidence};
use crate::materialization_input::{
    catalog, check_delivery_counts, prepare, required_binding, validate_program, validate_source,
    InputCatalog, MaterializationInputBoot,
};
use crate::materialization_lifecycle::{
    is_lifecycle_verb, run_lifecycle, LifecycleHost, LifecycleOutcome,
    MaterializationLifecycleHooks,
};
use crate::materialization_peer::MaterializationControlStore;
use crate::materialization_source::{
    MaterializationSourceCapability, MaterializationSourceFailure, MaterializationSourceSnapshot,
};
use crate::materialization_values::{
    envelope_limits, field, limit, map, object, require, s, Result,
};
use crate::resolution::{resolve_view, view_canonical_hex};
use crate::resolve_evidence::{encode_hview_envelope, hview_canonical_hex};
use crate::set::DeltaSet;
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::{Claims, Delta, DeltaRef, EntityRef, Primitive, Target};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationInputPreflight {
    InputValid,
    OverInputLimit,
    InvalidInput { code: String },
}
pub fn preflight_materialization_input(
    boot: &MaterializationInputBoot,
    entry_id: &str,
    appearances: &[serde_json::Value],
    received_at: f64,
) -> Result<MaterializationInputPreflight> {
    require(
        crate::command_data::is_content_id(entry_id) && received_at.is_finite(),
        "invalid materialization transport framing",
    )?;
    let c = catalog(boot)?;
    let validation = || -> Result<()> {
        let p = prepare(&c, entry_id, appearances, received_at)?;
        if p.verb == MaterializationVerb::Gather {
            validate_source(&c, &p, received_at)?;
        }
        validate_program(&c, &p)?;
        if p.verb == MaterializationVerb::Resolve {
            validate_gather_evidence(
                p.evidence_body.as_ref().ok_or("invalid-evidence")?,
                &c.limits,
            )?;
        }
        Ok(())
    };
    Ok(match validation() {
        Ok(()) => MaterializationInputPreflight::InputValid,
        Err(code) if code == "resource-limit" => MaterializationInputPreflight::OverInputLimit,
        Err(code) => MaterializationInputPreflight::InvalidInput { code },
    })
}
/// Native key custody; signer exposes only attribution and exact requested claims.
pub trait MaterializationSigner {
    fn author(&self) -> &str;
    fn sign(&self, claims: &Claims) -> Result<Delta>;
}
pub type MaterializationDiagnostic<'a> = dyn Fn(&str) + 'a;
pub struct MaterializationEndpoint<'a> {
    catalog: InputCatalog,
    signer: Box<dyn MaterializationSigner + 'a>,
    source_grants: BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
    diagnostic: Box<MaterializationDiagnostic<'a>>,
    control_store: Option<Box<dyn MaterializationControlStore + 'a>>,
    hooks: MaterializationLifecycleHooks<'a>,
}
impl<'a> MaterializationEndpoint<'a> {
    /// Release A: gather and resolve only. A release-B catalog needs `boot_maintained`.
    pub fn boot(
        boot: &MaterializationInputBoot,
        signer: Box<dyn MaterializationSigner + 'a>,
        source_grants: BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
        diagnostic: Box<MaterializationDiagnostic<'a>>,
    ) -> Result<Self> {
        Self::boot_with(
            boot,
            signer,
            source_grants,
            diagnostic,
            None,
            Default::default(),
        )
    }
    /// Release B: all eight verbs over an explicitly initialized control store (MR-15).
    pub fn boot_maintained(
        boot: &MaterializationInputBoot,
        signer: Box<dyn MaterializationSigner + 'a>,
        source_grants: BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
        diagnostic: Box<MaterializationDiagnostic<'a>>,
        control_store: Box<dyn MaterializationControlStore + 'a>,
        hooks: MaterializationLifecycleHooks<'a>,
    ) -> Result<Self> {
        Self::boot_with(
            boot,
            signer,
            source_grants,
            diagnostic,
            Some(control_store),
            hooks,
        )
    }
    fn boot_with(
        boot: &MaterializationInputBoot,
        signer: Box<dyn MaterializationSigner + 'a>,
        source_grants: BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
        diagnostic: Box<MaterializationDiagnostic<'a>>,
        control_store: Option<Box<dyn MaterializationControlStore + 'a>>,
        hooks: MaterializationLifecycleHooks<'a>,
    ) -> Result<Self> {
        let catalog = catalog(boot)?;
        require(
            signer.author() == catalog.receiver,
            "invalid materialization signer",
        )?;
        require(
            source_grants
                .keys()
                .all(|k| catalog.bindings.contains_key(k)),
            "grant for unselected binding",
        )?;
        let maintained = catalog.release == 'B';
        require(
            !maintained || control_store.is_some(),
            "maintained verbs require an initialized control store",
        )?;
        Ok(Self {
            catalog,
            signer,
            source_grants,
            diagnostic,
            control_store: if maintained { control_store } else { None },
            hooks,
        })
    }
    pub fn catalog(&self) -> DeltaSet {
        DeltaSet::from_deltas(
            std::iter::once(self.catalog.configuration.clone())
                .chain(self.catalog.operations.values().map(|(d, _)| d.clone()))
                .chain(self.catalog.bindings.values().cloned()),
        )
        .expect("verified immutable catalog")
    }
    fn outcome(&self, entry_id: &str, at: f64, status: &str, body: CborValue) -> Result<Delta> {
        let reference = |id: &str| {
            Target::Delta(DeltaRef {
                delta: id.into(),
                context: None,
            })
        };
        let fields = BTreeMap::from([
            (
                "receiver".into(),
                vec![Target::Entity(EntityRef {
                    id: self.catalog.receiver.clone(),
                    context: None,
                })],
            ),
            (
                "configuration".into(),
                vec![reference(&self.catalog.configuration.id)],
            ),
            ("request".into(), vec![reference(entry_id)]),
            (
                "status".into(),
                vec![Target::Primitive(Primitive::Str(status.into()))],
            ),
            (
                "result".into(),
                vec![Target::Bytes {
                    mime: "application/cbor".into(),
                    value: encode(&body),
                }],
            ),
        ]);
        let claims =
            materialization_description_claims(&self.catalog.receiver, at, "outcome/1", &fields)?;
        let expected = canonical_bytes(&claims)?;
        let signed = self.signer.sign(&claims)?;
        require(
            verify_canonical_delta(&signed) == Verification::Verified
                && canonical_bytes(&signed.claims)? == expected,
            "invalid materialization response signer",
        )?;
        Ok(signed)
    }
    pub fn invoke(
        &mut self,
        entry_id: &str,
        appearances: &[serde_json::Value],
        received_at: f64,
    ) -> Result<Delta> {
        require(
            crate::command_data::is_content_id(entry_id) && received_at.is_finite(),
            "invalid materialization transport framing",
        )?;
        if let Err(code) = check_delivery_counts(appearances, &self.catalog.limits) {
            return self.outcome(
                entry_id,
                received_at,
                "refused",
                map(vec![("code", s(&code))]),
            );
        }
        // The immutable borrow is counted before bounded typed allocation.
        match self.attempt(entry_id, appearances, received_at) {
            Ok(LifecycleOutcome::Completed(body)) => {
                self.outcome(entry_id, received_at, "completed", body)
            }
            Ok(LifecycleOutcome::Indeterminate(body)) => {
                self.outcome(entry_id, received_at, "indeterminate", body)
            }
            Err(code) => self.outcome(
                entry_id,
                received_at,
                "refused",
                map(vec![("code", s(&code))]),
            ),
        }
    }
    fn check(
        &mut self,
        binding: &str,
        snapshot: &MaterializationSourceSnapshot,
        at: f64,
        required_support: &[String],
    ) -> Result<()> {
        self.source_grants
            .get_mut(binding)
            .ok_or("unauthorized")?
            .check_current(
                binding,
                &snapshot.revision,
                &snapshot.authority,
                at,
                snapshot.historical_cutoff,
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
    fn attempt(
        &mut self,
        entry_id: &str,
        appearances: &[serde_json::Value],
        received_at: f64,
    ) -> Result<LifecycleOutcome> {
        let p = prepare(&self.catalog, entry_id, appearances, received_at)?;
        if is_lifecycle_verb(p.verb) {
            let store = self.control_store.as_mut().ok_or("unsupported-operation")?;
            return run_lifecycle(
                LifecycleHost {
                    catalog: &self.catalog,
                    signer: self.signer.as_ref(),
                    grants: &mut self.source_grants,
                    store: store.as_mut(),
                    hooks: &self.hooks,
                    diagnostic: self.diagnostic.as_ref(),
                },
                &p,
                received_at,
            );
        }
        let snapshot = if p.verb == MaterializationVerb::Gather {
            let binding = required_binding(&p)?;
            require(self.source_grants.contains_key(&binding), "unauthorized")?;
            let snap = validate_source(&self.catalog, &p, received_at)?;
            self.check(&binding, &snap, received_at, &p.required_support)?;
            Some(snap)
        } else {
            None
        };
        let program = validate_program(&self.catalog, &p)?;
        let body = if p.verb == MaterializationVerb::Gather {
            let snap = snapshot.as_ref().ok_or("invalid-source")?;
            let source =
                DeltaSet::from_deltas(snap.deltas.clone()).map_err(|_| "invalid-source")?;
            let root = materialization_entity(&p.fields, "root")?;
            let gathered = eval_materialization_term_at(
                &program.selected.gather.body,
                &source,
                materialization_number(&p.fields, "at")?,
                crate::evaluation_budget::MaterializationEvaluationLimits {
                    nodes: self.catalog.limits["nodes"],
                    entries: self.catalog.limits["entries"],
                    buckets: self.catalog.limits["buckets"],
                    depth: self.catalog.limits["depth"],
                },
                Some(&root),
                Some(&program.selected.registry),
                &program.bindings,
            )
            .map_err(|e| {
                if e == "resource-limit" {
                    return "resource-limit";
                }
                (self.diagnostic)(&e);
                "execution-failed"
            })?;
            let EvalResult::HView(hview) = gathered else {
                return Err("execution-failed".into());
            };
            let envelope = encode_hview_envelope(&hview, envelope_limits(&self.catalog.limits))
                .map_err(|e| e.to_string())?;
            map(vec![
                ("kind", s("gather")),
                ("root", s(&root)),
                (
                    "basis",
                    gather_basis(&p.fields, snap, &program.deltas, &self.catalog.limits)?,
                ),
                ("transport", s(&content_address(&envelope))),
                ("envelope", CborValue::Bstr(envelope)),
                (
                    "hview",
                    s(&content_address(
                        &hex::decode(hview_canonical_hex(&hview))
                            .map_err(|_| "invalid-evidence")?,
                    )),
                ),
            ])
        } else {
            let evidence_body = p.evidence_body.as_ref().ok_or("invalid-evidence")?;
            let evidence = validate_gather_evidence(evidence_body, &self.catalog.limits)?;
            require(!missing_reading(&evidence.hview), "missing-reading")?;
            let fs = object(
                evidence_body,
                &["kind", "root", "basis", "envelope", "transport", "hview"],
                &[],
            )?;
            let reading = bind_program_reading(&program.selected.reading, Some(&program.bindings))
                .map_err(|_| "invalid-program")?;
            let view = resolve_view(&reading, &evidence.hview).map_err(|e| {
                (self.diagnostic)(&e);
                "execution-failed"
            })?;
            let value = hex::decode(view_canonical_hex(&view)).map_err(|_| "execution-failed")?;
            limit(value.len(), self.catalog.limits["artifactBytes"])?;
            map(vec![
                ("kind", s("resolve")),
                ("root", field(&fs, "root")?.clone()),
                ("basis", field(&fs, "basis")?.clone()),
                ("transport", field(&fs, "transport")?.clone()),
                ("hview", field(&fs, "hview")?.clone()),
                ("view", s(&content_address(&value))),
                ("value", CborValue::Bstr(value)),
            ])
        };
        limit(encode(&body).len(), self.catalog.limits["artifactBytes"])?;
        if let Some(snapshot) = snapshot {
            self.check(
                &snapshot.binding,
                &snapshot,
                received_at,
                &p.required_support,
            )?;
        }
        Ok(LifecycleOutcome::Completed(body))
    }
}
