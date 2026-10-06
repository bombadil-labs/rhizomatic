//! Temporary measurement-crate host. Counter delegates to the exact strict verifier in copied sign.rs.
use rhizomatic::{
    cbor::encode,
    delta::canonical_bytes,
    hash::content_address,
    json_profile::parse_delta,
    materialization_command::{MaterializationEndpoint, MaterializationSigner},
    materialization_data::{materialization_bytes, read_materialization_description},
    materialization_input::MaterializationInputBoot,
    materialization_result::{read_materialization_result, MaterializationResultContext},
    materialization_source::{
        decode_materialization_snapshot, validate_materialization_capture_basis,
        MaterializationCapture, MaterializationSourceCapability, MaterializationSourceFailure,
    },
    set::DeltaSet,
    sign::{
        measurement_count, measurement_reset, sign_claims, verify_canonical_delta, Verification,
    },
    types::{Claims, Delta},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, time::Instant};
struct Signer {
    author: String,
    seed: String,
}
impl MaterializationSigner for Signer {
    fn author(&self) -> &str {
        &self.author
    }
    fn sign(&self, c: &Claims) -> Result<Delta, String> {
        sign_claims(c, &self.seed)
    }
}
struct Source {
    fixture: Value,
}
impl MaterializationSourceCapability for Source {
    fn capture(
        &mut self,
        binding: &str,
        at: f64,
        cutoff: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        let f = &self.fixture;
        assert_eq!(binding, f["source"]["binding"].as_str().unwrap());
        assert_eq!(at, 1000.);
        assert_eq!(cutoff, None);
        Ok(MaterializationCapture {
            capture: parse_delta(&f["capture"]).unwrap(),
            authority: parse_delta(
                f["delivery"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|d| d["id"] == f["source"]["authority"])
                    .unwrap(),
            )
            .unwrap(),
            snapshot: parse_delta(&f["snapshot"]).unwrap(),
        })
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("M2 batch never restores")
    }
    fn check_current(
        &mut self,
        b: &str,
        r: &str,
        a: &str,
        t: f64,
        c: Option<f64>,
        support: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        let f = &self.fixture;
        assert_eq!(b, f["source"]["binding"].as_str().unwrap());
        assert_eq!(r, f["source"]["revision"].as_str().unwrap());
        assert_eq!(a, f["source"]["authority"].as_str().unwrap());
        assert_eq!(t, 1000.);
        assert_eq!(c, None);
        assert_eq!(
            support,
            f["source"]["requiredSupport"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        );
        Ok(())
    }
}
fn phase<T>(phases: &mut BTreeMap<String, Value>, name: &str, op: impl FnOnce() -> T) -> T {
    measurement_reset();
    let start = Instant::now();
    let answer = op();
    phases.insert(name.into(),json!({"wallMs":start.elapsed().as_secs_f64()*1000.,"strictSignatureVerifications":measurement_count()}));
    answer
}
fn size(d: &Delta) -> usize {
    canonical_bytes(&d.claims).unwrap().len() + if d.sig.is_some() { 64 } else { 0 }
}
fn payload(d: &Delta, role: &str) -> Vec<u8> {
    materialization_bytes(&read_materialization_description(d, None).unwrap(), role).unwrap()
}
fn main() {
    let mut bytes = String::new();
    std::io::stdin().read_to_string(&mut bytes).unwrap();
    let input: Value = serde_json::from_str(&bytes).unwrap();
    let f = &input["fixture"];
    let q = parse_delta(&f["request"]).unwrap();
    let capture = parse_delta(&f["capture"]).unwrap();
    let snapshot = parse_delta(&f["snapshot"]).unwrap();
    let snapshot_bytes = payload(&snapshot, "data");
    let authority = parse_delta(
        f["delivery"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == f["source"]["authority"])
            .unwrap(),
    )
    .unwrap();
    let mut phases = BTreeMap::new();
    phase(&mut phases, "capture-fixture-host", || {
        for d in [&capture, &snapshot, &authority] {
            assert_eq!(verify_canonical_delta(d), Verification::Verified)
        }
        if input["selectedAppearances"].as_u64().unwrap() <= 4096 {
            let s = decode_materialization_snapshot(&snapshot_bytes, Default::default()).unwrap();
            let rows = DeltaSet::from_deltas(
                f["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| parse_delta(d).unwrap()),
            )
            .unwrap();
            assert_eq!(
                DeltaSet::from_deltas(s.deltas).unwrap().digest(),
                rows.digest()
            );
            validate_materialization_capture_basis(
                &payload(&capture, "basis"),
                &snapshot_bytes,
                Default::default(),
            )
            .unwrap();
        }
    });
    let boot = MaterializationInputBoot {
        configuration: parse_delta(&f["boot"]["configuration"]).unwrap(),
        declarations: f["boot"]["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| parse_delta(d).unwrap())
            .collect(),
        bindings: f["boot"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| parse_delta(d).unwrap())
            .collect(),
    };
    let mut endpoint = phase(&mut phases, "boot", || {
        MaterializationEndpoint::boot(
            &boot,
            Box::new(Signer {
                author: boot.configuration.claims.author.clone(),
                seed: f["seeds"]["receiver"].as_str().unwrap().into(),
            }),
            BTreeMap::from([(
                f["source"]["binding"].as_str().unwrap().into(),
                Box::new(Source { fixture: f.clone() }) as Box<dyn MaterializationSourceCapability>,
            )]),
            Box::new(|e| panic!("{e}")),
        )
        .unwrap()
    });
    let gathered = phase(&mut phases, "gather", || {
        endpoint
            .invoke(&q.id, f["delivery"].as_array().unwrap(), 1000.)
            .unwrap()
    });
    assert_eq!(gathered, parse_delta(&f["expected"]["gather"]).unwrap());
    let limits = rhizomatic::materialization_data::read_materialization_limits(&payload(
        &boot.configuration,
        "limits",
    ))
    .unwrap();
    let mut ctx = MaterializationResultContext {
        receiver: boot.configuration.claims.author.clone(),
        configuration: boot.configuration.id.clone(),
        request: q.id.clone(),
        request_delta: Some(q.clone()),
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: Some(capture.clone()),
        snapshot: Some(snapshot.clone()),
        received_at: Some(1000.),
    };
    let read = phase(&mut phases, "gather-readback", || {
        read_materialization_result(&gathered, &ctx, &limits).unwrap()
    });
    let mut lengths = BTreeMap::from([
        ("snapshot", snapshot_bytes.len()),
        ("capture", size(&capture)),
        ("snapshotCarrier", size(&snapshot)),
        (
            "delivery",
            f["delivery"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| size(&parse_delta(d).unwrap()))
                .sum(),
        ),
        ("gatherResult", payload(&gathered, "result").len()),
    ]);
    if input["expectedStatus"] == "completed" {
        assert_eq!(read.status, "completed");
        assert_eq!(
            hex::encode(encode(&read.body)),
            f["expected"]["gatherBodyHex"].as_str().unwrap()
        );
        let rhizomatic::cbor::CborValue::Map(body) = &read.body else {
            panic!()
        };
        let (_, rhizomatic::cbor::CborValue::Bstr(envelope)) =
            body.iter().find(|(k, _)| k == "envelope").unwrap()
        else {
            panic!()
        };
        lengths.insert("envelope", envelope.len());
        let rq = parse_delta(&f["resolve"]).unwrap();
        let result = phase(&mut phases, "resolve", || {
            endpoint
                .invoke(&rq.id, f["resolveDelivery"].as_array().unwrap(), 1000.)
                .unwrap()
        });
        assert_eq!(result, parse_delta(&f["expected"]["resolve"]).unwrap());
        ctx.request = rq.id.clone();
        ctx.request_delta = Some(rq);
        ctx.evidence = Some(parse_delta(&f["resolveDelivery"][1]).unwrap());
        let resolved = phase(&mut phases, "resolve-readback", || {
            read_materialization_result(&result, &ctx, &limits).unwrap()
        });
        assert_eq!(
            hex::encode(encode(&resolved.body)),
            f["expected"]["resolveBodyHex"].as_str().unwrap()
        );
        lengths.insert("resolveResult", payload(&result, "result").len());
    }
    println!(
        "{}",
        json!({"witness":"rust-release","id":f["id"],"selectedAppearances":input["selectedAppearances"],"status":if read.status=="completed"{"completed"}else{"refused"},"lengths":lengths,"phases":phases,"snapshotCommitment":content_address(&snapshot_bytes),"nativeCapture":"Fixture-native validation/acquisition of original full artifacts; no Loam I/O, generic capturer, fresh-signing or M3 restore claimed."})
    );
}
