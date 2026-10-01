use rhizomatic::command::{CommandEndpoint, ReadResultContext};
use rhizomatic::command_data::*;
use rhizomatic::ordinary_journal_peer::*;
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::single_peer::{ArrivalOrigin, PeerImageWrite, TransferMode};
use rhizomatic::types::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Default)]
struct Journal {
    head: Option<String>,
    frames: Vec<Vec<u8>>,
    rows: BTreeMap<String, Delta>,
    fault: Option<&'static str>,
    changed: bool,
    writes: usize,
}
impl DurableOrdinaryJournalStore for Journal {
    fn read_journal(&self, _: &str) -> Result<OrdinaryJournalRead, String> {
        Ok(match &self.head {
            Some(head) => OrdinaryJournalRead::Journal {
                head: head.clone(),
                frames: self.frames.clone(),
                checkpoint: None,
            },
            None if self.rows.is_empty() => OrdinaryJournalRead::Empty,
            None => OrdinaryJournalRead::RowsWithoutJournal,
        })
    }
    fn read_admitted_rows(&self, _: &str, ids: &[String]) -> Result<Vec<Delta>, String> {
        Ok(ids
            .iter()
            .filter_map(|id| self.rows.get(id).cloned())
            .collect())
    }
    fn read_admitted_rows_degraded(
        &self,
        _: &str,
        ids: &[String],
    ) -> Result<Vec<AdmittedRowRead>, String> {
        Ok(ids
            .iter()
            .map(|id| AdmittedRowRead {
                id: id.clone(),
                row: self.rows.get(id).cloned(),
                fault: None,
            })
            .collect())
    }
    fn read_head(&self, _: &str) -> Result<OrdinaryJournalHead, String> {
        Ok(if self.changed {
            OrdinaryJournalHead::Head(format!("1e20{}", "ff".repeat(32)))
        } else {
            self.head
                .as_ref()
                .map(|h| OrdinaryJournalHead::Head(h.clone()))
                .unwrap_or(OrdinaryJournalHead::Missing)
        })
    }
    fn compare_and_append(
        &mut self,
        _: &str,
        expected: Option<&str>,
        next: &str,
        frame: Option<&[u8]>,
        rows: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        self.writes += 1;
        if self.head.as_deref() != expected || (expected.is_none() && !self.rows.is_empty()) {
            return Ok(PeerImageWrite::Conflict);
        }
        let fault = if frame.is_some() {
            self.fault.take()
        } else {
            None
        };
        if fault == Some("conflict") {
            return Ok(PeerImageWrite::Conflict);
        }
        if fault == Some("uncertain-absent") {
            return Ok(PeerImageWrite::CommittedUnconfirmed {
                fault: "injected uncertainty without append".into(),
            });
        }
        if fault == Some("error-absent") {
            return Err("injected unknown append error".into());
        }
        self.head = Some(next.into());
        if let Some(frame) = frame {
            self.frames.push(frame.to_vec());
        }
        for d in rows {
            self.rows.insert(d.id.clone(), d.clone());
        }
        if fault == Some("uncertain-persist") {
            return Ok(PeerImageWrite::CommittedUnconfirmed {
                fault: "injected durable acknowledgment loss".into(),
            });
        }
        if fault == Some("error-persist") {
            return Err("injected error after append".into());
        }
        Ok(PeerImageWrite::Durable)
    }
    fn compare_and_append_erasure(
        &mut self,
        p: &str,
        e: &str,
        n: &str,
        f: &[u8],
        ds: &[Delta],
        absent: &[String],
    ) -> Result<ErasureJournalWrite, String> {
        if let Some(id) = absent.iter().find(|id| self.rows.contains_key(*id)) {
            return Ok(ErasureJournalWrite::AbsenceRefuted {
                target_id: id.clone(),
            });
        }
        self.compare_and_append(p, Some(e), n, Some(f), ds)
            .map(Into::into)
    }
}
struct Rig {
    peer: String,
    seed: String,
    caller_seed: String,
    config: Delta,
    declarations: Vec<Delta>,
    endpoint: CommandEndpoint,
    store: Journal,
}
fn signed(seed: &str, pointers: Vec<Pointer>, timestamp: f64) -> Delta {
    sign_claims(
        &Claims {
            author: author_for_seed(seed).unwrap(),
            timestamp,
            valid_from: 0.0,
            valid_until: None,
            pointers,
        },
        seed,
    )
    .unwrap()
}
fn fact(n: f64) -> Delta {
    signed(
        &"05".repeat(32),
        vec![
            Pointer {
                role: "entity".into(),
                target: Target::Entity(EntityRef {
                    id: "tree".into(),
                    context: Some("height".into()),
                }),
            },
            Pointer {
                role: "value".into(),
                target: Target::Primitive(Primitive::Num(n)),
            },
        ],
        1.0,
    )
}
impl Rig {
    fn new(quota: u64) -> Self {
        let seed = "03".repeat(32);
        let caller_seed = "04".repeat(32);
        let peer = author_for_seed(&seed).unwrap();
        let declarations = vec![
            signed(&seed, operation_pointers(OperationKind::Retain), 0.0),
            signed(&seed, operation_pointers(OperationKind::Evaluate), 0.0),
        ];
        let config = signed(
            &seed,
            configuration_pointers(&Configuration {
                receiver: peer.clone(),
                callers: vec![author_for_seed(&caller_seed).unwrap()],
                installed: declarations.iter().map(|d| d.id.clone()).collect(),
                quota,
                max_deltas: 100,
                max_bytes: 1_000_000,
            })
            .unwrap(),
            0.0,
        );
        let mut store = Journal::default();
        let endpoint = CommandEndpoint::boot(&peer, &config, &declarations, &mut store).unwrap();
        Self {
            peer,
            seed,
            caller_seed,
            config,
            declarations,
            endpoint,
            store,
        }
    }
    fn request(&self, payload: &[Delta], head: Option<String>) -> Delta {
        signed(
            &self.caller_seed,
            request_pointers(&Request {
                common: CommonRequest {
                    receiver: self.peer.clone(),
                    configuration: self.config.id.clone(),
                    operation: self.declarations[0].id.clone(),
                    expected_head: head,
                },
                arguments: RequestArguments::Retain(payload.iter().map(|d| d.id.clone()).collect()),
            })
            .unwrap(),
            1.0,
        )
    }
    fn invoke(&mut self, request: &Delta, appearances: &[Delta], at: f64) -> Delta {
        self.endpoint
            .invoke(&mut self.store, &request.id, appearances, at, &|c| {
                sign_claims(c, &self.seed)
            })
            .unwrap()
            .outcome
    }
    fn offer(&mut self, payload: &[Delta], head: Option<String>, at: f64) -> (Delta, Delta) {
        let request = self.request(payload, head);
        let appearances = std::iter::once(request.clone())
            .chain(payload.iter().cloned())
            .collect::<Vec<_>>();
        let outcome = self.invoke(&request, &appearances, at);
        (request, outcome)
    }
}
fn refusal(out: &Delta, code: &str) {
    assert_eq!(
        read_outcome(out).unwrap().body,
        OutcomeBody::Refused { code: code.into() }
    );
}
fn evidence(id: &str) {
    println!("command-case:{id}:command_runtime::{id}");
}
#[test]
fn endpoint_boot_and_rows_without_journal() {
    let rig = Rig::new(20);
    let mut wrong = rig.config.clone();
    wrong.claims.author = author_for_seed(&"06".repeat(32)).unwrap();
    assert!(CommandEndpoint::boot(
        &rig.peer,
        &wrong,
        &rig.declarations,
        &mut Journal::default()
    )
    .is_err());
    assert!(CommandEndpoint::boot(
        &rig.peer,
        &rig.config,
        &[rig.declarations[0].clone(), rig.declarations[0].clone()],
        &mut Journal::default()
    )
    .is_err());
    let mut raw = Journal::default();
    raw.rows.insert(fact(42.0).id.clone(), fact(42.0));
    assert!(CommandEndpoint::boot(&rig.peer, &rig.config, &rig.declarations, &mut raw).is_err());
    evidence("endpoint_boot");
    evidence("rows_without_journal");
}
#[test]
fn retain_only_payload_and_outcome_partition() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let (request, outcome) = rig.offer(std::slice::from_ref(&payload), None, 10.0);
    assert_eq!(rig.store.rows.get(&payload.id), Some(&payload));
    assert!(!rig.store.rows.contains_key(&request.id));
    assert!(!rig.store.rows.contains_key(&outcome.id));
    let OrdinarySourceCapture::Captured { peer, deltas } =
        capture_existing_ordinary_source(&mut rig.store, &rig.peer)
    else {
        panic!("capture")
    };
    assert_eq!(deltas.digest(), peer.available_deltas().unwrap().digest());
    let state = peer.snapshot().unwrap();
    assert_eq!(state.base.arrivals.len(), 1);
    assert_eq!(state.base.arrivals[0].sender, "unattributed");
    assert_eq!(state.base.arrivals[0].at, 10.0);
    let second = fact(43.0);
    let (request, outcome) = rig.offer(&[second.clone(), payload.clone()], None, 11.0);
    let result = rhizomatic::command::read_result(
        &outcome,
        &ReadResultContext {
            receiver: rig.peer.clone(),
            configuration: rig.config.id.clone(),
            request: request.id.clone(),
        },
        Some(&request),
    )
    .unwrap();
    let OutcomeBody::Retain {
        admitted,
        duplicate,
        before_head,
        head,
        before_digest,
        digest,
    } = result.outcome.body
    else {
        panic!("retain")
    };
    assert_eq!(admitted, vec![second.id]);
    assert_eq!(duplicate, vec![payload.id]);
    assert_ne!(before_head, head);
    assert_ne!(before_digest, digest);
    evidence("retain_only_payload");
    evidence("retain_outcome_partition");
}
#[test]
fn retain_duplicates_reopen_and_expected_head() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let (request, first) = rig.offer(std::slice::from_ref(&payload), Some(String::new()), 10.0);
    assert_eq!(read_outcome(&first).unwrap().body.status(), "completed");
    let writes = rig.store.writes;
    let out = rig.invoke(&request, &[request.clone(), payload.clone()], 11.0);
    refusal(&out, "precondition-failed");
    rig.endpoint =
        CommandEndpoint::boot(&rig.peer, &rig.config, &rig.declarations, &mut rig.store).unwrap();
    let (_, duplicate) = rig.offer(std::slice::from_ref(&payload), None, 12.0);
    let OutcomeBody::Retain {
        admitted,
        duplicate,
        ..
    } = read_outcome(&duplicate).unwrap().body
    else {
        panic!("retain")
    };
    assert!(admitted.is_empty());
    assert_eq!(duplicate, vec![payload.id]);
    assert_eq!(rig.store.writes, writes);
    assert_eq!(rig.store.frames.len(), 1);
    evidence("retain_duplicates");
    evidence("expected_head_write");
}
#[test]
fn invalid_and_valid_duplicate_appearances() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let request = rig.request(std::slice::from_ref(&payload), None);
    let mut invalid = payload.clone();
    invalid.sig = Some("00".repeat(64));
    for appearances in [
        vec![request.clone(), payload.clone(), invalid.clone()],
        vec![invalid, request.clone(), payload.clone()],
    ] {
        let out = rig.invoke(&request, &appearances, 10.0);
        refusal(&out, "invalid-appearance");
        assert!(rig.store.rows.is_empty());
    }
    let out = rig.invoke(
        &request,
        &[request.clone(), payload.clone(), payload.clone()],
        10.0,
    );
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    let mut invalid = payload.clone();
    invalid.sig = None;
    let out = rig.invoke(&request, &[request.clone(), payload, invalid], 11.0);
    refusal(&out, "invalid-appearance");
    assert_eq!(rig.store.frames.len(), 1);
    evidence("invalid_duplicate_appearance");
    evidence("valid_duplicate_appearance");
    evidence("unsigned_payload");
}
#[test]
fn quota_is_atomic_and_support_is_explicit() {
    let mut rig = Rig::new(1);
    let a = fact(42.0);
    let b = fact(43.0);
    let (_, out) = rig.offer(&[a.clone(), b.clone()], None, 10.0);
    refusal(&out, "admission-rejected");
    assert!(rig.store.rows.is_empty());
    let request = rig.request(std::slice::from_ref(&a), None);
    let out = rig.invoke(&request, &[request.clone(), b.clone()], 10.0);
    refusal(&out, "missing-support");
    let out = rig.invoke(&request, &[request.clone(), a.clone(), b], 10.0);
    refusal(&out, "unexpected-support");
    let out = rig.invoke(&request, &[request.clone(), a], 10.0);
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    evidence("retain_atomic_quota");
    evidence("missing_and_extra_support");
}
#[test]
fn authorization_and_request_half_open_validity() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let mut request = rig.request(std::slice::from_ref(&payload), None);
    request.claims.valid_from = 10.0;
    request.claims.valid_until = Some(20.0);
    request = sign_claims(&request.claims, &rig.caller_seed).unwrap();
    for (at, code) in [
        (9.0, Some("request-outside-validity")),
        (10.0, None),
        (19.999, None),
        (20.0, Some("request-outside-validity")),
    ] {
        let out = rig.invoke(&request, &[request.clone(), payload.clone()], at);
        if let Some(code) = code {
            refusal(&out, code);
        } else {
            assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
        }
    }
    let mut disallowed = request.claims.clone();
    disallowed.author = author_for_seed(&"06".repeat(32)).unwrap();
    let disallowed = sign_claims(&disallowed, &"06".repeat(32)).unwrap();
    let out = rig.invoke(&disallowed, &[disallowed.clone(), payload], 15.0);
    refusal(&out, "unauthorized");
    // The entire immutable installed catalog must be currently valid, even an unselected kind.
    let mut rig = Rig::new(20);
    rig.declarations[1].claims.valid_until = Some(11.0);
    rig.declarations[1] = sign_claims(&rig.declarations[1].claims, &rig.seed).unwrap();
    let installed = rig.declarations.iter().map(|d| d.id.clone()).collect();
    reconfigure(&mut rig, |c| c.installed = installed);
    let payload = fact(42.0);
    let request = rig.request(std::slice::from_ref(&payload), None);
    let out = rig.invoke(&request, &[request.clone(), payload.clone()], 10.0);
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    let out = rig.invoke(&request, &[request.clone(), payload], 11.0);
    refusal(&out, "configuration-mismatch");
    evidence("request_validity");
    evidence("caller_authorization");
}
#[test]
fn delivery_permutation_has_identical_signed_outcomes() {
    let payload = [fact(42.0), fact(43.0)];
    let mut a = Rig::new(20);
    let mut b = Rig::new(20);
    let request = a.request(&payload, None);
    let x = a.invoke(
        &request,
        &[request.clone(), payload[0].clone(), payload[1].clone()],
        10.0,
    );
    let y = b.invoke(
        &request,
        &[payload[1].clone(), request.clone(), payload[0].clone()],
        10.0,
    );
    assert_eq!(x, y);
    evidence("delivery_permutation");
}
#[test]
fn store_conflict_uncertainty_and_unknown_errors_reopen() {
    for mode in [
        "conflict",
        "uncertain-persist",
        "uncertain-absent",
        "error-persist",
        "error-absent",
    ] {
        let mut rig = Rig::new(20);
        let payload = fact(42.0);
        rig.store.fault = Some(mode);
        let (_, out) = rig.offer(std::slice::from_ref(&payload), None, 10.0);
        if mode == "conflict" {
            refusal(&out, "write-conflict");
            assert!(rig.store.rows.is_empty());
        } else {
            assert_eq!(read_outcome(&out).unwrap().body, OutcomeBody::Indeterminate);
        }
        let persisted = mode.ends_with("persist");
        assert_eq!(rig.store.rows.contains_key(&payload.id), persisted);
        rig.endpoint =
            CommandEndpoint::boot(&rig.peer, &rig.config, &rig.declarations, &mut rig.store)
                .unwrap();
        let (_, out) = rig.offer(std::slice::from_ref(&payload), None, 11.0);
        assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
        assert_eq!(rig.store.frames.len(), 1);
    }
    evidence("write_conflict");
    evidence("commit_unconfirmed");
}
#[test]
fn signing_failure_after_commit_has_no_false_refusal() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let request = rig.request(std::slice::from_ref(&payload), None);
    assert!(rig
        .endpoint
        .invoke(
            &mut rig.store,
            &request.id,
            &[request.clone(), payload.clone()],
            10.0,
            &|_| Err("injected signer failure".into())
        )
        .is_err());
    assert!(rig.store.rows.contains_key(&payload.id));
    let (_, out) = rig.offer(std::slice::from_ref(&payload), None, 11.0);
    let OutcomeBody::Retain {
        admitted,
        duplicate,
        ..
    } = read_outcome(&out).unwrap().body
    else {
        panic!("retain")
    };
    assert!(admitted.is_empty());
    assert_eq!(duplicate, vec![payload.id]);
    assert_eq!(rig.store.frames.len(), 1);
    evidence("response_delivery_failure");
}
#[test]
fn captured_source_never_initializes_and_refuses_damage_or_change() {
    let rig = Rig::new(20);
    let mut missing = Journal::default();
    assert!(matches!(
        capture_existing_ordinary_source(&mut missing, &rig.peer),
        OrdinarySourceCapture::SourceUnavailable { .. }
    ));
    assert_eq!(missing.writes, 0);
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    rig.offer(std::slice::from_ref(&payload), None, 10.0);
    rig.store.rows.remove(&payload.id);
    assert!(matches!(
        capture_existing_ordinary_source(&mut rig.store, &rig.peer),
        OrdinarySourceCapture::SourceUnavailable { .. }
    ));
    rig.store.rows.insert(payload.id.clone(), payload);
    rig.store.changed = true;
    assert_eq!(
        capture_existing_ordinary_source(&mut rig.store, &rig.peer),
        OrdinarySourceCapture::SourceChanged
    );
}
#[test]
fn inert_request_erasure_and_catalog_descriptions_never_dispatch() {
    let mut rig = Rig::new(20);
    let fact = fact(42.0);
    let nested = rig.request(std::slice::from_ref(&fact), None);
    let erasure = signed(
        &"05".repeat(32),
        vec![Pointer {
            role: "erases".into(),
            target: Target::Delta(DeltaRef {
                delta: fact.id.clone(),
                context: None,
            }),
        }],
        1.0,
    );
    let lookalike = signed(&rig.seed, operation_pointers(OperationKind::Retain), 1.0);
    let before_catalog = rig.endpoint.catalog().digest();
    let payload = [nested.clone(), erasure, lookalike];
    let (_, out) = rig.offer(&payload, None, 10.0);
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    assert_eq!(rig.store.rows.len(), 3);
    assert!(!rig.store.rows.contains_key(&fact.id));
    assert_eq!(rig.endpoint.catalog().digest(), before_catalog);
    let missing = format!("1e20{}", "99".repeat(32));
    let out = rig
        .endpoint
        .invoke(&mut rig.store, &missing, &[], 10.0, &|c| {
            sign_claims(c, &rig.seed)
        })
        .unwrap()
        .outcome;
    refusal(&out, "entry-missing");
    assert!(matches!(
        rig.endpoint
            .invoke(&mut rig.store, "bad", &[], 10.0, &|c| sign_claims(
                c, &rig.seed
            )),
        Err(rhizomatic::command::CommandHostError::Transport(_))
    ));
    let OrdinarySourceCapture::Captured { peer, .. } =
        capture_existing_ordinary_source(&mut rig.store, &rig.peer)
    else {
        panic!("capture")
    };
    let state = peer.snapshot().unwrap();
    assert!(state.events.is_empty() && state.exclusions.is_empty() && state.obligations.is_empty());
    evidence("retained_request_inert");
    evidence("configuration_not_self_installing");
    evidence("addressed_entry");
}
#[test]
fn permanent_refusal_cannot_reenter_through_retain() {
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    rig.offer(std::slice::from_ref(&payload), None, 10.0);
    let order = signed(
        &rig.seed,
        vec![Pointer {
            role: "erases".into(),
            target: Target::Delta(DeltaRef {
                delta: payload.id.clone(),
                context: None,
            }),
        }],
        1.0,
    );
    let OrdinaryJournalOpenResult::Open(mut peer) =
        open_ordinary_journal_peer(&mut rig.store, &rig.peer).unwrap()
    else {
        panic!("open")
    };
    let result = peer
        .admit_erasures(
            &mut rig.store,
            &EffectiveErasureTransferInput {
                orders: &[EffectiveErasureOrder {
                    delta: order,
                    target_id: payload.id.clone(),
                    surface_holds_bytes: true,
                }],
                ordinary: &[],
                capacity: None,
                origin: &ArrivalOrigin::Local,
                arrived_at: 11.0,
                policy_state: &(),
                guards: &[],
                mode: TransferMode::Atomic,
                target_budget: 1,
                advance_refusal_cap: 0,
                authorize: &|_, _: &BTreeSet<String>| true,
            },
        )
        .unwrap();
    assert!(matches!(
        result,
        OrdinaryJournalAdmissionResult::Committed { .. }
    ));
    let (_, out) = rig.offer(std::slice::from_ref(&payload), None, 12.0);
    refusal(&out, "admission-rejected");
    let OrdinarySourceCapture::Captured { deltas, .. } =
        capture_existing_ordinary_source(&mut rig.store, &rig.peer)
    else {
        panic!("capture")
    };
    assert!(!deltas.contains(&payload.id));
    evidence("retain_refused_id");
}

fn reconfigure(rig: &mut Rig, change: impl FnOnce(&mut Configuration)) {
    let mut config = read_configuration(&rig.config).unwrap();
    change(&mut config);
    rig.config = signed(&rig.seed, configuration_pointers(&config).unwrap(), 0.0);
    rig.endpoint =
        CommandEndpoint::boot(&rig.peer, &rig.config, &rig.declarations, &mut rig.store).unwrap();
}
#[test]
fn limits_count_every_appearance_and_canonical_bytes_before_authentication() {
    let mut rig = Rig::new(20);
    reconfigure(&mut rig, |c| c.max_deltas = 2);
    let payload = fact(42.0);
    let request = rig.request(std::slice::from_ref(&payload), None);
    let mut invalid = payload.clone();
    invalid.sig = Some("00".repeat(64));
    let out = rig.invoke(&request, &[request.clone(), payload.clone(), invalid], 10.0);
    refusal(&out, "resource-limit");
    assert!(rig.store.frames.is_empty());
    let size = rhizomatic::delta::canonical_bytes(&request.claims)
        .unwrap()
        .len()
        + rhizomatic::delta::canonical_bytes(&payload.claims)
            .unwrap()
            .len()
        + 128;
    reconfigure(&mut rig, |c| {
        c.max_deltas = 100;
        c.max_bytes = size as u64;
    });
    let request = rig.request(std::slice::from_ref(&payload), None);
    let out = rig.invoke(&request, &[request.clone(), payload.clone()], 10.0);
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    reconfigure(&mut rig, |c| c.max_bytes = size as u64 - 1);
    let request = rig.request(std::slice::from_ref(&payload), None);
    let out = rig.invoke(&request, &[request.clone(), payload], 10.0);
    refusal(&out, "resource-limit");
    evidence("limits");
}
#[test]
fn signed_manifest_does_not_authorize_unsigned_member_and_quota_counts_negation_closure() {
    let mut rig = Rig::new(1);
    let payload = fact(42.0);
    let manifest = signed(
        &rig.seed,
        vec![Pointer {
            role: "rhizomatic.txn.member".into(),
            target: Target::Delta(DeltaRef {
                delta: payload.id.clone(),
                context: None,
            }),
        }],
        1.0,
    );
    let request = rig.request(&[payload.clone(), manifest.clone()], None);
    let mut unsigned = payload.clone();
    unsigned.sig = None;
    let out = rig.invoke(&request, &[request.clone(), manifest, unsigned], 10.0);
    refusal(&out, "invalid-appearance");
    assert!(rig.store.frames.is_empty());
    let negation = signed(
        &rig.seed,
        vec![Pointer {
            role: "negates".into(),
            target: Target::Delta(DeltaRef {
                delta: payload.id.clone(),
                context: None,
            }),
        }],
        2.0,
    );
    let (_, out) = rig.offer(&[payload, negation], None, 10.0);
    refusal(&out, "admission-rejected");
    assert!(rig.store.frames.is_empty());
}
#[test]
fn json_input_is_owned_and_malformed_debug_appearance_is_a_signed_refusal() {
    use rhizomatic::json_profile::claims_to_json;
    use serde_json::json;
    let mut rig = Rig::new(20);
    let payload = fact(42.0);
    let request = rig.request(std::slice::from_ref(&payload), None);
    let mut original =
        json!({"id":payload.id,"claims":claims_to_json(&payload.claims),"sig":payload.sig});
    let submitted = vec![
        json!({"id":request.id,"claims":claims_to_json(&request.claims),"sig":request.sig}),
        original.clone(),
    ];
    original["claims"]["pointers"][1]["target"] = json!("caller mutation");
    let out = rig
        .endpoint
        .invoke_json(&mut rig.store, &request.id, &submitted, 10.0, &|c| {
            sign_claims(c, &rig.seed)
        })
        .unwrap()
        .outcome;
    assert_eq!(read_outcome(&out).unwrap().body.status(), "completed");
    assert_eq!(rig.store.rows.get(&payload.id), Some(&payload));
    let out = rig
        .endpoint
        .invoke_json(
            &mut rig.store,
            &request.id,
            &[json!({"id":request.id,"claims":{}})],
            10.0,
            &|c| sign_claims(c, &rig.seed),
        )
        .unwrap()
        .outcome;
    refusal(&out, "invalid-appearance");
    // Rust's borrow rules exclude concurrent mutation through the supplied immutable slice.
    evidence("input_mutation");
}

#[path = "support/command_query.rs"]
mod query;
