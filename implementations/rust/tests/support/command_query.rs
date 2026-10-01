use super::*;
use rhizomatic::eval::{GroupKey, SchemaRef, Term};
use rhizomatic::pred::{Bindings, Cmp, EntityMatch, PPred, Param, Pred, ValMatch};
use rhizomatic::resolution::{Order, Policy, Schema, View};
use rhizomatic::schema::HyperSchema;
use rhizomatic::schema_deltas::{publish_hyper_schema_claims, publish_schema_claims};
use rhizomatic::term_io::{schema_hash, term_hash};

#[derive(Clone)]
struct Program {
    gather: Delta,
    reading: Delta,
    gather_pin: String,
    reading_pin: String,
    extra: Vec<Delta>,
}
fn gather(body: Term, name: &str) -> Delta {
    let seed = "05".repeat(32);
    sign_claims(
        &publish_hyper_schema_claims(
            &HyperSchema {
                name: name.into(),
                alg: 1,
                body,
            },
            name,
            &author_for_seed(&seed).unwrap(),
            0.0,
        )
        .unwrap(),
        &seed,
    )
    .unwrap()
}
fn reading(schema: Schema) -> Delta {
    let seed = "05".repeat(32);
    sign_claims(
        &publish_schema_claims(
            &schema,
            schema.name.as_deref().unwrap(),
            &author_for_seed(&seed).unwrap(),
            0.0,
        )
        .unwrap(),
        &seed,
    )
    .unwrap()
}
fn gather_body() -> Term {
    rhizomatic::schema_deltas::hyper_schema_schema().body
}
fn reading_body() -> Schema {
    Schema {
        name: Some("query.reading".into()),
        alg: Some(1.0),
        props: BTreeMap::new(),
        default: Policy::Pick(Order::ByTimestamp { desc: true }),
    }
}
fn program(body: Term) -> Program {
    let s = reading_body();
    Program {
        gather_pin: term_hash(&body).unwrap(),
        reading_pin: schema_hash(&s).unwrap(),
        gather: gather(body, "query.gather"),
        reading: reading(s),
        extra: vec![],
    }
}
fn arguments(p: &Program) -> EvaluateArguments {
    EvaluateArguments {
        source: "admitted".into(),
        expected_digest: None,
        root: "tree".into(),
        at: 10.0,
        interpretation: "core/1".into(),
        hyperschema: p.gather.id.clone(),
        hyperschema_pin: p.gather_pin.clone(),
        schema: p.reading.id.clone(),
        schema_pin: p.reading_pin.clone(),
        definitions: p.extra.iter().map(|d| d.id.clone()).collect(),
        bindings: Bindings::new(),
    }
}
fn request(r: &Rig, a: EvaluateArguments, head: Option<String>) -> Delta {
    signed(
        &r.caller_seed,
        request_pointers(&Request {
            common: CommonRequest {
                receiver: r.peer.clone(),
                configuration: r.config.id.clone(),
                operation: r.declarations[1].id.clone(),
                expected_head: head,
            },
            arguments: RequestArguments::Evaluate(Box::new(a)),
        })
        .unwrap(),
        1.0,
    )
}
fn query(
    r: &mut Rig,
    p: &Program,
    a: EvaluateArguments,
    head: Option<String>,
    received: f64,
) -> (Delta, Delta) {
    let req = request(r, a, head);
    let rows = std::iter::once(req.clone())
        .chain([p.gather.clone(), p.reading.clone()])
        .chain(p.extra.iter().cloned())
        .collect::<Vec<_>>();
    let out = r.invoke(&req, &rows, received);
    (req, out)
}
fn value(out: &Delta) -> View {
    let OutcomeBody::Evaluate { value, .. } = read_outcome(out).unwrap().body else {
        panic!("evaluate result: {:?}", read_outcome(out))
    };
    rhizomatic::decode_view(&value).unwrap()
}
fn height(n: f64) -> View {
    View::Obj(BTreeMap::from([(
        "height".into(),
        View::Prim(Primitive::Num(n)),
    )]))
}

#[test]
fn ephemeral_query_has_verified_provenance_and_no_durable_or_registration_effect() {
    let mut r = Rig::new(20);
    let data = fact(42.0);
    r.offer(std::slice::from_ref(&data), None, 9.0);
    let before = r.store.clone();
    let p = program(gather_body());
    let (req, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    assert_eq!(r.store.head, before.head);
    assert_eq!(r.store.frames, before.frames);
    assert_eq!(r.store.rows, before.rows);
    assert!(!r.store.rows.contains_key(&req.id));
    assert!(!r.store.rows.contains_key(&out.id));
    assert!(!r.store.rows.contains_key(&p.gather.id));
    let result = rhizomatic::command::read_result(
        &out,
        &ReadResultContext {
            receiver: r.peer.clone(),
            configuration: r.config.id.clone(),
            request: req.id.clone(),
        },
        Some(&req),
    )
    .unwrap();
    assert_eq!(result.value, Some(height(42.0)));
    assert_eq!(out.claims.author, r.peer);
    assert_eq!(out.claims.timestamp, 10.0);
    assert_eq!(out.claims.valid_from, 10.0);
    assert_eq!(out.claims.valid_until, None);
    let mut malformed = result.outcome;
    let OutcomeBody::Evaluate { value, .. } = &mut malformed.body else {
        unreachable!()
    };
    *value = vec![0xf6];
    let mut claims = out.claims.clone();
    claims.pointers = outcome_pointers(&malformed).unwrap();
    let malformed = sign_claims(&claims, &r.seed).unwrap();
    assert!(rhizomatic::command::read_result(
        &malformed,
        &ReadResultContext {
            receiver: r.peer,
            configuration: r.config.id,
            request: req.id.clone()
        },
        Some(&req)
    )
    .is_err());
    evidence("query_ephemeral");
    evidence("outcome_provenance");
}
#[test]
fn current_source_digest_head_repetition_and_explicit_time() {
    let mut r = Rig::new(20);
    let mut old = fact(42.0);
    old.claims.valid_until = Some(15.0);
    old = sign_claims(&old.claims, &"05".repeat(32)).unwrap();
    r.offer(&[old], None, 9.0);
    let p = program(gather_body());
    let a = arguments(&p);
    let (_, out) = query(&mut r, &p, a.clone(), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let OutcomeBody::Evaluate { digest, head, .. } = read_outcome(&out).unwrap().body else {
        unreachable!()
    };
    let mut correct = a.clone();
    correct.expected_digest = Some(digest.clone());
    let (_, out) = query(&mut r, &p, correct, head.clone(), 11.0);
    assert_eq!(value(&out), height(42.0));
    let mut wrong = a.clone();
    wrong.expected_digest = Some(format!("1e20{}", "aa".repeat(32)));
    let (_, out) = query(&mut r, &p, wrong, None, 11.0);
    refusal(&out, "precondition-failed");
    let mut newer = fact(87.0);
    newer.claims.timestamp = 12.0;
    newer.claims.valid_from = 12.0;
    newer = sign_claims(&newer.claims, &"05".repeat(32)).unwrap();
    r.offer(&[newer], None, 12.0);
    let (_, out) = query(&mut r, &p, a.clone(), head, 13.0);
    refusal(&out, "precondition-failed");
    let mut later = a.clone();
    later.at = 12.0;
    let (repeat, out) = query(&mut r, &p, later, None, 13.0);
    assert_eq!(value(&out), height(87.0));
    let mut repeating = Rig::new(20);
    repeating.offer(&[fact(42.0)], None, 9.0);
    let (first_request, first) = query(&mut repeating, &p, arguments(&p), None, 10.0);
    let mut changed = fact(87.0);
    changed.claims.timestamp = 2.0;
    changed = sign_claims(&changed.claims, &"05".repeat(32)).unwrap();
    repeating.offer(&[changed], None, 11.0);
    let (same_request, second) = query(&mut repeating, &p, arguments(&p), None, 12.0);
    assert_eq!(first_request, same_request);
    assert_eq!(value(&first), height(42.0));
    assert_eq!(value(&second), height(87.0));
    let OutcomeBody::Evaluate { digest: next, .. } = read_outcome(&out).unwrap().body else {
        unreachable!()
    };
    assert_ne!(next, digest);
    let (_, out) = query(&mut r, &p, a, None, 14.0);
    assert_eq!(value(&out), height(42.0));
    assert_ne!(repeat.id, out.id);
    let mut at = arguments(&p);
    at.at = 15.0;
    let (_, out) = query(&mut r, &p, at, None, 16.0);
    assert_eq!(value(&out), height(87.0));
    evidence("coherent_external_change");
    evidence("write_then_query");
    evidence("source_digest_precondition");
    evidence("query_repeat_current");
    evidence("explicit_time");
}
#[test]
fn degraded_or_changed_source_refuses_before_invalid_program() {
    let mut r = Rig::new(20);
    let data = fact(42.0);
    r.offer(std::slice::from_ref(&data), None, 9.0);
    let p = program(gather_body());
    r.store.rows.get_mut(&data.id).unwrap().sig = Some("00".repeat(64));
    let mut args = arguments(&p);
    args.expected_digest = Some(
        rhizomatic::set::DeltaSet::from_deltas([data.clone()])
            .unwrap()
            .digest(),
    );
    let (_, out) = query(&mut r, &p, args, None, 10.0);
    refusal(&out, "source-unavailable");
    r.store.rows.remove(&data.id);
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    refusal(&out, "source-unavailable");
    r.store.rows.insert(data.id.clone(), data);
    r.store.changed = true;
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    refusal(&out, "source-changed");
    r.store.changed = false;
    let mut invalid = arguments(&p);
    invalid.hyperschema_pin = format!("1e20{}", "aa".repeat(32));
    let (_, out) = query(&mut r, &p, invalid, Some(String::new()), 10.0);
    refusal(&out, "precondition-failed");
    evidence("degraded_source");
    evidence("source_changes_during_capture");
    evidence("error_priority");
}
#[test]
fn exact_signed_definition_act_and_all_individual_shape_failures() {
    let mut r = Rig::new(20);
    r.offer(&[fact(42.0)], None, 9.0);
    let p = program(gather_body());
    let mut newer = gather(
        Term::Group {
            key: GroupKey::Const("other".into()),
            of: Box::new(Term::Input),
        },
        "query.gather",
    );
    newer.claims.timestamp = 9.0;
    newer.claims.valid_from = 9.0;
    newer = sign_claims(&newer.claims, &"05".repeat(32)).unwrap();
    r.offer(&[newer], None, 9.0);
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let mut badpin = arguments(&p);
    badpin.hyperschema_pin = format!("1e20{}", "bb".repeat(32));
    let (_, out) = query(&mut r, &p, badpin, None, 10.0);
    refusal(&out, "pin-mismatch");
    for case in [
        "future",
        "expired",
        "alg",
        "duplicate",
        "unknown",
        "uppercase",
        "extra",
    ] {
        let mut bad = p.clone();
        let mut claims = bad.gather.claims.clone();
        match case {
            "future" => claims.valid_from = 11.0,
            "expired" => claims.valid_until = Some(10.0),
            "alg" => claims.pointers[2].target = Target::Primitive(Primitive::Num(2.0)),
            "duplicate" => claims.pointers[1] = claims.pointers[0].clone(),
            "unknown" => claims.pointers[1].role = "unknown".into(),
            "extra" => claims.pointers.push(Pointer {
                role: "unknown".into(),
                target: Target::Primitive(Primitive::Bool(true)),
            }),
            "uppercase" => {
                let Target::Primitive(Primitive::Str(s)) = &mut claims.pointers[3].target else {
                    unreachable!()
                };
                *s = s.to_uppercase();
            }
            _ => unreachable!(),
        }
        bad.gather = sign_claims(&claims, &"05".repeat(32)).unwrap();
        let (_, out) = query(&mut r, &bad, arguments(&bad), None, 10.0);
        refusal(&out, "invalid-definition");
    }
    let mut wrong = arguments(&p);
    std::mem::swap(&mut wrong.hyperschema, &mut wrong.schema);
    let (_, out) = query(&mut r, &p, wrong.clone(), None, 10.0);
    refusal(&out, "invalid-definition");
    wrong.hyperschema_pin = format!("1e20{}", "00".repeat(32));
    let (_, out) = query(&mut r, &p, wrong, None, 10.0);
    refusal(&out, "invalid-definition");
    let mut extra = p.clone();
    extra.extra.push(gather(gather_body(), "unreachable"));
    let mut wrong = arguments(&extra);
    std::mem::swap(&mut wrong.hyperschema, &mut wrong.schema);
    let (_, out) = query(&mut r, &extra, wrong, None, 10.0);
    refusal(&out, "invalid-definition");
    evidence("exact_definition_act");
    evidence("definition_pin_mismatch");
    evidence("definition_validity_and_version");
}
#[test]
fn exact_name_closure_missing_extra_duplicate_and_cycles() {
    let mut r = Rig::new(20);
    r.offer(&[fact(42.0)], None, 9.0);
    let child = gather(gather_body(), "child");
    let mut p = program(Term::Fix {
        schema: SchemaRef::Name("child".into()),
        entity: "tree".into(),
        bindings: None,
    });
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    refusal(&out, "definition-closure");
    p.extra.push(child.clone());
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let mut extra = p.clone();
    extra.extra.push(gather(gather_body(), "unreachable"));
    let (_, out) = query(&mut r, &extra, arguments(&extra), None, 10.0);
    refusal(&out, "definition-closure");
    let mut duplicate = p.clone();
    let mut claims = child.claims.clone();
    claims.timestamp = 1.0;
    duplicate
        .extra
        .push(sign_claims(&claims, &"05".repeat(32)).unwrap());
    let (_, out) = query(&mut r, &duplicate, arguments(&duplicate), None, 10.0);
    refusal(&out, "ambiguous-definition");
    let cycle = program(Term::Fix {
        schema: SchemaRef::Name("query.gather".into()),
        entity: "tree".into(),
        bindings: None,
    });
    let (_, out) = query(&mut r, &cycle, arguments(&cycle), None, 10.0);
    refusal(&out, "definition-cycle");
    evidence("definition_closure");
    evidence("definition_name_conflict");
    evidence("definition_cycle");
}
#[test]
fn variables_obey_request_and_fix_environments_and_root_is_reserved() {
    let body = Term::Group {
        key: GroupKey::ByTargetContext,
        of: Box::new(Term::Select {
            pred: Pred::HasPointer(PPred {
                target_entity: Some(EntityMatch::Root),
                target_value: Some(ValMatch::Vcmp {
                    cmp: Cmp::Eq,
                    value: Param::Hole("height".into()),
                }),
                ..Default::default()
            }),
            of: Box::new(Term::Input),
        }),
    };
    // The root filing pointer and primitive value are distinct; use value-only predicate instead.
    let body = if let Term::Group { key, of } = body {
        let Term::Select { mut pred, of } = *of else {
            unreachable!()
        };
        let Pred::HasPointer(p) = &mut pred else {
            unreachable!()
        };
        p.target_entity = None;
        Term::Group {
            key,
            of: Box::new(Term::Select { pred, of }),
        }
    } else {
        unreachable!()
    };
    let mut r = Rig::new(20);
    r.offer(&[fact(42.0)], None, 9.0);
    let p = program(body);
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    refusal(&out, "invalid-program");
    let mut a = arguments(&p);
    a.bindings.insert("height".into(), Primitive::Num(42.0));
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let mut req = request(&r, arguments(&p), None);
    req.claims
        .pointers
        .iter_mut()
        .find(|p| p.role == "rhizomatic.command.bindings")
        .unwrap()
        .target = Target::Bytes {
        mime: "application/cbor".into(),
        value: rhizomatic::cbor::encode(&rhizomatic::cbor::CborValue::Map(vec![(
            "root".into(),
            rhizomatic::cbor::CborValue::Tstr("other".into()),
        )])),
    };
    req = sign_claims(&req.claims, &r.caller_seed).unwrap();
    let out = r.invoke(&req, &[req.clone(), p.gather, p.reading], 10.0);
    refusal(&out, "invalid-arguments");
    evidence("variables");
}

struct ObservedStore {
    inner: std::cell::RefCell<Journal>,
    reads: std::cell::Cell<usize>,
    after_head: std::cell::RefCell<Option<Journal>>,
    unavailable: bool,
}
impl ObservedStore {
    fn new(journal: Journal) -> Self {
        Self {
            inner: std::cell::RefCell::new(journal),
            reads: std::cell::Cell::new(0),
            after_head: std::cell::RefCell::new(None),
            unavailable: false,
        }
    }
    fn observe(&self) -> Result<(), String> {
        self.reads.set(self.reads.get() + 1);
        if self.unavailable {
            Err("injected unavailable store".into())
        } else {
            Ok(())
        }
    }
}
impl DurableOrdinaryJournalStore for ObservedStore {
    fn read_journal(&self, p: &str) -> Result<OrdinaryJournalRead, String> {
        self.observe()?;
        self.inner.borrow().read_journal(p)
    }
    fn read_admitted_rows(&self, p: &str, ids: &[String]) -> Result<Vec<Delta>, String> {
        self.observe()?;
        self.inner.borrow().read_admitted_rows(p, ids)
    }
    fn read_head(&self, p: &str) -> Result<OrdinaryJournalHead, String> {
        self.observe()?;
        let h = self.inner.borrow().read_head(p)?;
        if let Some(next) = self.after_head.borrow_mut().take() {
            *self.inner.borrow_mut() = next;
        }
        Ok(h)
    }
    fn compare_and_append(
        &mut self,
        p: &str,
        e: Option<&str>,
        n: &str,
        f: Option<&[u8]>,
        ds: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        self.inner.get_mut().compare_and_append(p, e, n, f, ds)
    }
}
fn observed_query(r: &Rig, s: &mut ObservedStore, p: &Program, a: EvaluateArguments) -> Delta {
    let req = request(r, a, None);
    let rows = std::iter::once(req.clone())
        .chain([p.gather.clone(), p.reading.clone()])
        .chain(p.extra.iter().cloned())
        .collect::<Vec<_>>();
    r.endpoint
        .invoke(s, &req.id, &rows, 10.0, &|c| sign_claims(c, &r.seed))
        .unwrap()
        .outcome
}
#[test]
fn capture_is_immutable_after_bracket_and_interpretation_never_reads_store() {
    let mut r = Rig::new(20);
    r.offer(&[fact(42.0)], None, 9.0);
    let old_head = r.store.head.clone();
    let mut external = Rig::new(20);
    external.store = r.store.clone();
    external.offer(&[fact(87.0)], None, 10.0);
    let mut s = ObservedStore::new(r.store.clone());
    *s.after_head.borrow_mut() = Some(external.store);
    let p = program(gather_body());
    let out = observed_query(&r, &mut s, &p, arguments(&p));
    assert_eq!(value(&out), height(42.0));
    let OutcomeBody::Evaluate { head, .. } = read_outcome(&out).unwrap().body else {
        unreachable!()
    };
    assert_eq!(head, old_head);
    assert_ne!(head, s.inner.borrow().head);
    assert_eq!(s.reads.get(), 3);
    assert_eq!(s.inner.borrow().rows.len(), 2);
    evidence("query_snapshot_after_capture");
    evidence("no_hidden_observations");
}
#[test]
fn catalog_queries_are_ordinary_and_need_no_journal_read() {
    let r = Rig::new(20);
    let mut s = ObservedStore::new(r.store.clone());
    s.unavailable = true;
    let mut p = program(Term::Group {
        key: GroupKey::Const("catalog".into()),
        of: Box::new(Term::Input),
    });
    let mut resolution = reading_body();
    resolution.default = Policy::All(Order::LexById, false);
    p.reading_pin = schema_hash(&resolution).unwrap();
    p.reading = reading(resolution);
    let mut a = arguments(&p);
    a.source = "catalog".into();
    let out = observed_query(&r, &mut s, &p, a.clone());
    let View::Obj(fields) = value(&out) else {
        panic!("obj")
    };
    let View::Arr(contracts) = &fields["catalog"] else {
        panic!("catalog array")
    };
    assert_eq!(contracts.len(), 3);
    assert_eq!(s.reads.get(), 0);
    assert_eq!(r.endpoint.catalog().len(), 3);
    let out = observed_query(&r, &mut s, &p, arguments(&p));
    refusal(&out, "source-unavailable");
    let mut req = request(&r, a, None);
    req.claims.pointers.push(Pointer {
        role: "rhizomatic.command.expected-head".into(),
        target: Target::Primitive(Primitive::Str(String::new())),
    });
    req = sign_claims(&req.claims, &r.caller_seed).unwrap();
    let out = r
        .endpoint
        .invoke(
            &mut s,
            &req.id,
            &[req.clone(), p.gather, p.reading],
            10.0,
            &|c| sign_claims(c, &r.seed),
        )
        .unwrap()
        .outcome;
    refusal(&out, "invalid-arguments");
    evidence("catalog_discovery");
    evidence("catalog_with_unavailable_store");
}

#[test]
fn principal_profiles_use_captured_evidence_and_original_program_pins() {
    use rhizomatic::pred::{Field, MatchConst, PrincipalPolicy, PrincipalPolicyKind};
    let vector: serde_json::Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/../../vectors/principal/evidence.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let named: BTreeMap<&str, Delta> = vector["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["name"].as_str().unwrap(),
                Delta {
                    id: v["id"].as_str().unwrap().into(),
                    claims: rhizomatic::json_profile::parse_claims(&v["claims"]).unwrap(),
                    sig: v["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect();
    let root = vector["keys"]["userRoot"].as_str().unwrap();
    let principal = Pred::ActsFor {
        root: root.into(),
        policy: PrincipalPolicy {
            kind: PrincipalPolicyKind::Prefix,
            scope: "ada:journal".into(),
        },
    };
    let ordinary = Pred::Match {
        field: Field::Id,
        cmp: Cmp::Eq,
        constant: MatchConst::One(Primitive::Str(named["dataConnection"].id.clone())),
    };
    let body = Term::Group {
        key: GroupKey::Const("facts".into()),
        of: Box::new(Term::Select {
            pred: Pred::And(Box::new(principal.clone()), Box::new(ordinary)),
            of: Box::new(Term::Input),
        }),
    };
    let mut r = Rig::new(20);
    r.offer(
        &[
            named["userDelegation"].clone(),
            named["connectionDelegation"].clone(),
            named["negateConnectionByRoot"].clone(),
            named["dataConnection"].clone(),
            named["dataUser"].clone(),
        ],
        None,
        9.0,
    );
    let p = program(body);
    let mut a = arguments(&p);
    a.at = 12.0;
    a.root = root.into();
    let (_, out) = query(&mut r, &p, a.clone(), None, 10.0);
    refusal(&out, "invalid-program");
    a.interpretation = "principal-sameAuthor/1".into();
    let (_, same) = query(&mut r, &p, a.clone(), None, 10.0);
    let expected = View::Obj(BTreeMap::from([(
        "facts".into(),
        View::Obj(BTreeMap::from([
            ("kind".into(), View::Prim(Primitive::Str("data".into()))),
            (
                "value".into(),
                View::Prim(Primitive::Str("connection".into())),
            ),
        ])),
    )]));
    assert_eq!(value(&same), expected);
    a.interpretation = "principal-rootOrSameAuthor/1".into();
    let (_, rooted) = query(&mut r, &p, a.clone(), None, 10.0);
    assert_eq!(value(&rooted), View::Obj(BTreeMap::new()));
    let OutcomeBody::Evaluate {
        hyperschema_pin,
        schema_pin,
        at,
        interpretation,
        ..
    } = read_outcome(&rooted).unwrap().body
    else {
        unreachable!()
    };
    assert_eq!(hyperschema_pin, p.gather_pin);
    assert_eq!(schema_pin, p.reading_pin);
    assert_eq!(at, 12.0);
    assert_eq!(interpretation, "principal-rootOrSameAuthor/1");
    // An ambient reactor with unrelated granting evidence cannot influence the command source.
    let mut ambient = rhizomatic::reactor::Reactor::new();
    ambient.ingest(named["directConnection"].clone());
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    assert_eq!(value(&out), View::Obj(BTreeMap::new()));
    // ActsFor in the top reading is equally subject to profile selection and pin preservation.
    let mut p = program(Term::Group {
        key: GroupKey::Const("facts".into()),
        of: Box::new(Term::Select {
            pred: Pred::Match {
                field: Field::Id,
                cmp: Cmp::InSet,
                constant: MatchConst::Many(vec![
                    Primitive::Str(named["dataConnection"].id.clone()),
                    Primitive::Str(named["dataUser"].id.clone()),
                ]),
            },
            of: Box::new(Term::Input),
        }),
    });
    let mut s = reading_body();
    s.default = Policy::All(
        Order::ByPred {
            pred: principal,
            then: Box::new(Order::LexById),
        },
        false,
    );
    p.reading_pin = schema_hash(&s).unwrap();
    p.reading = reading(s);
    let mut a = arguments(&p);
    a.root = root.into();
    a.at = 12.0;
    let (_, out) = query(&mut r, &p, a.clone(), None, 10.0);
    refusal(&out, "invalid-program");
    a.interpretation = "principal-rootOrSameAuthor/1".into();
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    let View::Obj(o) = value(&out) else {
        unreachable!()
    };
    let View::Arr(values) = &o["facts"] else {
        unreachable!()
    };
    let View::Obj(first) = &values[0] else {
        unreachable!()
    };
    assert_eq!(first["value"], View::Prim(Primitive::Str("user".into())));
    evidence("core_principal_refusal");
    evidence("principal_profiles");
    evidence("principal_pins_and_source");
}

#[test]
fn nested_closure_in_predicates_readings_and_expansions_is_complete() {
    use rhizomatic::pred::{Field, InViewExtract, PrincipalPolicy, PrincipalPolicyKind, StrMatch};
    let mut r = Rig::new(20);
    r.offer(&[fact(42.0)], None, 9.0);
    let acts = Pred::ActsFor {
        root: r.peer.clone(),
        policy: PrincipalPolicy {
            kind: PrincipalPolicyKind::Exact,
            scope: "query".into(),
        },
    };
    let child_body = Term::Group {
        key: GroupKey::ByTargetContext,
        of: Box::new(Term::Select {
            pred: Pred::InView {
                term: Box::new(Term::Select {
                    pred: acts.clone(),
                    of: Box::new(Term::Input),
                }),
                field: Field::Author,
                extract: InViewExtract::Author,
            },
            of: Box::new(Term::Input),
        }),
    };
    let child = gather(child_body, "child");
    let base = gather(gather_body(), "base");
    let mut child_reading = reading_body();
    child_reading.name = Some("child.reading".into());
    child_reading.default = Policy::Pick(Order::ByPred {
        pred: acts.clone(),
        then: Box::new(Order::LexById),
    });
    let child_pin = schema_hash(&child_reading).unwrap();
    let child_reading_delta = reading(child_reading.clone());
    let mut p = program(Term::Expand {
        role: StrMatch::Exact("never-expand".into()),
        schema: SchemaRef::Name("child".into()),
        reading: Some(SchemaRef::Pinned(child_pin)),
        of: Box::new(Term::Fix {
            schema: SchemaRef::Pinned(term_hash(&gather_body()).unwrap()),
            entity: "tree".into(),
            bindings: None,
        }),
    });
    p.extra = vec![base, child, child_reading_delta];
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    refusal(&out, "invalid-program");
    let mut a = arguments(&p);
    a.interpretation = "principal-sameAuthor/1".into();
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let mut missing = p.clone();
    missing.extra.pop();
    let mut a = arguments(&missing);
    a.interpretation = "principal-sameAuthor/1".into();
    let (_, out) = query(&mut r, &missing, a, None, 10.0);
    refusal(&out, "definition-closure");
    // Anonymous embedded Schemas are visited even though a View-sort term cannot serve as
    // a top gather. Principal lowering keeps the original typed resolution semantics.
    let embedded = Term::Resolve {
        schema: child_reading,
        of: Box::new(gather_body()),
    };
    assert!(
        rhizomatic::schema::inspect_program_term(&embedded, &Bindings::new())
            .0
            .acts_for
    );
    let source = rhizomatic::set::DeltaSet::from_deltas(r.store.rows.values().cloned()).unwrap();
    let resolver = rhizomatic::principal::principal_resolver(
        rhizomatic::principal::PrincipalSuppression::SameAuthor,
    );
    let lowered =
        rhizomatic::principal::lower_principal_term(&embedded, &source, 10.0, &resolver).unwrap();
    assert!(
        !rhizomatic::schema::inspect_program_term(&lowered, &Bindings::new())
            .0
            .acts_for
    );
    // Two different named publications of the same content are legal when both are reachable.
    let one = gather(gather_body(), "one");
    let two = gather(gather_body(), "two");
    let mut aliases = program(Term::Expand {
        role: StrMatch::Exact("none".into()),
        schema: SchemaRef::Name("one".into()),
        reading: Some(SchemaRef::Pinned(schema_hash(&reading_body()).unwrap())),
        of: Box::new(Term::Fix {
            schema: SchemaRef::Name("two".into()),
            entity: "tree".into(),
            bindings: None,
        }),
    });
    aliases.extra = vec![one, two];
    let (_, out) = query(&mut r, &aliases, arguments(&aliases), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    evidence("nested_reference_analysis");
}

#[test]
fn actual_two_level_named_and_pinned_expansion_uses_only_explicit_complete_closure() {
    use rhizomatic::pred::StrMatch;
    let mut r = Rig::new(20);
    let link = |root: &str, role: &str, child: &str| {
        signed(
            &"05".repeat(32),
            vec![
                Pointer {
                    role: "entity".into(),
                    target: Target::Entity(EntityRef {
                        id: root.into(),
                        context: Some("branch".into()),
                    }),
                },
                Pointer {
                    role: role.into(),
                    target: Target::Entity(EntityRef {
                        id: child.into(),
                        context: None,
                    }),
                },
            ],
            1.0,
        )
    };
    let parent = link("tree", "toChild", "child.root");
    let child = link("child.root", "toGrand", "grand.root");
    let mut grand = fact(42.0);
    let Target::Entity(filing) = &mut grand.claims.pointers[0].target else {
        unreachable!()
    };
    filing.id = "grand.root".into();
    grand = sign_claims(&grand.claims, &"05".repeat(32)).unwrap();
    r.offer(&[parent, child, grand], None, 9.0);
    let grand_definition = gather(gather_body(), "grand");
    let child_definition = gather(
        Term::Expand {
            role: StrMatch::Exact("toGrand".into()),
            schema: SchemaRef::Pinned(term_hash(&gather_body()).unwrap()),
            reading: Some(SchemaRef::Name("grand.reading".into())),
            of: Box::new(gather_body()),
        },
        "child",
    );
    let mut child_schema = reading_body();
    child_schema.name = Some("child.reading".into());
    let child_reading = reading(child_schema);
    let mut grand_schema = reading_body();
    grand_schema.name = Some("grand.reading".into());
    let grand_reading = reading(grand_schema);
    let mut p = program(Term::Expand {
        role: StrMatch::Exact("toChild".into()),
        schema: SchemaRef::Name("child".into()),
        reading: Some(SchemaRef::Name("child.reading".into())),
        of: Box::new(gather_body()),
    });
    p.extra = vec![
        child_definition,
        grand_definition,
        child_reading,
        grand_reading,
    ];
    let (_, out) = query(&mut r, &p, arguments(&p), None, 10.0);
    let nested = View::Obj(BTreeMap::from([(
        "branch".into(),
        View::Obj(BTreeMap::from([("branch".into(), height(42.0))])),
    )]));
    assert_eq!(value(&out), nested);
    let mut incomplete = p.clone();
    incomplete.extra.remove(1);
    let (_, out) = query(&mut r, &incomplete, arguments(&incomplete), None, 10.0);
    refusal(&out, "definition-closure");
    let mut unrelated = p.clone();
    unrelated.extra.push(gather(gather_body(), "unused"));
    let (_, out) = query(&mut r, &unrelated, arguments(&unrelated), None, 10.0);
    refusal(&out, "definition-closure");
    evidence("nested_reference_analysis");
    evidence("definition_closure");
}

#[test]
fn reading_variables_bind_top_embedded_referenced_and_fix_local_environments() {
    use rhizomatic::pred::{Field, MatchConst, StrMatch};
    let mut r = Rig::new(20);
    let older = fact(42.0);
    let preferred = older.claims.author.clone();
    let mut newer = fact(87.0);
    newer.claims.timestamp = 2.0;
    newer.claims.author = author_for_seed(&"06".repeat(32)).unwrap();
    newer = sign_claims(&newer.claims, &"06".repeat(32)).unwrap();
    let other = newer.claims.author.clone();
    r.offer(&[older.clone(), newer.clone()], None, 9.0);
    let mut s = reading_body();
    s.default = Policy::Pick(Order::ByPred {
        pred: Pred::Match {
            field: Field::Author,
            cmp: Cmp::Eq,
            constant: MatchConst::Hole("preferred".into()),
        },
        then: Box::new(Order::ByTimestamp { desc: true }),
    });
    let mut p = program(gather_body());
    p.reading_pin = schema_hash(&s).unwrap();
    p.reading = reading(s.clone());
    let original = p.reading.clone();
    let mut a = arguments(&p);
    a.bindings
        .insert("preferred".into(), Primitive::Str(preferred.clone()));
    let (_, out) = query(&mut r, &p, a.clone(), None, 10.0);
    assert_eq!(value(&out), height(42.0));
    let OutcomeBody::Evaluate { schema_pin, .. } = read_outcome(&out).unwrap().body else {
        unreachable!()
    };
    assert_eq!(schema_pin, p.reading_pin);
    assert_eq!(p.reading, original);
    let source = rhizomatic::set::DeltaSet::from_deltas([older, newer]).unwrap();
    let embedded = Term::Resolve {
        schema: s.clone(),
        of: Box::new(gather_body()),
    };
    assert_eq!(
        rhizomatic::eval::eval_bound_program_at(
            &embedded,
            &source,
            10.0,
            Some("tree"),
            None,
            &a.bindings
        )
        .unwrap(),
        rhizomatic::eval::EvalResult::View(height(42.0))
    );
    // Ordinary native calls retain their previous optional-binding reading behavior.
    assert_eq!(
        rhizomatic::eval::eval_term_at(
            &embedded,
            &source,
            10.0,
            Some("tree"),
            None,
            Some(&a.bindings)
        )
        .unwrap(),
        rhizomatic::eval::EvalResult::View(height(87.0))
    );
    let mut r = Rig::new(20);
    let link = signed(
        &"05".repeat(32),
        vec![
            Pointer {
                role: "entity".into(),
                target: Target::Entity(EntityRef {
                    id: "tree".into(),
                    context: Some("branch".into()),
                }),
            },
            Pointer {
                role: "toChild".into(),
                target: Target::Entity(EntityRef {
                    id: "child.root".into(),
                    context: None,
                }),
            },
        ],
        1.0,
    );
    let child_fact = |n: f64, seed: &str, timestamp: f64| {
        let mut d = fact(n);
        let Target::Entity(e) = &mut d.claims.pointers[0].target else {
            unreachable!()
        };
        e.id = "child.root".into();
        d.claims.timestamp = timestamp;
        d.claims.author = author_for_seed(seed).unwrap();
        sign_claims(&d.claims, seed).unwrap()
    };
    r.offer(
        &[
            link,
            child_fact(42.0, &"05".repeat(32), 1.0),
            child_fact(87.0, &"06".repeat(32), 2.0),
        ],
        None,
        9.0,
    );
    s.name = Some("child.reading".into());
    let child_reading = reading(s.clone());
    let child_pin = schema_hash(&s).unwrap();
    let child_gather = gather(gather_body(), "child");
    let expanded = Term::Expand {
        role: StrMatch::Exact("toChild".into()),
        schema: SchemaRef::Name("child".into()),
        reading: Some(SchemaRef::Pinned(child_pin.clone())),
        of: Box::new(gather_body()),
    };
    let mut p = program(expanded.clone());
    p.extra = vec![child_gather.clone(), child_reading.clone()];
    let mut a = arguments(&p);
    a.bindings
        .insert("preferred".into(), Primitive::Str(preferred.clone()));
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    let expected = View::Obj(BTreeMap::from([("branch".into(), height(42.0))]));
    assert_eq!(value(&out), expected);
    let expansion_definition = gather(expanded, "local.expansion");
    let mut p = program(Term::Fix {
        schema: SchemaRef::Name("local.expansion".into()),
        entity: "tree".into(),
        bindings: Some(Bindings::from([(
            "preferred".into(),
            Primitive::Str(preferred),
        )])),
    });
    p.extra = vec![expansion_definition, child_gather, child_reading];
    let mut a = arguments(&p);
    a.bindings.insert("preferred".into(), Primitive::Str(other));
    let (_, out) = query(&mut r, &p, a, None, 10.0);
    assert_eq!(value(&out), expected);
    assert_eq!(schema_hash(&s).unwrap(), child_pin);
    evidence("variables");
    evidence("nested_reference_analysis");
}
