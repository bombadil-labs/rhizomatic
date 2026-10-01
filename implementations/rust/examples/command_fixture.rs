//! Fixed conformance transport. All semantic ports exchange signed Delta debug descriptions.
use rhizomatic::command_data::{
    read_common_request, read_operation, read_request, request_pointers,
};
use rhizomatic::json_profile::{claims_to_json, parse_claims};
use rhizomatic::sign::{sign_claims, verify_delta, Verification};
use rhizomatic::types::Delta;
use serde_json::{json, Value};
#[path = "support/command_store.rs"]
mod command_store;
use std::io::{self, Read};
fn delta(v: &Value) -> Result<Delta, String> {
    rhizomatic::json_profile::parse_delta(v)
}

fn debug(d: &Delta) -> Value {
    json!({"id":d.id,"claims":claims_to_json(&d.claims),"sig":d.sig})
}
fn sign_description(v: &Value) -> Result<Delta, String> {
    sign_claims(
        &parse_claims(&v["claims"])?,
        v["seed"].as_str().ok_or("fixture seed required")?,
    )
}
fn operation(context: &Value, id: &str) -> Result<rhizomatic::command_data::OperationKind, String> {
    for v in context["boot"]["declarations"]
        .as_array()
        .ok_or("boot declarations required")?
    {
        let d = delta(v)?;
        if d.id == id {
            return read_operation(&d);
        }
    }
    Err("fixture operation absent".into())
}
fn validate(artifact: &Value, context: &Value) -> Result<(), String> {
    if artifact["format"] != "rhizomatic-command-artifact/1" {
        return Err("artifact version".into());
    }
    let id = artifact["entryId"].as_str().ok_or("entryId required")?;
    if !rhizomatic::command_data::is_content_id(id) {
        return Err("canonical entryId required".into());
    }
    let deltas = artifact["deltas"]
        .as_array()
        .ok_or("deltas required")?
        .iter()
        .map(delta)
        .collect::<Result<Vec<_>, _>>()?;
    if deltas
        .iter()
        .any(|d| verify_delta(d) != Verification::Verified)
    {
        return Err("invalid signed appearance".into());
    }
    let entry = deltas.iter().find(|d| d.id == id).ok_or("entry missing")?;
    let common = read_common_request(entry)?;
    read_request(entry, operation(context, &common.operation)?)?;
    Ok(())
}
fn run(input: &Value) -> Result<Value, String> {
    let context = &input["context"];
    match input["mode"].as_str().ok_or("mode required")? {
        "construct" => {
            let construction = &context["construction"];
            let mut request = sign_description(&construction["request"])?;
            let common = read_common_request(&request)?;
            let parsed = read_request(&request, operation(context, &common.operation)?)?;
            request.claims.pointers = request_pointers(&parsed)?;
            request = sign_claims(
                &request.claims,
                construction["request"]["seed"]
                    .as_str()
                    .ok_or("request seed")?,
            )?;
            let mut deltas = vec![debug(&request)];
            for support in construction["support"]
                .as_array()
                .ok_or("support array required")?
            {
                deltas.push(debug(&sign_description(support)?));
            }
            Ok(
                json!({"artifact":{"format":"rhizomatic-command-artifact/1","entryId":request.id,"deltas":deltas}}),
            )
        }
        "validate" => {
            let verdict = match validate(&input["artifact"], context) {
                Ok(()) => json!({"valid":true}),
                Err(error) => json!({"valid":false,"diagnostic":error}),
            };
            Ok(json!({"artifact":input["artifact"],"verdict":verdict}))
        }
        "read-result" => {
            let outcome = delta(&input["outcome"])?;
            let completed = rhizomatic::command_data::read_outcome(&outcome)?
                .body
                .status()
                == "completed";
            let request = if completed {
                input["artifact"]["deltas"]
                    .as_array()
                    .and_then(|xs| xs.iter().find(|v| v["id"] == input["artifact"]["entryId"]))
                    .map(delta)
                    .transpose()?
            } else {
                None
            };
            let boot = delta(&context["boot"]["configuration"])?;
            let expected = rhizomatic::command::ReadResultContext {
                receiver: rhizomatic::command_data::read_configuration(&boot)?.receiver,
                configuration: boot.id,
                request: input["artifact"]["entryId"]
                    .as_str()
                    .ok_or("expected addressed entry required")?
                    .into(),
            };
            let result = rhizomatic::command::read_result(&outcome, &expected, request.as_ref())?;
            if result.outcome.body.status() == "completed" && request.is_none() {
                return Err("completed outcome requires the addressed fixture request".into());
            }
            let body = rhizomatic::command_data::write_outcome_body(&result.outcome.body)?;
            let mut out =
                json!({"status":result.outcome.body.status(),"bodyHex":hex::encode(body)});
            if let Some(value) = result.value {
                out["valueHex"] = json!(rhizomatic::view_canonical_hex(&value));
            }
            Ok(out)
        }
        "execute" => execute(input),
        _ => Err("unknown mode".into()),
    }
}
fn execute(input: &Value) -> Result<Value, String> {
    use rhizomatic::ordinary_journal_peer::{
        open_ordinary_journal_peer, DurableOrdinaryJournalStore, OrdinaryJournalOpenResult,
    };
    let context = &input["context"];
    let seed = context["receiverSeed"]
        .as_str()
        .ok_or("receiverSeed required")?;
    let receiver = rhizomatic::sign::author_for_seed(seed)?;
    let configuration = delta(&context["boot"]["configuration"])?;
    let declarations = context["boot"]["declarations"]
        .as_array()
        .ok_or("declarations required")?
        .iter()
        .map(delta)
        .collect::<Result<Vec<_>, _>>()?;
    let fault = context["fault"].as_str().map(str::to_string);
    let mut store = command_store::DiskJournal::new(
        context["storePath"].as_str().ok_or("storePath required")?,
        None,
    );
    let endpoint = rhizomatic::command::CommandEndpoint::boot(
        &receiver,
        &configuration,
        &declarations,
        &mut store,
    )
    .map_err(|e| format!("{e:?}"))?;
    let received_at = context["receivedAt"]
        .as_f64()
        .ok_or("receivedAt required")?;
    let initial = context["initialDeltas"]
        .as_array()
        .map(|xs| xs.iter().map(delta).collect::<Result<Vec<_>, _>>())
        .transpose()?
        .unwrap_or_default();
    if !initial.is_empty() {
        let OrdinaryJournalOpenResult::Open(mut peer) =
            open_ordinary_journal_peer(&mut store, &receiver)?
        else {
            return Err("fixture initial source unavailable".into());
        };
        peer.admit(
            &mut store,
            &rhizomatic::single_peer::SinglePeerTransferInput {
                offered: &initial,
                origin: &rhizomatic::single_peer::ArrivalOrigin::Unattributed,
                arrived_at: context["initialAt"].as_f64().unwrap_or(received_at),
                policy_state: &(),
                guards: &[],
                is_erasure_candidate: &|_| false,
                mode: rhizomatic::single_peer::TransferMode::Atomic,
                capacity: None,
            },
        )?;
    }
    store.fault = fault.clone();
    let appearances = input["artifact"]["deltas"]
        .as_array()
        .ok_or("artifact deltas required")?;
    let entry_id = input["artifact"]["entryId"]
        .as_str()
        .ok_or("entryId required")?;
    let signer = |claims: &rhizomatic::Claims| {
        if fault.as_deref() == Some("signing-failure") {
            Err("injected response signing failure".into())
        } else {
            sign_claims(claims, seed)
        }
    };
    let result = endpoint
        .invoke_json(&mut store, entry_id, appearances, received_at, &signer)
        .map_err(|e| format!("{e:?}"))?;
    if fault.as_deref() == Some("transport-failure") {
        std::process::exit(78);
    }
    store.fault = None;
    let observed = match rhizomatic::ordinary_journal_peer::capture_existing_ordinary_source(
        &mut store, &receiver,
    ) {
        rhizomatic::ordinary_journal_peer::OrdinarySourceCapture::Captured { peer, .. } => {
            let state = peer.snapshot()?;
            json!({"head":peer.current_head()?,"ids":peer.available_deltas()?.ids(),"quotaUsed":state.quota_used,"arrivals":state.base.arrivals.iter().map(|a|json!({"id":a.id,"at":a.at,"sequence":a.sequence,"transfer":a.transfer,"sender":a.sender})).collect::<Vec<_>>()})
        }
        _ => json!({"unavailable":true}),
    };
    let _ = store.read_head(&receiver)?;
    Ok(json!({"outcome":debug(&result.outcome),"observed":observed}))
}
fn main() {
    let mut bytes = String::new();
    let result = io::stdin()
        .read_to_string(&mut bytes)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str(&bytes).map_err(|e| e.to_string()))
        .and_then(|v| run(&v));
    match result {
        Ok(out) => println!("{out}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refusal_reads_undecodable_request_with_explicit_context() {
        let mut fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../vectors/command/transport.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut outcome = delta(&fixture["outcome"]).unwrap();
        let mut decoded = rhizomatic::command_data::read_outcome(&outcome).unwrap();
        decoded.body = rhizomatic::command_data::OutcomeBody::Refused {
            code: "invalid-appearance".into(),
        };
        outcome.claims.pointers = rhizomatic::command_data::outcome_pointers(&decoded).unwrap();
        outcome = sign_claims(&outcome.claims, &"01".repeat(32)).unwrap();
        fixture["expectedArtifact"]["deltas"][0]["claims"] = json!({});
        let mut invocation = json!({"mode":"read-result", "context":fixture["context"], "artifact":fixture["expectedArtifact"], "outcome":debug(&outcome)});
        assert_eq!(run(&invocation).unwrap()["status"], "refused");
        invocation["artifact"]["entryId"] = json!(format!("1e20{}", "ff".repeat(32)));
        assert!(run(&invocation).is_err());
    }
}
