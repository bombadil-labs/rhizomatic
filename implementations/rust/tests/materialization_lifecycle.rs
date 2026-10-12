//! SPEC-16 M3: the six maintained verbs over an in-memory control store, driven by the shared
//! `plant` batch fixture so every root result must equal the batch oracle byte for byte.
use rhizomatic::cbor::{decode, encode, CborValue};
use rhizomatic::delta::canonical_bytes;
use rhizomatic::hash::content_address;
use rhizomatic::json_profile::claims_to_json;
use rhizomatic::json_profile::parse_delta as parse_command_delta;
use rhizomatic::materialization_data::{
    materialization_bytes, materialization_description_claims, materialization_entity,
    materialization_number, materialization_ref, materialization_text,
    read_materialization_description, read_materialization_limits, MaterializationFields,
    MaterializationVerb,
};
use rhizomatic::materialization_peer::{
    decode_materialization_control, MaterializationControlImage, MaterializationControlInitialize,
    MaterializationControlRead, MaterializationControlStatus, MaterializationControlStore,
    MaterializationControlWrite,
};
use rhizomatic::materialization_source::{
    MaterializationCapture, MaterializationSourceCapability, MaterializationSourceFailure,
};
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::types::{Claims, Delta, DeltaRef, EntityRef, Primitive, Target};
use rhizomatic::{
    initialize_materialization_control, MaterializationEndpoint, MaterializationInputBoot,
    MaterializationSigner,
};
use serde_json::Value;
use sha2::Digest;
use std::collections::BTreeMap;

const CORPUS: &str = include_str!("../../../vectors/materialization/commands.json");
fn p(v: &str) -> Vec<Target> {
    vec![Target::Primitive(Primitive::Str(v.into()))]
}
fn n(v: f64) -> Vec<Target> {
    vec![Target::Primitive(Primitive::Num(v))]
}
fn ent(id: &str) -> Vec<Target> {
    vec![Target::Entity(EntityRef {
        id: id.into(),
        context: None,
    })]
}
fn r(id: &str) -> Target {
    Target::Delta(DeltaRef {
        delta: id.into(),
        context: None,
    })
}
fn blob(value: Vec<u8>) -> Vec<Target> {
    vec![Target::Bytes {
        mime: "application/cbor".into(),
        value,
    }]
}
struct Seeds {
    receiver: String,
    caller: String,
    definition: String,
}
fn sign(seed: &str, at: f64, kind: &str, fields: MaterializationFields) -> Delta {
    let claims =
        materialization_description_claims(&author_for_seed(seed).unwrap(), at, kind, &fields)
            .unwrap();
    sign_claims(&claims, seed).unwrap()
}
fn wire(d: &Delta) -> Value {
    serde_json::json!({"id": d.id, "claims": claims_to_json(&d.claims), "sig": d.sig})
}
fn field<'a>(v: &'a CborValue, k: &str) -> &'a CborValue {
    let CborValue::Map(fs) = v else { panic!("map") };
    &fs.iter().find(|(key, _)| key == k).unwrap().1
}
fn text(v: &CborValue) -> &str {
    let CborValue::Tstr(s) = v else {
        panic!("text")
    };
    s
}
fn num(v: &CborValue) -> f64 {
    let CborValue::Float(n) = v else {
        panic!("num")
    };
    *n
}
struct Signer(String, String);
impl MaterializationSigner for Signer {
    fn author(&self) -> &str {
        &self.0
    }
    fn sign(&self, claims: &Claims) -> Result<Delta, String> {
        sign_claims(claims, &self.1)
    }
}
struct Grant {
    binding: String,
    revision: String,
    authority: String,
    unavailable: bool,
}
impl MaterializationSourceCapability for Grant {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        panic!("never recaptures")
    }
    fn check_current(
        &mut self,
        b: &str,
        revision: &str,
        authority: &str,
        _: f64,
        _: Option<f64>,
        _: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        if self.unavailable {
            return Err(MaterializationSourceFailure::SourceUnavailable);
        }
        if b == self.binding && revision == self.revision && authority == self.authority {
            Ok(())
        } else {
            Err(MaterializationSourceFailure::SourceChanged)
        }
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("never restores")
    }
}
#[derive(Default)]
struct MemoryStore(BTreeMap<String, (Vec<u8>, String)>);
impl MaterializationControlStore for MemoryStore {
    fn initialize(
        &mut self,
        receiver: &str,
        configuration: &str,
        empty: &[u8],
    ) -> Result<MaterializationControlInitialize, String> {
        let key = format!("{receiver}/{configuration}");
        if let Some((bytes, revision)) = self.0.get(&key) {
            return Ok(MaterializationControlInitialize::Existing {
                bytes: bytes.clone(),
                revision: revision.clone(),
            });
        }
        self.0.insert(key, (empty.to_vec(), String::new()));
        Ok(MaterializationControlInitialize::Initialized {
            bytes: empty.to_vec(),
        })
    }
    fn read(
        &mut self,
        receiver: &str,
        configuration: &str,
    ) -> Result<MaterializationControlRead, String> {
        Ok(match self.0.get(&format!("{receiver}/{configuration}")) {
            Some((bytes, revision)) => MaterializationControlRead::Image {
                bytes: bytes.clone(),
                revision: revision.clone(),
            },
            None => MaterializationControlRead::Unavailable {
                fault: "absent".into(),
            },
        })
    }
    fn compare_and_set(
        &mut self,
        receiver: &str,
        configuration: &str,
        expected: &str,
        bytes: &[u8],
        revision: &str,
    ) -> Result<MaterializationControlWrite, String> {
        let key = format!("{receiver}/{configuration}");
        if self.0.get(&key).map(|(_, r)| r.as_str()) != Some(expected) {
            return Ok(MaterializationControlWrite::Conflict);
        }
        self.0.insert(key, (bytes.to_vec(), revision.into()));
        Ok(MaterializationControlWrite::Durable {
            revision: revision.into(),
        })
    }
}
/// The store is shared with the endpoint through a handle so the test can inspect images.
struct SharedStore(std::rc::Rc<std::cell::RefCell<MemoryStore>>);
impl MaterializationControlStore for SharedStore {
    fn initialize(
        &mut self,
        a: &str,
        b: &str,
        c: &[u8],
    ) -> Result<MaterializationControlInitialize, String> {
        self.0.borrow_mut().initialize(a, b, c)
    }
    fn read(&mut self, a: &str, b: &str) -> Result<MaterializationControlRead, String> {
        self.0.borrow_mut().read(a, b)
    }
    fn compare_and_set(
        &mut self,
        a: &str,
        b: &str,
        c: &str,
        d: &[u8],
        e: &str,
    ) -> Result<MaterializationControlWrite, String> {
        self.0.borrow_mut().compare_and_set(a, b, c, d, e)
    }
}
struct Fixture {
    seeds: Seeds,
    receiver: String,
    caller: String,
    configuration: Delta,
    operations: Vec<Delta>,
    binding: Delta,
    descriptor: Delta,
    capture: Delta,
    snapshot: Delta,
    authority: Delta,
    definitions: Vec<Delta>,
    source: (String, String, String),
    gather_body: CborValue,
    resolve_body: CborValue,
    limits: rhizomatic::materialization_data::MaterializationLimits,
}
fn fixture() -> Fixture {
    let v: Value = serde_json::from_str(CORPUS).unwrap();
    let seeds = Seeds {
        receiver: v["seeds"]["receiver"].as_str().unwrap().into(),
        caller: v["seeds"]["caller"].as_str().unwrap().into(),
        definition: v["seeds"]["definition"].as_str().unwrap().into(),
    };
    let receiver = author_for_seed(&seeds.receiver).unwrap();
    let caller = author_for_seed(&seeds.caller).unwrap();
    let plant = v["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "plant")
        .unwrap();
    let binding = parse_command_delta(&v["boot"]["bindings"][0]).unwrap();
    let config_a = parse_command_delta(&v["boot"]["configuration"]).unwrap();
    let limits_bytes = materialization_bytes(
        &read_materialization_description(&config_a, None).unwrap(),
        "limits",
    )
    .unwrap();
    let limits = read_materialization_limits(&limits_bytes).unwrap();
    let prefix = |s: &str| format!("rhizomatic.materialization.{s}");
    let operations: Vec<Delta> = MaterializationVerb::ALL
        .iter()
        .map(|verb| {
            sign(
                &seeds.receiver,
                0.0,
                "operation/1",
                BTreeMap::from([
                    ("name".to_string(), ent(&prefix(verb.as_str()))),
                    (
                        "interpreter".into(),
                        p(&prefix(&format!("{}/1", verb.as_str()))),
                    ),
                    (
                        "input-contract".into(),
                        p(&prefix(&format!("{}/1", verb.as_str()))),
                    ),
                    ("output-contract".into(), p(&prefix("outcome/1"))),
                    ("effect".into(), p(verb.effect())),
                    ("replay".into(), p("re-evaluate/1")),
                    ("dependencies".into(), p("explicit-support/1")),
                ]),
            )
        })
        .collect();
    let configuration = sign(
        &seeds.receiver,
        0.0,
        "endpoint/1",
        BTreeMap::from([
            ("receiver".to_string(), ent(&receiver)),
            ("caller".into(), p(&caller)),
            ("administrator".into(), p(&caller)),
            (
                "installed".into(),
                operations.iter().map(|o| r(&o.id)).collect(),
            ),
            ("source-binding".into(), vec![r(&binding.id)]),
            ("limits".into(), blob(limits_bytes)),
        ]),
    );
    let delivered: Vec<Delta> = plant["delivery"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| parse_command_delta(d).unwrap())
        .collect();
    let kind_of = |d: &Delta| -> String {
        match read_materialization_description(d, None) {
            Ok(f) => materialization_text(&f, "kind").unwrap(),
            Err(_) => {
                if d.claims.pointers[0]
                    .role
                    .starts_with("rhizomatic.hyperschema.")
                {
                    "hyper".into()
                } else {
                    "reading".into()
                }
            }
        }
    };
    let find = |k: &str| delivered.iter().find(|d| kind_of(d) == k).unwrap().clone();
    let gather = find("request/1");
    let gf = read_materialization_description(&gather, Some(MaterializationVerb::Gather)).unwrap();
    let descriptor = sign(
        &seeds.definition,
        0.0,
        "registration/1",
        BTreeMap::from([
            ("source-binding".to_string(), vec![r(&binding.id)]),
            (
                "hyperschema".into(),
                vec![r(&materialization_ref(&gf, "hyperschema").unwrap())],
            ),
            (
                "hyperschema-pin".into(),
                p(&materialization_text(&gf, "hyperschema-pin").unwrap()),
            ),
            (
                "schema".into(),
                vec![r(&materialization_ref(&gf, "schema").unwrap())],
            ),
            (
                "schema-pin".into(),
                p(&materialization_text(&gf, "schema-pin").unwrap()),
            ),
            (
                "roots".into(),
                ent(&materialization_entity(&gf, "root").unwrap()),
            ),
            (
                "bindings".into(),
                blob(materialization_bytes(&gf, "bindings").unwrap()),
            ),
            (
                "definition-at".into(),
                n(materialization_number(&gf, "definition-at").unwrap()),
            ),
            ("interpretation".into(), p("core/1")),
            ("result-kind".into(), p("hview-and-view/1")),
            ("time-policy".into(), p("live-time/1")),
            ("alias".into(), p("Plant")),
        ]),
    );
    let hex = |s: &str| hex::decode(s).unwrap();
    Fixture {
        receiver,
        caller,
        configuration,
        operations,
        binding,
        descriptor,
        capture: find("capture/1"),
        snapshot: find("snapshot/1"),
        authority: find("authority/1"),
        definitions: delivered
            .iter()
            .filter(|d| ["hyper", "reading"].contains(&kind_of(d).as_str()))
            .cloned()
            .collect(),
        source: (
            plant["source"]["binding"].as_str().unwrap().into(),
            plant["source"]["revision"].as_str().unwrap().into(),
            plant["source"]["authority"].as_str().unwrap().into(),
        ),
        gather_body: decode(&hex(plant["expected"]["gatherBodyHex"].as_str().unwrap())).unwrap(),
        resolve_body: decode(&hex(plant["expected"]["resolveBodyHex"].as_str().unwrap())).unwrap(),
        limits,
        seeds,
    }
}
struct Host<'a> {
    endpoint: MaterializationEndpoint<'a>,
    store: std::rc::Rc<std::cell::RefCell<MemoryStore>>,
}
fn host<'a>(f: &'a Fixture) -> Host<'a> {
    let store = std::rc::Rc::new(std::cell::RefCell::new(MemoryStore::default()));
    initialize_materialization_control(
        &mut SharedStore(store.clone()),
        &f.receiver,
        &f.configuration.id,
        &f.limits,
    )
    .unwrap();
    let grants: BTreeMap<String, Box<dyn MaterializationSourceCapability>> = BTreeMap::from([(
        f.binding.id.clone(),
        Box::new(Grant {
            binding: f.source.0.clone(),
            revision: f.source.1.clone(),
            authority: f.source.2.clone(),
            unavailable: false,
        }) as Box<dyn MaterializationSourceCapability>,
    )]);
    let endpoint = MaterializationEndpoint::boot_maintained(
        &MaterializationInputBoot {
            configuration: f.configuration.clone(),
            declarations: f.operations.clone(),
            bindings: vec![f.binding.clone()],
        },
        Box::new(Signer(f.receiver.clone(), f.seeds.receiver.clone())),
        grants,
        Box::new(|fault: &str| panic!("{fault}")),
        Box::new(SharedStore(store.clone())),
        Default::default(),
    )
    .unwrap();
    Host { endpoint, store }
}
impl Host<'_> {
    fn invoke(&mut self, q: &Delta, support: &[&Delta]) -> (String, CborValue) {
        let delivery: Vec<Value> = std::iter::once(q)
            .chain(support.iter().copied())
            .map(wire)
            .collect();
        let outcome = self.endpoint.invoke(&q.id, &delivery, 1000.0).unwrap();
        let f = read_materialization_description(&outcome, None).unwrap();
        let body = decode(&materialization_bytes(&f, "result").unwrap()).unwrap();
        let status = materialization_text(&f, "status").unwrap();
        (
            if status == "completed" {
                status
            } else {
                format!("{status}:{}", text(field(&body, "code")))
            },
            body,
        )
    }
    fn image(&self, f: &Fixture) -> (MaterializationControlImage, String) {
        let store = self.store.borrow();
        let (bytes, revision) = &store.0[&format!("{}/{}", f.receiver, f.configuration.id)];
        let l = rhizomatic::materialization_peer::MaterializationControlLimits {
            artifact_bytes: f.limits["artifactBytes"],
            registrations: f.limits["registrations"],
            definitions: f.limits["definitions"],
        };
        (
            decode_materialization_control(bytes, &l).unwrap(),
            revision.clone(),
        )
    }
}
fn request(f: &Fixture, verb: MaterializationVerb, fields: Vec<(&str, Vec<Target>)>) -> Delta {
    let op = f
        .operations
        .iter()
        .find(|o| {
            materialization_entity(&read_materialization_description(o, None).unwrap(), "name")
                .unwrap()
                == format!("rhizomatic.materialization.{}", verb.as_str())
        })
        .unwrap();
    let mut all: MaterializationFields = BTreeMap::from([
        ("receiver".to_string(), ent(&f.receiver)),
        ("configuration".into(), vec![r(&f.configuration.id)]),
        ("operation".into(), vec![r(&op.id)]),
    ]);
    for (k, v) in fields {
        all.insert(k.into(), v);
    }
    let _ = &f.caller;
    sign(&f.seeds.caller, 1000.0, "request/1", all)
}
#[test]
fn install_read_advance_replace_retire_and_restore_agree_with_the_batch_oracle() {
    let f = fixture();
    let mut h = host(&f);
    assert_eq!(h.image(&f).0.generation, 0.0);
    let install = |control: &str| {
        request(
            &f,
            MaterializationVerb::Install,
            vec![
                ("expected-control", p(control)),
                ("registration", vec![r(&f.descriptor.id)]),
                ("capture", vec![r(&f.capture.id)]),
                ("snapshot", vec![r(&f.snapshot.id)]),
                ("at", n(1000.0)),
                ("serving-at", n(1000.0)),
            ],
        )
    };
    let mut install_support: Vec<&Delta> =
        vec![&f.descriptor, &f.capture, &f.snapshot, &f.authority];
    install_support.extend(f.definitions.iter());
    let (status, body) = h.invoke(&install(""), &install_support);
    assert_eq!(status, "completed");
    assert_eq!(text(field(&body, "kind")), "install");
    assert_eq!(num(field(&body, "generation")), 1.0);
    let CborValue::Array(results) = field(&body, "results") else {
        panic!()
    };
    assert_eq!(results.len(), 1);
    for k in ["envelope", "transport", "hview"] {
        assert_eq!(
            encode(field(&results[0], k)),
            encode(field(&f.gather_body, k)),
            "{k}"
        );
    }
    for k in ["value", "view"] {
        assert_eq!(
            encode(field(&results[0], k)),
            encode(field(&f.resolve_body, k)),
            "{k}"
        );
    }
    assert_eq!(
        encode(field(&body, "basis")),
        encode(field(&f.gather_body, "basis"))
    );
    let (c1, r1) = h.image(&f);
    assert_eq!(c1.generation, 1.0);
    assert_eq!(text(field(&body, "control")), r1);
    assert_eq!(
        r1,
        content_address(&h.store.borrow().0[&format!("{}/{}", f.receiver, f.configuration.id)].0)
    );
    assert_eq!(c1.entries[0].registration, f.descriptor.id);
    assert_eq!(c1.entries[0].transition, text(field(&body, "transition")));
    assert_eq!(
        c1.entries[0].capture.as_deref(),
        Some(f.capture.id.as_str())
    );
    assert_eq!(c1.deltas.len(), 6);

    assert_eq!(
        h.invoke(&install(""), &install_support).0,
        "refused:precondition-failed"
    );
    assert_eq!(
        h.invoke(&install(&r1), &install_support).0,
        "refused:already-installed"
    );

    let read = |control: &str| {
        request(
            &f,
            MaterializationVerb::Read,
            vec![
                ("expected-control", p(control)),
                ("registration", vec![r(&f.descriptor.id)]),
                ("expected-source", p(&f.source.1)),
                ("snapshot", vec![r(&f.snapshot.id)]),
                ("serving-at", n(1000.0)),
            ],
        )
    };
    let (status, read_body) = h.invoke(&read(&r1), &[&f.snapshot]);
    assert_eq!(status, "completed");
    assert_eq!(text(field(&read_body, "kind")), "read");
    assert_eq!(text(field(&read_body, "control")), r1);
    assert_eq!(
        encode(field(&read_body, "results")),
        encode(field(&body, "results"))
    );
    assert_eq!(h.image(&f).0.generation, 1.0);

    let advance = |control: &str, at: f64| {
        request(
            &f,
            MaterializationVerb::AdvanceTime,
            vec![
                ("expected-control", p(control)),
                ("registration", vec![r(&f.descriptor.id)]),
                ("expected-source", p(&f.source.1)),
                ("snapshot", vec![r(&f.snapshot.id)]),
                ("at", n(at)),
                ("serving-at", n(1000.0)),
            ],
        )
    };
    let (status, advanced) = h.invoke(&advance(&r1, 1500.0), &[&f.snapshot]);
    assert_eq!(status, "completed");
    let (c2, r2) = h.image(&f);
    assert_eq!(c2.generation, 2.0);
    assert_eq!(c2.entries[0].at, 1500.0);
    assert_eq!(c2.deltas.len(), 6);
    assert_eq!(num(field(field(&advanced, "basis"), "at")), 1500.0);
    assert_eq!(
        h.invoke(&advance(&r2, 1200.0), &[&f.snapshot]).0,
        "refused:time-regression"
    );
    assert_eq!(h.image(&f).0.generation, 2.0);

    let replace = request(
        &f,
        MaterializationVerb::ReplaceSource,
        vec![
            ("expected-control", p(&r2)),
            ("registration", vec![r(&f.descriptor.id)]),
            ("expected-source", p(&f.source.1)),
            ("capture", vec![r(&f.capture.id)]),
            ("snapshot", vec![r(&f.snapshot.id)]),
            ("serving-at", n(1000.0)),
        ],
    );
    assert_eq!(
        h.invoke(&replace, &[&f.capture, &f.snapshot, &f.authority])
            .0,
        "completed"
    );
    let (c3, r3) = h.image(&f);
    assert_eq!(c3.generation, 3.0);
    assert_eq!(c3.deltas.len(), 6);

    let retire = |control: &str| {
        request(
            &f,
            MaterializationVerb::Retire,
            vec![
                ("expected-control", p(control)),
                ("registration", vec![r(&f.descriptor.id)]),
            ],
        )
    };
    let (status, retired) = h.invoke(&retire(&r3), &[]);
    assert_eq!(status, "completed");
    assert_eq!(text(field(&retired, "kind")), "retire");
    let (c4, r4) = h.image(&f);
    assert_eq!(c4.generation, 4.0);
    assert_eq!(c4.entries[0].status, MaterializationControlStatus::Retired);
    assert_eq!(c4.entries[0].capture, None);
    assert_eq!(c4.deltas.len(), 1);
    assert_eq!(h.invoke(&read(&r4), &[&f.snapshot]).0, "refused:retired");
    let (status, restored) = h.invoke(
        &request(
            &f,
            MaterializationVerb::Restore,
            vec![("expected-control", p(&r4))],
        ),
        &[],
    );
    assert_eq!(status, "completed");
    let CborValue::Array(selections) = field(&restored, "selections") else {
        panic!()
    };
    assert_eq!(text(field(&selections[0], "availability")), "retired");
    assert_eq!(
        h.invoke(&install(&r4), &install_support).0,
        "refused:retired"
    );
    assert_eq!(h.image(&f).0.generation, 4.0);
    let _ = canonical_bytes;
}
#[test]
fn the_empty_image_restores_with_no_selections_and_refuses_unknown_registrations() {
    let f = fixture();
    let mut h = host(&f);
    let (status, restored) = h.invoke(
        &request(
            &f,
            MaterializationVerb::Restore,
            vec![("expected-control", p(""))],
        ),
        &[],
    );
    assert_eq!(status, "completed");
    assert_eq!(text(field(&restored, "control")), "");
    let missing = request(
        &f,
        MaterializationVerb::Retire,
        vec![
            ("expected-control", p("")),
            ("registration", vec![r(&f.descriptor.id)]),
        ],
    );
    assert_eq!(h.invoke(&missing, &[]).0, "refused:registration-missing");
    let stale = request(
        &f,
        MaterializationVerb::Restore,
        vec![("expected-control", p(&content_address(&[0xa0])))],
    );
    assert_eq!(h.invoke(&stale, &[]).0, "refused:precondition-failed");
}

/// Shared schedule: a fresh endpoint per step from an explicit image (vectors/lifecycle.json).
#[test]
fn shared_lifecycle_schedule() {
    const SCHEDULE: &[u8] = include_bytes!("../../../vectors/materialization/lifecycle.json");
    let v: Value = serde_json::from_slice(SCHEDULE).unwrap();
    let boot = MaterializationInputBoot {
        configuration: parse_command_delta(&v["boot"]["configuration"]).unwrap(),
        declarations: v["boot"]["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| parse_command_delta(d).unwrap())
            .collect(),
        bindings: vec![parse_command_delta(&v["boot"]["bindings"][0]).unwrap()],
    };
    let receiver = v["keys"]["receiver"].as_str().unwrap().to_string();
    let seed = v["seeds"]["receiver"].as_str().unwrap().to_string();
    let source = (
        v["source"]["binding"].as_str().unwrap().to_string(),
        v["source"]["revision"].as_str().unwrap().to_string(),
        v["source"]["authority"].as_str().unwrap().to_string(),
    );
    for step in v["steps"].as_array().unwrap() {
        let store = std::rc::Rc::new(std::cell::RefCell::new(MemoryStore::default()));
        // A step may boot another configuration of the same receiver (limits, administrators).
        let boot = if step["bootOverride"].is_null() {
            MaterializationInputBoot {
                configuration: boot.configuration.clone(),
                declarations: boot.declarations.clone(),
                bindings: boot.bindings.clone(),
            }
        } else {
            MaterializationInputBoot {
                configuration: parse_command_delta(&step["bootOverride"]["configuration"]).unwrap(),
                declarations: step["bootOverride"]["declarations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| parse_command_delta(d).unwrap())
                    .collect(),
                bindings: step["bootOverride"]["bindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| parse_command_delta(d).unwrap())
                    .collect(),
            }
        };
        let key = format!("{receiver}/{}", boot.configuration.id);
        store.borrow_mut().0.insert(
            key.clone(),
            (
                hex::decode(step["initialControl"]["hex"].as_str().unwrap()).unwrap(),
                step["initialControlRevision"]
                    .as_str()
                    .unwrap_or(step["initialControl"]["revision"].as_str().unwrap())
                    .to_string(),
            ),
        );
        // The grant is current exactly for the source the step names; a step may name a moved
        // source, a later receive time, or no grant at all.
        let step_source = if step["source"].is_null() {
            source.clone()
        } else {
            (
                step["source"]["binding"].as_str().unwrap().to_string(),
                step["source"]["revision"].as_str().unwrap().to_string(),
                step["source"]["authority"].as_str().unwrap().to_string(),
            )
        };
        let mut grants: BTreeMap<String, Box<dyn MaterializationSourceCapability>> =
            BTreeMap::new();
        if step["noGrant"] != true {
            grants.insert(
                step_source.0.clone(),
                Box::new(Grant {
                    binding: step_source.0.clone(),
                    revision: step_source.1.clone(),
                    authority: step_source.2.clone(),
                    unavailable: step["sourceUnavailable"] == true,
                }) as Box<dyn MaterializationSourceCapability>,
            );
        }
        let received_at = step["receivedAt"].as_f64().unwrap_or(1000.0);
        let mut endpoint = MaterializationEndpoint::boot_maintained(
            &boot,
            Box::new(Signer(receiver.clone(), seed.clone())),
            grants,
            Box::new(|fault: &str| panic!("{fault}")),
            Box::new(SharedStore(store.clone())),
            Default::default(),
        )
        .unwrap();
        let q = parse_command_delta(&step["request"]).unwrap();
        let delivery = step["delivery"].as_array().unwrap().clone();
        let outcome = endpoint.invoke(&q.id, &delivery, received_at).unwrap();
        let mut assertions = 0;
        macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
        checked_eq!(
            outcome,
            parse_command_delta(&step["expected"]["outcome"]).unwrap(),
            "{}",
            step["id"]
        );
        let preflight =
            match rhizomatic::preflight_materialization_input(&boot, &q.id, &delivery, received_at)
                .unwrap()
            {
                rhizomatic::MaterializationInputPreflight::InputValid => {
                    serde_json::json!({"status":"input-valid"})
                }
                rhizomatic::MaterializationInputPreflight::OverInputLimit => {
                    serde_json::json!({"status":"over-input-limit","code":"resource-limit"})
                }
                rhizomatic::MaterializationInputPreflight::InvalidInput { code } => {
                    serde_json::json!({"status":"invalid-input","code":code})
                }
            };
        checked_eq!(preflight, step["expected"]["preflight"], "{}", step["id"]);
        // The image keeps captures and acts, never a snapshot payload (MR-14).
        let payloads: Vec<String> = delivery
            .iter()
            .map(|d| parse_command_delta(d).unwrap())
            .filter(|d| {
                d.claims.pointers.iter().any(|p| {
                    p.role == rhizomatic::materialization_data::materialization_role("kind")
                        && p.target == Target::Primitive(Primitive::Str("snapshot/1".into()))
                })
            })
            .map(|d| {
                hex::encode(
                    materialization_bytes(
                        &read_materialization_description(&d, None).unwrap(),
                        "data",
                    )
                    .unwrap(),
                )
            })
            .collect();
        let control_hex = step["expected"]["controlHex"].as_str().unwrap();
        checked_eq!(
            payloads.iter().any(|p| control_hex.contains(p.as_str())),
            false
        );
        let f = read_materialization_description(&outcome, None).unwrap();
        checked_eq!(
            materialization_text(&f, "status").unwrap(),
            step["expected"]["status"].as_str().unwrap()
        );
        checked_eq!(
            hex::encode(materialization_bytes(&f, "result").unwrap()),
            step["expected"]["bodyHex"].as_str().unwrap()
        );
        checked_eq!(
            hex::encode(&store.borrow().0[&key].0),
            step["expected"]["controlHex"].as_str().unwrap()
        );
        println!(
            "materialization-m3-assertion:{}",
            serde_json::json!({"corpus":"lifecycle","corpusId":hex::encode(sha2::Sha256::digest(SCHEDULE)),"group":"steps","id":step["id"],"assertions":assertions})
        );
    }
}

/// MR-20 readback of every shared step: the request, the post-CAS image and the delivered
/// source pair link a completed body to a verified contextual answer; any broken link demotes it.
#[test]
fn shared_lifecycle_readback() {
    use rhizomatic::{
        read_materialization_result, MaterializationResultClassification as C,
        MaterializationResultContext, MaterializationSourceCommitments as S,
    };
    const SCHEDULE: &[u8] = include_bytes!("../../../vectors/materialization/lifecycle.json");
    let v: Value = serde_json::from_slice(SCHEDULE).unwrap();
    let configuration = parse_command_delta(&v["boot"]["configuration"]).unwrap();
    let limits = read_materialization_limits(
        &materialization_bytes(
            &read_materialization_description(&configuration, None).unwrap(),
            "limits",
        )
        .unwrap(),
    )
    .unwrap();
    let receiver = v["keys"]["receiver"].as_str().unwrap().to_string();
    let seed = v["seeds"]["receiver"].as_str().unwrap().to_string();
    let steps = v["steps"].as_array().unwrap();
    let delivered = |step: &Value, kind: &str| -> Option<Delta> {
        step["delivery"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| parse_command_delta(d).unwrap())
            .find(|d| {
                d.claims.pointers.iter().any(|x| {
                    x.role == rhizomatic::materialization_data::materialization_role("kind")
                        && x.target == p(kind)[0]
                })
            })
    };
    let install = steps.iter().find(|s| s["id"] == "install").unwrap();
    // A read step delivers only its snapshot; its capture was delivered by the install or
    // replacement that selected that snapshot.
    let mut paired: BTreeMap<String, Delta> = BTreeMap::new();
    for s in steps {
        if let (Some(c), Some(n)) = (delivered(s, "capture/1"), delivered(s, "snapshot/1")) {
            paired.insert(n.id.clone(), c);
        }
    }
    let outcome_of = |q: &Delta, cfg: &str, status: &str, result: &CborValue| -> Delta {
        sign(
            &seed,
            1000.0,
            "outcome/1",
            MaterializationFields::from([
                ("receiver".into(), ent(&receiver)),
                ("configuration".into(), vec![r(cfg)]),
                ("request".into(), vec![r(&q.id)]),
                ("status".into(), p(status)),
                ("result".into(), blob(encode(result))),
            ]),
        )
    };
    for step in steps {
        let mut assertions = 0;
        macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
        let outcome = parse_command_delta(&step["expected"]["outcome"]).unwrap();
        let q = parse_command_delta(&step["request"]).unwrap();
        let configuration_id = if step["bootOverride"].is_null() {
            configuration.id.clone()
        } else {
            parse_command_delta(&step["bootOverride"]["configuration"])
                .unwrap()
                .id
        };
        let base = MaterializationResultContext {
            receiver: receiver.clone(),
            configuration: configuration_id.clone(),
            request: q.id.clone(),
            request_delta: None,
            evidence: None,
            binding: None,
            revision: None,
            authority: None,
            capture: None,
            snapshot: None,
            received_at: Some(step["receivedAt"].as_f64().unwrap_or(1000.0)),
            control: None,
        };
        let structure = read_materialization_result(&outcome, &base, &limits).unwrap();
        checked_eq!(
            structure.status,
            step["expected"]["status"].as_str().unwrap()
        );
        checked_eq!(
            hex::encode(encode(&structure.body)),
            step["expected"]["bodyHex"].as_str().unwrap()
        );
        checked_eq!(structure.classification, C::VerifiedStructure);
        let snapshot = delivered(step, "snapshot/1");
        let capture = delivered(step, "capture/1")
            .or_else(|| snapshot.as_ref().and_then(|n| paired.get(&n.id).cloned()));
        let full = MaterializationResultContext {
            request_delta: Some(q.clone()),
            control: Some(hex::decode(step["expected"]["controlHex"].as_str().unwrap()).unwrap()),
            capture: if snapshot.is_some() { capture } else { None },
            snapshot: snapshot.clone(),
            ..base.clone()
        };
        if step["expected"]["status"] == "refused" {
            let read = read_materialization_result(
                &outcome,
                &MaterializationResultContext {
                    request_delta: Some(q.clone()),
                    ..base.clone()
                },
                &limits,
            )
            .unwrap();
            checked_eq!(read.classification, C::VerifiedContext);
            checked_eq!(
                text(field(&read.body, "code")),
                step["expected"]["code"].as_str().unwrap()
            );
            checked_eq!(
                read_materialization_result(
                    &outcome,
                    &MaterializationResultContext {
                        request: outcome.id.clone(),
                        ..base.clone()
                    },
                    &limits
                )
                .unwrap_err(),
                "invalid-evidence"
            );
        } else {
            let read = read_materialization_result(&outcome, &full, &limits).unwrap();
            checked_eq!(read.classification, C::VerifiedContext);
            checked_eq!(
                read.source_commitments,
                if snapshot.is_some() {
                    S::CommitmentsVerified
                } else {
                    S::Attested
                }
            );
            checked_eq!(read.values.is_empty(), snapshot.is_none());
            // The pre-CAS image is not the image the body names, except for the effect-free verbs.
            let stale = MaterializationResultContext {
                control: Some(
                    hex::decode(step["initialControl"]["hex"].as_str().unwrap()).unwrap(),
                ),
                ..full.clone()
            };
            if step["initialControl"]["hex"] == step["expected"]["controlHex"] {
                checked_eq!(
                    read_materialization_result(&outcome, &stale, &limits)
                        .unwrap()
                        .classification,
                    C::VerifiedContext
                );
            } else {
                checked_eq!(
                    read_materialization_result(&outcome, &stale, &limits).unwrap_err(),
                    "invalid-evidence"
                );
            }
            // The request must be the one the outcome names.
            let other = parse_command_delta(
                &steps.iter().find(|s| s["id"] != step["id"]).unwrap()["request"],
            )
            .unwrap();
            checked_eq!(
                read_materialization_result(
                    &outcome,
                    &MaterializationResultContext {
                        request: other.id.clone(),
                        request_delta: Some(other),
                        ..full.clone()
                    },
                    &limits
                )
                .unwrap_err(),
                "invalid-evidence"
            );
            // A body missing one root no longer reads in context.
            let body = decode(&hex::decode(step["expected"]["bodyHex"].as_str().unwrap()).unwrap())
                .unwrap();
            if let CborValue::Map(fields) = &body {
                if fields.iter().any(|(k, _)| k == "results") {
                    let dropped = CborValue::Map(
                        fields
                            .iter()
                            .map(|(k, x)| match (k.as_str(), x) {
                                ("results", CborValue::Array(xs)) => {
                                    (k.clone(), CborValue::Array(xs[1..].to_vec()))
                                }
                                _ => (k.clone(), x.clone()),
                            })
                            .collect(),
                    );
                    let forged = outcome_of(&q, &configuration_id, "completed", &dropped);
                    checked_eq!(
                        read_materialization_result(&forged, &base, &limits)
                            .unwrap()
                            .classification,
                        C::VerifiedStructure
                    );
                    checked_eq!(
                        read_materialization_result(&forged, &full, &limits).unwrap_err(),
                        "invalid-evidence"
                    );
                }
            }
        }
        println!(
            "materialization-m3-assertion:{}",
            serde_json::json!({"corpus":"lifecycle","corpusId":hex::encode(sha2::Sha256::digest(SCHEDULE)),"group":"readback","id":step["id"],"assertions":assertions})
        );
    }
    // Indeterminate outcomes read as structure with their exact MR-19 shape.
    let q = parse_command_delta(&install["request"]).unwrap();
    let base = MaterializationResultContext {
        receiver: receiver.clone(),
        configuration: configuration.id.clone(),
        request: q.id.clone(),
        request_delta: None,
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: None,
        snapshot: None,
        received_at: None,
        control: None,
    };
    let control = content_address(&[1]);
    let m = |fields: Vec<(&str, &str)>| {
        CborValue::Map(
            fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), CborValue::Tstr(v.to_string())))
                .collect(),
        )
    };
    let unconfirmed = read_materialization_result(
        &outcome_of(
            &q,
            &configuration.id,
            "indeterminate",
            &m(vec![("code", "commit-unconfirmed")]),
        ),
        &base,
        &limits,
    )
    .unwrap();
    assert_eq!(unconfirmed.status, "indeterminate");
    assert_eq!(unconfirmed.classification, C::VerifiedStructure);
    let unavailable = read_materialization_result(
        &outcome_of(
            &q,
            &configuration.id,
            "indeterminate",
            &m(vec![("code", "result-unavailable"), ("control", &control)]),
        ),
        &MaterializationResultContext {
            request_delta: Some(q.clone()),
            ..base.clone()
        },
        &limits,
    )
    .unwrap();
    assert_eq!(unavailable.status, "indeterminate");
    assert_eq!(unavailable.classification, C::VerifiedContext);
    for bad in [
        m(vec![("code", "result-unavailable")]),
        m(vec![("code", "commit-unconfirmed"), ("control", &control)]),
        m(vec![("code", "write-conflict")]),
    ] {
        assert_eq!(
            read_materialization_result(
                &outcome_of(&q, &configuration.id, "indeterminate", &bad),
                &base,
                &limits
            )
            .unwrap_err(),
            "invalid-evidence"
        );
    }
}

/// A linked readback must refuse a request the selected transition did not answer: a different
/// expected control, or a serving time the outcome and Basis do not carry.
#[test]
fn hostile_request_contexts_are_refused() {
    use rhizomatic::{
        read_materialization_result, MaterializationResultClassification as C,
        MaterializationResultContext,
    };
    const SCHEDULE: &[u8] = include_bytes!("../../../vectors/materialization/lifecycle.json");
    let v: Value = serde_json::from_slice(SCHEDULE).unwrap();
    let configuration = parse_command_delta(&v["boot"]["configuration"]).unwrap();
    let limits = read_materialization_limits(
        &materialization_bytes(
            &read_materialization_description(&configuration, None).unwrap(),
            "limits",
        )
        .unwrap(),
    )
    .unwrap();
    let receiver = v["keys"]["receiver"].as_str().unwrap().to_string();
    let install = v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "install")
        .unwrap();
    let delivered = |kind: &str| -> Delta {
        install["delivery"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| parse_command_delta(d).unwrap())
            .find(|d| {
                d.claims.pointers.iter().any(|x| {
                    x.role == rhizomatic::materialization_data::materialization_role("kind")
                        && x.target == p(kind)[0]
                })
            })
            .unwrap()
    };
    let outcome = parse_command_delta(&install["expected"]["outcome"]).unwrap();
    let q = parse_command_delta(&install["request"]).unwrap();
    let control = hex::decode(install["expected"]["controlHex"].as_str().unwrap()).unwrap();
    let context = |request: &Delta| MaterializationResultContext {
        receiver: receiver.clone(),
        configuration: configuration.id.clone(),
        request: request.id.clone(),
        request_delta: Some(request.clone()),
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: Some(delivered("capture/1")),
        snapshot: Some(delivered("snapshot/1")),
        received_at: Some(1000.0),
        control: Some(control.clone()),
    };
    assert_eq!(
        read_materialization_result(&outcome, &context(&q), &limits)
            .unwrap()
            .classification,
        C::VerifiedContext
    );
    let resign = |patch: (&str, Vec<Target>)| -> (Delta, Delta) {
        let mut fields =
            read_materialization_description(&q, Some(MaterializationVerb::Install)).unwrap();
        fields.remove("kind");
        fields.insert(patch.0.into(), patch.1);
        let request = sign(
            v["seeds"]["caller"].as_str().unwrap(),
            1000.0,
            "request/1",
            fields,
        );
        let of = read_materialization_description(&outcome, None).unwrap();
        let forged = sign(
            v["seeds"]["receiver"].as_str().unwrap(),
            1000.0,
            "outcome/1",
            MaterializationFields::from([
                ("receiver".into(), of["receiver"].clone()),
                ("configuration".into(), of["configuration"].clone()),
                ("request".into(), vec![r(&request.id)]),
                ("status".into(), of["status"].clone()),
                ("result".into(), of["result"].clone()),
            ]),
        );
        (request, forged)
    };
    let (request, forged) = resign(("expected-control", p(&content_address(&[0x12]))));
    assert_eq!(
        read_materialization_result(&forged, &context(&request), &limits).unwrap_err(),
        "invalid-evidence"
    );
    let (request, forged) = resign(("serving-at", n(9999.0)));
    assert_eq!(
        read_materialization_result(&forged, &context(&request), &limits).unwrap_err(),
        "invalid-evidence"
    );
    // Without a capture in the context, the request's capture must still be the capture the
    // image selected for the registration.
    let bare = |request: &Delta| MaterializationResultContext {
        capture: None,
        snapshot: None,
        ..context(request)
    };
    assert_eq!(
        read_materialization_result(&outcome, &bare(&q), &limits)
            .unwrap()
            .classification,
        C::VerifiedContext
    );
    let (request, forged) = resign(("capture", vec![r(&content_address(&[0x34]))]));
    assert_eq!(
        read_materialization_result(&forged, &bare(&request), &limits).unwrap_err(),
        "invalid-evidence"
    );
}

// A body with one result whose root is the registered roots joined by NUL is not the complete
// root partition; readback compares roots one by one.
#[test]
fn a_single_result_joining_the_registered_roots_is_refused() {
    use rhizomatic::{
        read_materialization_result, MaterializationResultClassification as C,
        MaterializationResultContext,
    };
    const SCHEDULE: &[u8] = include_bytes!("../../../vectors/materialization/lifecycle.json");
    let v: Value = serde_json::from_slice(SCHEDULE).unwrap();
    let configuration = parse_command_delta(&v["boot"]["configuration"]).unwrap();
    let limits = read_materialization_limits(
        &materialization_bytes(
            &read_materialization_description(&configuration, None).unwrap(),
            "limits",
        )
        .unwrap(),
    )
    .unwrap();
    let receiver = v["keys"]["receiver"].as_str().unwrap().to_string();
    let step = v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "install_private_use_roots")
        .unwrap();
    let q = parse_command_delta(&step["request"]).unwrap();
    let body =
        decode(&hex::decode(step["expected"]["bodyHex"].as_str().unwrap()).unwrap()).unwrap();
    let CborValue::Array(results) = field(&body, "results") else {
        panic!("results")
    };
    assert!(results.len() >= 2);
    let joined = results
        .iter()
        .map(|r| text(field(r, "root")).to_string())
        .collect::<Vec<_>>()
        .join("\0");
    let CborValue::Map(first) = &results[0] else {
        panic!("result")
    };
    let one = CborValue::Map(
        first
            .iter()
            .map(|(k, x)| {
                if k == "root" {
                    (k.clone(), CborValue::Tstr(joined.clone()))
                } else {
                    (k.clone(), x.clone())
                }
            })
            .collect(),
    );
    let CborValue::Map(fields) = &body else {
        panic!("body")
    };
    let forged_body = CborValue::Map(
        fields
            .iter()
            .map(|(k, x)| {
                if k == "results" {
                    (k.clone(), CborValue::Array(vec![one.clone()]))
                } else {
                    (k.clone(), x.clone())
                }
            })
            .collect(),
    );
    let forged = sign(
        v["seeds"]["receiver"].as_str().unwrap(),
        1000.0,
        "outcome/1",
        MaterializationFields::from([
            ("receiver".into(), ent(&receiver)),
            ("configuration".into(), vec![r(&configuration.id)]),
            ("request".into(), vec![r(&q.id)]),
            ("status".into(), p("completed")),
            ("result".into(), blob(encode(&forged_body))),
        ]),
    );
    let context = MaterializationResultContext {
        receiver: receiver.clone(),
        configuration: configuration.id.clone(),
        request: q.id.clone(),
        request_delta: Some(q.clone()),
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: None,
        snapshot: None,
        received_at: Some(1000.0),
        control: Some(hex::decode(step["expected"]["controlHex"].as_str().unwrap()).unwrap()),
    };
    let outcome = parse_command_delta(&step["expected"]["outcome"]).unwrap();
    assert_eq!(
        read_materialization_result(&outcome, &context, &limits)
            .unwrap()
            .classification,
        C::VerifiedContext
    );
    assert_eq!(
        read_materialization_result(&forged, &context, &limits).unwrap_err(),
        "invalid-evidence"
    );
}
