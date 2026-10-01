//! Composition of command descriptions with their semantic owners and explicit capabilities.
use crate::command_data::{
    is_author, read_outcome, read_request, OperationKind, Outcome, OutcomeBody, RequestArguments,
};
use crate::resolution::{decode_view, View};
use crate::sign::{verify_delta, Verification};
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
    if verify_delta(delta) != Verification::Verified || !is_author(&delta.claims.author) {
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
        if verify_delta(request) != Verification::Verified || request.id != outcome.request {
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
