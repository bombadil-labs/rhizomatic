//! Composition of command descriptions with their semantic owners and explicit capabilities.
use crate::command_data::{
    is_author, read_operation, read_outcome, read_request, OperationKind, Outcome, OutcomeBody,
    RequestArguments,
};
use crate::resolution::{decode_view, View};
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::Delta;

#[derive(Debug, Clone, PartialEq)]
pub struct CommandResult {
    pub outcome: Outcome,
    pub value: Option<View>,
}
/// Complete strict readback: signed outer description, status/body grammar, and the
/// existing typed View. A supplied request also establishes argument/partition context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadResultContext {
    pub receiver: String,
    pub configuration: String,
    pub request: String,
}
pub fn read_result(
    delta: &Delta,
    expected: &ReadResultContext,
    request: Option<&Delta>,
) -> Result<CommandResult, String> {
    if verify_canonical_delta(delta) != Verification::Verified || !is_author(&delta.claims.author) {
        return Err("command: invalid outcome signature".into());
    }
    let outcome = read_outcome(delta)?;
    if delta.claims.author != outcome.receiver
        || delta.claims.timestamp != delta.claims.valid_from
        || delta.claims.valid_until.is_some()
    {
        return Err("command: invalid outcome attribution or claims time".into());
    }
    if !is_author(&expected.receiver)
        || !crate::command_data::is_content_id(&expected.configuration)
        || !crate::command_data::is_content_id(&expected.request)
        || outcome.receiver != expected.receiver
        || outcome.configuration != expected.configuration
        || outcome.request != expected.request
    {
        return Err("command: outcome does not match expected endpoint/invocation".into());
    }
    let value = match &outcome.body {
        OutcomeBody::Evaluate { value, .. } => Some(decode_view(value)?),
        _ => None,
    };
    if let Some(request) = request.filter(|_| {
        matches!(
            &outcome.body,
            OutcomeBody::Retain { .. } | OutcomeBody::Evaluate { .. }
        )
    }) {
        if verify_canonical_delta(request) != Verification::Verified
            || request.id != outcome.request
        {
            return Err("command: request attribution mismatch".into());
        }
        let common = crate::command_data::read_common_request(request)?;
        if common.receiver != outcome.receiver || common.configuration != outcome.configuration {
            return Err("command: outcome context mismatch".into());
        }
        match &outcome.body {
            OutcomeBody::Retain {
                admitted,
                duplicate,
                ..
            } => {
                let parsed = read_request(request, OperationKind::Retain)?;
                let RequestArguments::Retain(mut offered) = parsed.arguments else {
                    unreachable!()
                };
                let mut partition = admitted.clone();
                partition.extend(duplicate.iter().cloned());
                partition.sort();
                offered.sort();
                if partition != offered {
                    return Err("command: incomplete retain partition".into());
                }
            }
            OutcomeBody::Evaluate {
                source,
                at,
                interpretation,
                hyperschema_pin,
                schema_pin,
                definition_digest,
                ..
            } => {
                let parsed = read_request(request, OperationKind::Evaluate)?;
                let RequestArguments::Evaluate(a) = parsed.arguments else {
                    unreachable!()
                };
                if source != &a.source
                    || at != &a.at
                    || interpretation != &a.interpretation
                    || hyperschema_pin != &a.hyperschema_pin
                    || schema_pin != &a.schema_pin
                {
                    return Err("command: evaluation context mismatch".into());
                }
                let mut definitions = a.definitions.clone();
                definitions.extend([a.hyperschema.clone(), a.schema.clone()]);
                definitions.sort();
                let digest = crate::hash::content_address(&crate::cbor::encode(
                    &crate::cbor::CborValue::Array(
                        definitions
                            .into_iter()
                            .map(crate::cbor::CborValue::Tstr)
                            .collect(),
                    ),
                ));
                if definition_digest != &digest {
                    return Err("command: definition digest mismatch".into());
                }
            }
            _ => {}
        }
    }
    Ok(CommandResult { outcome, value })
}

use crate::command_data::{
    is_content_id, outcome_pointers, read_common_request, read_configuration, Configuration,
    Request,
};
use crate::ordinary_journal_peer::{
    capture_existing_ordinary_source, open_ordinary_journal_peer_degraded,
    DurableOrdinaryJournalStore, OrdinaryJournalAdmissionResult, OrdinaryJournalOpenResult,
    OrdinarySourceCapture,
};
use crate::single_peer::{ArrivalOrigin, SinglePeerTransferInput, TransferMode};
use crate::types::Claims;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandHostError {
    Transport(String),
    Fault(String),
}
#[derive(Debug, Clone)]
pub struct InvocationResult {
    pub outcome: Delta,
    pub diagnostics: Vec<String>,
}
/// Signing is an explicit host capability. It may fail after a durable effect.
pub type ResponseSigner<'a> = dyn Fn(&Claims) -> Result<Delta, String> + 'a;
#[derive(Debug, Clone)]
pub struct CommandEndpoint {
    receiver: String,
    configuration_delta: Delta,
    configuration: Configuration,
    operations: BTreeMap<String, OperationKind>,
    catalog: crate::set::DeltaSet,
}
fn valid_at(d: &Delta, at: f64) -> bool {
    d.claims.valid_from <= at && d.claims.valid_until.is_none_or(|end| at < end)
}
impl CommandEndpoint {
    /// Boot selection is local authority; verified declarations cannot install themselves.
    pub fn boot<S: DurableOrdinaryJournalStore>(
        receiver: &str,
        configuration_delta: &Delta,
        declarations: &[Delta],
        store: &mut S,
    ) -> Result<Self, CommandHostError> {
        let configuration =
            read_configuration(configuration_delta).map_err(CommandHostError::Fault)?;
        if !is_author(receiver)
            || receiver != configuration.receiver
            || configuration_delta.claims.author != receiver
            || verify_canonical_delta(configuration_delta) != Verification::Verified
        {
            return Err(CommandHostError::Fault(
                "invalid governing endpoint configuration".into(),
            ));
        }
        let mut operations = BTreeMap::new();
        let mut kinds = BTreeSet::new();
        for d in declarations {
            if d.claims.author != receiver || verify_canonical_delta(d) != Verification::Verified {
                return Err(CommandHostError::Fault(
                    "invalid governing operation declaration".into(),
                ));
            }
            let k = read_operation(d).map_err(CommandHostError::Fault)?;
            if operations.insert(d.id.clone(), k).is_some() || !kinds.insert(k.as_str()) {
                return Err(CommandHostError::Fault(
                    "duplicate installed operation kind".into(),
                ));
            }
        }
        if operations.keys().cloned().collect::<Vec<_>>() != configuration.installed
            || kinds.len() != 2
        {
            return Err(CommandHostError::Fault(
                "configuration requires exact retain and evaluate declarations".into(),
            ));
        }
        match open_ordinary_journal_peer_degraded(store, receiver)
            .map_err(CommandHostError::Fault)?
        {
            OrdinaryJournalOpenResult::Open(_) | OrdinaryJournalOpenResult::Degraded { .. } => {}
            _ => {
                return Err(CommandHostError::Fault(
                    "endpoint journal initialization refused".into(),
                ))
            }
        }
        let catalog = crate::set::DeltaSet::from_deltas(
            std::iter::once(configuration_delta.clone()).chain(declarations.iter().cloned()),
        )
        .map_err(CommandHostError::Fault)?;
        Ok(Self {
            receiver: receiver.into(),
            configuration_delta: configuration_delta.clone(),
            configuration,
            operations,
            catalog,
        })
    }
    pub fn receiver(&self) -> &str {
        &self.receiver
    }
    pub fn configuration_id(&self) -> &str {
        &self.configuration_delta.id
    }
    pub fn catalog(&self) -> crate::set::DeltaSet {
        self.catalog.clone()
    }
    fn sign_outcome(
        &self,
        entry_id: &str,
        received_at: f64,
        body: OutcomeBody,
        signer: &ResponseSigner<'_>,
        diagnostics: Vec<String>,
    ) -> Result<InvocationResult, CommandHostError> {
        let claims = Claims {
            author: self.receiver.clone(),
            timestamp: received_at,
            valid_from: received_at,
            valid_until: None,
            pointers: outcome_pointers(&Outcome {
                receiver: self.receiver.clone(),
                configuration: self.configuration_delta.id.clone(),
                request: entry_id.into(),
                body,
            })
            .map_err(CommandHostError::Fault)?,
        };
        let outcome = signer(&claims).map_err(CommandHostError::Fault)?;
        if outcome.claims != claims || verify_canonical_delta(&outcome) != Verification::Verified {
            return Err(CommandHostError::Fault(
                "response signing capability returned invalid testimony".into(),
            ));
        }
        Ok(InvocationResult {
            outcome,
            diagnostics,
        })
    }
    /// Decode untrusted JSON appearances at the public transport boundary. A canonical
    /// addressed ID can receive a signed refusal even when an appearance cannot be decoded.
    pub fn invoke_json<S: DurableOrdinaryJournalStore>(
        &self,
        store: &mut S,
        entry_id: &str,
        appearances: &[serde_json::Value],
        received_at: f64,
        signer: &ResponseSigner<'_>,
    ) -> Result<InvocationResult, CommandHostError> {
        if !is_content_id(entry_id) {
            return Err(CommandHostError::Transport(
                "entryId must be a canonical content address".into(),
            ));
        }
        if !received_at.is_finite() {
            return Err(CommandHostError::Fault(
                "receiver clock observation must be finite".into(),
            ));
        }
        if appearances.len() as u64 > self.configuration.max_deltas {
            return self.sign_outcome(
                entry_id,
                received_at,
                OutcomeBody::Refused {
                    code: "resource-limit".into(),
                },
                signer,
                Vec::new(),
            );
        }
        let captured = appearances.to_vec();
        let decoded = captured
            .iter()
            .map(crate::json_profile::parse_delta)
            .collect::<Result<Vec<_>, _>>();
        match decoded {
            Ok(deltas) => self.invoke(store, entry_id, &deltas, received_at, signer),
            Err(diagnostic) => self.sign_outcome(
                entry_id,
                received_at,
                OutcomeBody::Refused {
                    code: "invalid-appearance".into(),
                },
                signer,
                vec![diagnostic],
            ),
        }
    }

    /// Every attempt copies and verifies each appearance, then captures its current journal basis.
    /// `received_at` is the one explicit receiver clock observation for this attempt.
    pub fn invoke<S: DurableOrdinaryJournalStore>(
        &self,
        store: &mut S,
        entry_id: &str,
        appearances: &[Delta],
        received_at: f64,
        signer: &ResponseSigner<'_>,
    ) -> Result<InvocationResult, CommandHostError> {
        if !is_content_id(entry_id) {
            return Err(CommandHostError::Transport(
                "entryId must be a canonical content address".into(),
            ));
        }
        if !received_at.is_finite() {
            return Err(CommandHostError::Fault(
                "receiver clock observation must be finite".into(),
            ));
        }
        let captured = appearances.to_vec();
        let mut diagnostics = Vec::new();
        let body = match self.run(store, entry_id, &captured, received_at, &mut diagnostics) {
            Ok(body) => body,
            Err(AttemptError::Refused(code)) => OutcomeBody::Refused { code: code.into() },
            Err(AttemptError::Fault(error)) => return Err(CommandHostError::Fault(error)),
        };
        self.sign_outcome(entry_id, received_at, body, signer, diagnostics)
    }
    fn run<S: DurableOrdinaryJournalStore>(
        &self,
        store: &mut S,
        entry_id: &str,
        appearances: &[Delta],
        at: f64,
        diagnostics: &mut Vec<String>,
    ) -> Result<OutcomeBody, AttemptError> {
        if appearances.len() as u64 > self.configuration.max_deltas {
            return Err(AttemptError::Refused("resource-limit"));
        }
        let mut size = 0_u64;
        for d in appearances {
            let bytes = crate::delta::canonical_bytes(&d.claims)
                .map_err(|_| AttemptError::Refused("invalid-appearance"))?;
            let signature = hex::decode(d.sig.as_deref().unwrap_or(""))
                .map_err(|_| AttemptError::Refused("invalid-appearance"))?;
            size = size
                .checked_add(bytes.len() as u64)
                .and_then(|n| n.checked_add(signature.len() as u64))
                .ok_or(AttemptError::Refused("resource-limit"))?;
        }
        if size > self.configuration.max_bytes {
            return Err(AttemptError::Refused("resource-limit"));
        }
        if appearances.iter().any(|d| {
            !is_author(&d.claims.author) || verify_canonical_delta(d) != Verification::Verified
        }) {
            return Err(AttemptError::Refused("invalid-appearance"));
        }
        let supplied: BTreeMap<String, Delta> = appearances
            .iter()
            .map(|d| (d.id.clone(), d.clone()))
            .collect();
        let entry = supplied
            .get(entry_id)
            .ok_or(AttemptError::Refused("entry-missing"))?;
        let common =
            read_common_request(entry).map_err(|_| AttemptError::Refused("invalid-request"))?;
        if !valid_at(entry, at) {
            return Err(AttemptError::Refused("request-outside-validity"));
        }
        if common.receiver != self.receiver
            || common.configuration != self.configuration_delta.id
            || !valid_at(&self.configuration_delta, at)
            || self.catalog.iter().any(|d| !valid_at(d, at))
        {
            return Err(AttemptError::Refused("configuration-mismatch"));
        }
        if !self.configuration.callers.contains(&entry.claims.author) {
            return Err(AttemptError::Refused("unauthorized"));
        }
        let kind = *self
            .operations
            .get(&common.operation)
            .ok_or(AttemptError::Refused("unsupported-operation"))?;
        let request =
            read_request(entry, kind).map_err(|_| AttemptError::Refused("invalid-arguments"))?;
        let refs = match &request.arguments {
            RequestArguments::Retain(ids) => ids.clone(),
            RequestArguments::Evaluate(a) => std::iter::once(a.hyperschema.clone())
                .chain(std::iter::once(a.schema.clone()))
                .chain(a.definitions.iter().cloned())
                .collect(),
        };
        if refs.iter().any(|id| !supplied.contains_key(id)) {
            return Err(AttemptError::Refused("missing-support"));
        }
        let reachable: BTreeSet<&str> = std::iter::once(entry_id)
            .chain(refs.iter().map(String::as_str))
            .collect();
        if supplied.keys().any(|id| !reachable.contains(id.as_str())) {
            return Err(AttemptError::Refused("unexpected-support"));
        }
        match &request.arguments {
            RequestArguments::Retain(ids) => {
                self.retain(store, &request, ids, &supplied, at, diagnostics)
            }
            RequestArguments::Evaluate(_) => {
                Err(AttemptError::Fault("evaluate unavailable before M3".into()))
            }
        }
    }
    fn retain<S: DurableOrdinaryJournalStore>(
        &self,
        store: &mut S,
        request: &Request,
        ids: &[String],
        supplied: &BTreeMap<String, Delta>,
        at: f64,
        diagnostics: &mut Vec<String>,
    ) -> Result<OutcomeBody, AttemptError> {
        let (mut peer, source) = match capture_existing_ordinary_source(store, &self.receiver) {
            OrdinarySourceCapture::Captured { peer, deltas } => (peer, deltas),
            OrdinarySourceCapture::SourceChanged => {
                return Err(AttemptError::Refused("source-changed"))
            }
            OrdinarySourceCapture::SourceUnavailable { diagnostic } => {
                diagnostics.push(diagnostic);
                return Err(AttemptError::Refused("source-unavailable"));
            }
        };
        let before_head = peer
            .current_head()
            .map_err(AttemptError::Fault)?
            .to_string();
        if request
            .common
            .expected_head
            .as_ref()
            .is_some_and(|h| h != &before_head)
        {
            return Err(AttemptError::Refused("precondition-failed"));
        }
        let before_digest = source.digest();
        let state = peer.snapshot().map_err(AttemptError::Fault)?;
        let offered: Vec<Delta> = ids.iter().map(|id| supplied[id].clone()).collect();
        let capacity = self.configuration.quota.saturating_sub(state.quota_used);
        let result = peer
            .admit(
                store,
                &SinglePeerTransferInput {
                    offered: &offered,
                    origin: &ArrivalOrigin::Unattributed,
                    arrived_at: at,
                    policy_state: &(),
                    guards: &[],
                    is_erasure_candidate: &|_| false,
                    mode: TransferMode::Atomic,
                    capacity: Some(usize::try_from(capacity).unwrap_or(usize::MAX)),
                },
            )
            .map_err(AttemptError::Fault)?;
        match result {
            OrdinaryJournalAdmissionResult::Committed { outcomes, head, .. } => {
                let mut admitted = Vec::new();
                let mut duplicate = Vec::new();
                for o in outcomes {
                    match o.status {
                        crate::signed_loose_admission::SignedLooseOutcomeStatus::Admitted => {
                            admitted.push(o.id)
                        }
                        crate::signed_loose_admission::SignedLooseOutcomeStatus::Duplicate => {
                            duplicate.push(o.id)
                        }
                        _ => {
                            return Err(AttemptError::Fault(
                                "atomic confirmed admission contains rejected candidate".into(),
                            ))
                        }
                    }
                }
                admitted.sort();
                duplicate.sort();
                Ok(OutcomeBody::Retain {
                    before_head,
                    head,
                    before_digest,
                    digest: peer
                        .available_deltas()
                        .map_err(AttemptError::Fault)?
                        .digest(),
                    admitted,
                    duplicate,
                })
            }
            OrdinaryJournalAdmissionResult::Conflict => {
                Err(AttemptError::Refused("write-conflict"))
            }
            OrdinaryJournalAdmissionResult::CommittedUnconfirmed { fault } => {
                diagnostics.push(fault);
                Ok(OutcomeBody::Indeterminate)
            }
            OrdinaryJournalAdmissionResult::Rejected { .. }
            | OrdinaryJournalAdmissionResult::AbsenceRefuted { .. } => {
                Err(AttemptError::Refused("admission-rejected"))
            }
        }
    }
}
enum AttemptError {
    Refused(&'static str),
    Fault(String),
}
