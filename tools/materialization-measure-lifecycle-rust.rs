//! Temporary measurement-crate host for the M4 lifecycle sweep. The counter delegates to the
//! exact strict verifier in the copied sign.rs. Each step boots a fresh endpoint over an
//! in-memory store seeded with the step's stored image; outcomes and images must equal the
//! fixture's goldens.
use rhizomatic::{
    delta::canonical_bytes,
    json_profile::parse_delta,
    materialization_data::{materialization_bytes, read_materialization_description},
    materialization_peer::{
        MaterializationControlInitialize, MaterializationControlRead, MaterializationControlStore,
        MaterializationControlWrite,
    },
    materialization_source::{
        MaterializationCapture, MaterializationSourceCapability, MaterializationSourceFailure,
    },
    sign::{measurement_count, measurement_reset, sign_claims},
    types::{Claims, Delta},
    MaterializationEndpoint, MaterializationInputBoot, MaterializationSigner,
};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap, io::Read, rc::Rc, time::Instant};
struct Signer(String, String);
impl MaterializationSigner for Signer {
    fn author(&self) -> &str {
        &self.0
    }
    fn sign(&self, c: &Claims) -> Result<Delta, String> {
        sign_claims(c, &self.1)
    }
}
struct Grant {
    source: Value,
    checks: Rc<RefCell<usize>>,
}
impl MaterializationSourceCapability for Grant {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        panic!("the measured lifecycle never recaptures")
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("the measured lifecycle never reacquires")
    }
    fn check_current(
        &mut self,
        b: &str,
        r: &str,
        a: &str,
        _: f64,
        _: Option<f64>,
        _: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        *self.checks.borrow_mut() += 1;
        if b == self.source["binding"]
            && r == self.source["revision"]
            && a == self.source["authority"]
        {
            Ok(())
        } else {
            Err(MaterializationSourceFailure::SourceChanged)
        }
    }
}
/// One image per receiver and configuration, shared with the endpoint so the host can read it.
#[derive(Clone, Default)]
struct Store(Rc<RefCell<BTreeMap<String, (Vec<u8>, String)>>>);
impl MaterializationControlStore for Store {
    fn initialize(
        &mut self,
        receiver: &str,
        configuration: &str,
        empty: &[u8],
    ) -> Result<MaterializationControlInitialize, String> {
        let key = format!("{receiver}/{configuration}");
        if let Some((bytes, revision)) = self.0.borrow().get(&key) {
            return Ok(MaterializationControlInitialize::Existing {
                bytes: bytes.clone(),
                revision: revision.clone(),
            });
        }
        self.0
            .borrow_mut()
            .insert(key, (empty.to_vec(), String::new()));
        Ok(MaterializationControlInitialize::Initialized {
            bytes: empty.to_vec(),
        })
    }
    fn read(
        &mut self,
        receiver: &str,
        configuration: &str,
    ) -> Result<MaterializationControlRead, String> {
        Ok(
            match self.0.borrow().get(&format!("{receiver}/{configuration}")) {
                Some((bytes, revision)) => MaterializationControlRead::Image {
                    bytes: bytes.clone(),
                    revision: revision.clone(),
                },
                None => MaterializationControlRead::Unavailable {
                    fault: "absent".into(),
                },
            },
        )
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
        if self.0.borrow().get(&key).map(|(_, r)| r.as_str()) != Some(expected) {
            return Ok(MaterializationControlWrite::Conflict);
        }
        self.0
            .borrow_mut()
            .insert(key, (bytes.to_vec(), revision.into()));
        Ok(MaterializationControlWrite::Durable {
            revision: revision.into(),
        })
    }
}
fn cost(start: Instant) -> Value {
    json!({"wallMs": start.elapsed().as_secs_f64() * 1000.0, "strictSignatureVerifications": measurement_count()})
}
fn signed_bytes(d: &Delta) -> usize {
    canonical_bytes(&d.claims).unwrap().len() + if d.sig.is_some() { 64 } else { 0 }
}
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let f: Value = serde_json::from_str(&input).unwrap();
    let parse_all = |v: &Value| -> Vec<Delta> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|d| parse_delta(d).unwrap())
            .collect()
    };
    let boot = MaterializationInputBoot {
        configuration: parse_delta(&f["boot"]["configuration"]).unwrap(),
        declarations: parse_all(&f["boot"]["declarations"]),
        bindings: parse_all(&f["boot"]["bindings"]),
    };
    let receiver = f["keys"]["receiver"].as_str().unwrap().to_string();
    let seed = f["seeds"]["receiver"].as_str().unwrap().to_string();
    let key = format!("{receiver}/{}", boot.configuration.id);
    let mut steps = Vec::new();
    for step in f["steps"].as_array().unwrap() {
        let store = Store::default();
        store.0.borrow_mut().insert(
            key.clone(),
            (
                hex::decode(step["initialControl"]["hex"].as_str().unwrap()).unwrap(),
                step["initialControl"]["revision"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            ),
        );
        let checks = Rc::new(RefCell::new(0));
        let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
        grants.insert(
            step["source"]["binding"].as_str().unwrap().to_string(),
            Box::new(Grant {
                source: step["source"].clone(),
                checks: checks.clone(),
            }),
        );
        measurement_reset();
        let start = Instant::now();
        let mut endpoint = MaterializationEndpoint::boot_maintained(
            &boot,
            Box::new(Signer(receiver.clone(), seed.clone())),
            grants,
            Box::new(|fault: &str| panic!("{fault}")),
            Box::new(store.clone()),
            Default::default(),
        )
        .unwrap();
        let booted = cost(start);
        let q = parse_delta(&step["request"]).unwrap();
        let delivery = step["delivery"].as_array().unwrap().clone();
        measurement_reset();
        let start = Instant::now();
        let outcome = endpoint.invoke(&q.id, &delivery, 1000.0).unwrap();
        let ran = cost(start);
        let id = step["id"].as_str().unwrap();
        // Compare canonical bytes: JSON number equality would split 1000 from 1000.0.
        let golden = parse_delta(&step["expected"]["outcome"]).unwrap();
        assert_eq!(
            (outcome.id.as_str(), &outcome.sig),
            (golden.id.as_str(), &golden.sig),
            "{id}"
        );
        assert_eq!(
            canonical_bytes(&outcome.claims).unwrap(),
            canonical_bytes(&golden.claims).unwrap(),
            "{id}"
        );
        let after = store.0.borrow().get(&key).unwrap().0.clone();
        assert_eq!(
            hex::encode(&after),
            step["expected"]["controlHex"].as_str().unwrap(),
            "{id}"
        );
        let phase = step["phase"].as_str().unwrap();
        let result = materialization_bytes(
            &read_materialization_description(&outcome, None).unwrap(),
            "result",
        )
        .unwrap();
        steps.push(json!({
            "phase": phase,
            "id": id,
            "status": step["expected"]["status"],
            "lengths": {
                "delivery": delivery.iter().map(|d| signed_bytes(&parse_delta(d).unwrap())).sum::<usize>(),
                "controlBefore": step["initialControl"]["hex"].as_str().unwrap().len() / 2,
                "controlAfter": after.len(),
                "result": result.len(),
            },
            "phases": { "boot": booted, phase: ran },
            "currentChecks": *checks.borrow(),
        }));
    }
    println!(
        "{}",
        json!({
            "witness": "rust",
            "id": f["id"],
            "selectedAppearances": f["selectedAppearances"],
            "status": f["expectedStatus"],
            "steps": steps,
        })
    );
}
