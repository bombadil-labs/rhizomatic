//! Actual subprocess termination and fresh-process journal recovery.
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
#[path = "../examples/support/command_store.rs"]
mod command_store;
fn delta(v: &Value) -> Result<rhizomatic::Delta, String> {
    rhizomatic::json_profile::parse_delta(v)
}
fn debug(d: &rhizomatic::Delta) -> Value {
    json!({"id":d.id,"claims":rhizomatic::json_profile::claims_to_json(&d.claims),"sig":d.sig})
}

fn adapter() -> &'static Path {
    static ADAPTER: OnceLock<PathBuf> = OnceLock::new();
    ADAPTER.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let built = Command::new(env!("CARGO"))
            .args(["build", "--quiet", "--example", "command_fixture"])
            .current_dir(&manifest)
            .status()
            .unwrap();
        assert!(built.success());
        let metadata: Value = serde_json::from_slice(
            &Command::new(env!("CARGO"))
                .args(["metadata", "--no-deps", "--format-version", "1"])
                .current_dir(&manifest)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        PathBuf::from(metadata["target_directory"].as_str().unwrap())
            .join("debug/examples/command_fixture")
    })
}
fn run(input: &Value) -> Output {
    let mut child = Command::new(adapter())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
fn successful(input: &Value) -> Value {
    let out = run(input);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn result(out: &Value) -> rhizomatic::command_data::OutcomeBody {
    rhizomatic::command_data::read_outcome(
        &rhizomatic::json_profile::parse_delta(&out["outcome"]).unwrap(),
    )
    .unwrap()
    .body
}
#[test]
fn actual_crash_uncertainty_and_delivery_reopen_shared_fixtures() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(manifest.join("../../vectors/command/execution.json")).unwrap(),
    )
    .unwrap();
    let context = &vectors["cases"][0]["context"];
    let request = &vectors["fixtures"]["request"];
    let payload = &vectors["fixtures"]["first"];
    let directory = tempfile::tempdir().unwrap();
    for (fault, code, persisted) in [
        ("crash-before-append", Some(77), false),
        ("crash-after-append", Some(77), true),
        ("transport-failure", Some(78), true),
        ("signing-failure", Some(1), true),
        ("committed-unconfirmed-absent", None, false),
        ("committed-unconfirmed-persist", None, true),
        ("append-error-absent", None, false),
        ("append-error-persist", None, true),
    ] {
        let mut input = json!({"mode":"execute","context":context,"artifact":{"format":"rhizomatic-command-artifact/1","entryId":request["id"],"deltas":[request,payload]}});
        input["context"]["storePath"] = json!(directory.path().join(format!("{fault}.json")));
        input["context"]["fault"] = json!(fault);
        let out = run(&input);
        if let Some(code) = code {
            assert_eq!(
                out.status.code(),
                Some(code),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(out.stdout.is_empty());
        } else {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let out: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(
                result(&out),
                rhizomatic::command_data::OutcomeBody::Indeterminate
            );
        }
        input["context"].as_object_mut().unwrap().remove("fault");
        let reopened = successful(&input);
        let rhizomatic::command_data::OutcomeBody::Retain {
            admitted,
            duplicate,
            ..
        } = result(&reopened)
        else {
            panic!("completed retain")
        };
        assert_eq!(
            admitted,
            if persisted {
                vec![]
            } else {
                vec![payload["id"].as_str().unwrap().to_string()]
            }
        );
        assert_eq!(
            duplicate,
            if persisted {
                vec![payload["id"].as_str().unwrap().to_string()]
            } else {
                vec![]
            }
        );
        assert_eq!(
            reopened["observed"]["arrivals"].as_array().unwrap().len(),
            1
        );
        assert_eq!(reopened["observed"]["ids"], json!([payload["id"]]));
        assert_eq!(reopened["observed"]["quotaUsed"], 1);
        // One more new process proves replay is a no-op after confirmed persistence.
        let replay = successful(&input);
        assert_eq!(replay["observed"], reopened["observed"]);
        let scenario = match fault {
            "crash-before-append" => "crash_before_append",
            "crash-after-append" => "crash_after_append",
            "signing-failure" | "transport-failure" => "response_delivery_failure",
            _ => "commit_unconfirmed",
        };
        println!("command-case:{scenario}:command_durable::{fault}");
    }
}

#[test]
fn independently_opened_writer_conflicts_between_capture_and_append() {
    use rhizomatic::command::CommandEndpoint;
    use rhizomatic::command_data::{read_configuration, read_outcome, OutcomeBody};
    use rhizomatic::ordinary_journal_peer::{
        capture_existing_ordinary_source, OrdinarySourceCapture,
    };
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(manifest.join("../../vectors/command/execution.json")).unwrap(),
    )
    .unwrap();
    let context = &vectors["cases"][0]["context"];
    let config = delta(&context["boot"]["configuration"]).unwrap();
    let declarations = context["boot"]["declarations"]
        .as_array()
        .unwrap()
        .iter()
        .map(delta)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let receiver = read_configuration(&config).unwrap().receiver;
    let seed = context["receiverSeed"].as_str().unwrap().to_string();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("concurrent.json");
    let mut store = command_store::DiskJournal::new(path.to_str().unwrap(), None);
    let endpoint = CommandEndpoint::boot(&receiver, &config, &declarations, &mut store).unwrap();
    let second = delta(&vectors["fixtures"]["second"]).unwrap();
    let second_request = delta(&vectors["fixtures"]["secondRequest"]).unwrap();
    let original = delta(&vectors["fixtures"]["first"]).unwrap();
    let request = delta(&vectors["fixtures"]["request"]).unwrap();
    let (other_receiver, other_seed) = (receiver.clone(), seed.clone());
    store.before_append = Some(Box::new(move || {
        let mut separate = command_store::DiskJournal::new(path.to_str().unwrap(), None);
        let other = CommandEndpoint::boot(&other_receiver, &config, &declarations, &mut separate)
            .map_err(|e| format!("{e:?}"))?;
        let out = other
            .invoke(
                &mut separate,
                &second_request.id,
                &[second_request.clone(), second.clone()],
                10.0,
                &|c| rhizomatic::sign::sign_claims(c, &other_seed),
            )
            .map_err(|e| format!("{e:?}"))?;
        assert_eq!(read_outcome(&out.outcome)?.body.status(), "completed");
        Ok(())
    }));
    let invoke = |store: &mut command_store::DiskJournal| {
        endpoint
            .invoke(
                store,
                &request.id,
                &[request.clone(), original.clone()],
                10.0,
                &|c| rhizomatic::sign::sign_claims(c, &seed),
            )
            .unwrap()
            .outcome
    };
    assert_eq!(
        read_outcome(&invoke(&mut store)).unwrap().body,
        OutcomeBody::Refused {
            code: "write-conflict".into()
        }
    );
    assert_eq!(
        read_outcome(&invoke(&mut store)).unwrap().body.status(),
        "completed"
    );
    let OrdinarySourceCapture::Captured { peer, deltas } =
        capture_existing_ordinary_source(&mut store, &receiver)
    else {
        panic!("capture")
    };
    assert_eq!(deltas.len(), 2);
    assert_eq!(peer.snapshot().unwrap().base.arrivals.len(), 2);
    println!("command-case:write_conflict:command_durable::independent_writer");
}

#[test]
fn every_shared_retained_description_stays_inert() {
    use rhizomatic::ordinary_journal_peer::{
        capture_existing_ordinary_source, OrdinarySourceCapture,
    };
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/command/execution.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("inert.json");
    let request = &vectors["fixtures"]["inertRequest"];
    let mut deltas = vec![request.clone()];
    deltas.extend(
        vectors["fixtures"]["inert"]
            .as_array()
            .unwrap()
            .iter()
            .cloned(),
    );
    let mut input = json!({"mode":"execute","context":vectors["cases"][0]["context"],"artifact":{"format":"rhizomatic-command-artifact/1","entryId":request["id"],"deltas":deltas}});
    input["context"]["storePath"] = json!(path);
    let out = successful(&input);
    assert_eq!(result(&out).status(), "completed");
    assert_eq!(out["observed"]["ids"].as_array().unwrap().len(), 6);
    let mut store = command_store::DiskJournal::new(path.to_str().unwrap(), None);
    let receiver =
        rhizomatic::sign::author_for_seed(input["context"]["receiverSeed"].as_str().unwrap())
            .unwrap();
    let OrdinarySourceCapture::Captured { peer, deltas } =
        capture_existing_ordinary_source(&mut store, &receiver)
    else {
        panic!("source")
    };
    let state = peer.snapshot().unwrap();
    assert!(state.events.is_empty() && state.exclusions.is_empty() && state.obligations.is_empty());
    assert!(!deltas.contains(vectors["fixtures"]["first"]["id"].as_str().unwrap()));
    println!("command-case:retained_request_inert:command_durable::all_shared_descriptions");
    println!(
        "command-case:configuration_not_self_installing:command_durable::all_shared_descriptions"
    );
}
