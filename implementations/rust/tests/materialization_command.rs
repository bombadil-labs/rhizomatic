#[path = "support/materialization_assertions.rs"]
mod assertion_evidence;
use rhizomatic::{
    cbor::encode,
    json_profile::parse_delta,
    materialization_command::*,
    materialization_data::*,
    materialization_input::MaterializationInputBoot,
    materialization_result::*,
    materialization_source::*,
    set::DeltaSet,
    sign::sign_claims,
    types::{Claims, Delta},
};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};
struct Signer {
    author: String,
    seed: String,
}
impl MaterializationSigner for Signer {
    fn author(&self) -> &str {
        &self.author
    }
    fn sign(&self, claims: &Claims) -> Result<Delta, String> {
        sign_claims(claims, &self.seed)
    }
}
#[derive(Debug, Clone, PartialEq)]
struct Check {
    binding: String,
    revision: String,
    authority: String,
    at: f64,
    cutoff: Option<f64>,
    support: Vec<String>,
}
struct Source {
    rows: BTreeMap<String, Delta>,
    snapshot: MaterializationSourceSnapshot,
    calls: Rc<RefCell<Vec<Check>>>,
    refused: Rc<RefCell<BTreeSet<String>>>,
    actions: Vec<String>,
}
impl MaterializationSourceCapability for Source {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        panic!("batch must not recapture")
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("batch must not restore")
    }
    fn check_current(
        &mut self,
        binding: &str,
        revision: &str,
        authority: &str,
        at: f64,
        cutoff: Option<f64>,
        support: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        self.calls.borrow_mut().push(Check {
            binding: binding.into(),
            revision: revision.into(),
            authority: authority.into(),
            at,
            cutoff,
            support: support.to_vec(),
        });
        if support.iter().any(|id| self.refused.borrow().contains(id)) {
            return Err(MaterializationSourceFailure::Unauthorized);
        }
        if DeltaSet::from_deltas(self.rows.values().cloned())
            .unwrap()
            .digest()
            != DeltaSet::from_deltas(self.snapshot.deltas.clone())
                .unwrap()
                .digest()
            || binding != self.snapshot.binding
            || revision != self.snapshot.revision
            || authority != self.snapshot.authority
            || self.actions.iter().any(|s| s == "change-authority-before")
        {
            return Err(MaterializationSourceFailure::SourceChanged);
        }
        if self.calls.borrow().len() == 1 {
            if self
                .actions
                .iter()
                .any(|s| s == "remove-row-after-first-check")
            {
                let first = self.rows.keys().next().unwrap().clone();
                self.rows.remove(&first);
            }
            if self
                .actions
                .iter()
                .any(|s| s == "refuse-support-after-first-check")
            {
                self.refused.borrow_mut().insert(support[0].clone());
            }
        }
        Ok(())
    }
}
fn boot(v: &Value) -> MaterializationInputBoot {
    MaterializationInputBoot {
        configuration: parse_delta(&v["boot"]["configuration"]).unwrap(),
        declarations: v["boot"]["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| parse_delta(x).unwrap())
            .collect(),
        bindings: v["boot"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| parse_delta(x).unwrap())
            .collect(),
    }
}
fn context(v: &Value, b: &MaterializationInputBoot, q: &Delta) -> MaterializationResultContext {
    MaterializationResultContext {
        receiver: v["keys"]["receiver"].as_str().unwrap().into(),
        configuration: b.configuration.id.clone(),
        request: q.id.clone(),
        request_delta: Some(q.clone()),
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: None,
        snapshot: None,
        received_at: Some(1000.),
    }
}
fn endpoint<'a>(
    v: &Value,
    b: &MaterializationInputBoot,
    grants: BTreeMap<String, Box<dyn MaterializationSourceCapability + 'a>>,
) -> MaterializationEndpoint<'a> {
    MaterializationEndpoint::boot(
        b,
        Box::new(Signer {
            author: v["keys"]["receiver"].as_str().unwrap().into(),
            seed: v["seeds"]["receiver"].as_str().unwrap().into(),
        }),
        grants,
        Box::new(|e| panic!("unexpected fault: {e}")),
    )
    .unwrap()
}
fn source(f: &Value) -> Source {
    let snapshot = parse_delta(&f["snapshot"]).unwrap();
    Source {
        rows: f["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                let d = parse_delta(d).unwrap();
                (d.id.clone(), d)
            })
            .collect(),
        snapshot: decode_materialization_snapshot(
            &materialization_bytes(
                &read_materialization_description(&snapshot, None).unwrap(),
                "data",
            )
            .unwrap(),
            MaterializationSourceLimits::default(),
        )
        .unwrap(),
        calls: Rc::new(RefCell::new(Vec::new())),
        refused: Rc::new(RefCell::new(BTreeSet::new())),
        actions: Vec::new(),
    }
}
#[test]
fn shared_complete_commands() {
    let mut assertions = 0;
    macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
    macro_rules! checked {($($args:tt)*)=>{{assert!($($args)*);assertions+=1;}};}

    let v: Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/commands.json"
    ))
    .unwrap();
    let b = boot(&v);
    let limits = materialization_max_limits();
    for f in v["positives"].as_array().unwrap() {
        let before = assertions;
        let b = if f["boot"].is_object() {
            boot(&serde_json::json!({"boot":f["boot"].clone()}))
        } else {
            boot(&v)
        };
        let at = f["receivedAt"].as_f64().unwrap_or(1000.);
        let host = source(f);
        let calls = host.calls.clone();
        let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
        grants.insert(
            f["source"]["binding"].as_str().unwrap().into(),
            Box::new(host),
        );
        let mut e = endpoint(&v, &b, grants);
        let q = parse_delta(&f["request"]).unwrap();
        let delivery = f["delivery"].as_array().unwrap();
        checked_eq!(
            preflight_materialization_input(&b, &q.id, delivery, at).unwrap(),
            MaterializationInputPreflight::InputValid,
            "{}",
            f["id"]
        );
        let gathered = e.invoke(&q.id, delivery, at).unwrap();
        checked_eq!(
            gathered,
            parse_delta(&f["expected"]["gather"]).unwrap(),
            "{}",
            f["id"]
        );
        let mut c = context(&v, &b, &q);
        c.received_at = Some(at);
        c.capture = Some(parse_delta(&f["capture"]).unwrap());
        c.snapshot = Some(parse_delta(&f["snapshot"]).unwrap());
        let read = read_materialization_result(&gathered, &c, &limits).unwrap();
        checked_eq!(
            hex::encode(encode(&read.body)),
            f["expected"]["gatherBodyHex"].as_str().unwrap()
        );
        checked_eq!(
            read.classification,
            MaterializationResultClassification::VerifiedContext
        );
        checked_eq!(
            read.source_commitments,
            MaterializationSourceCommitments::CommitmentsVerified
        );
        checked!(!read.execution_verified && read.receiver_testimony);
        let calls = calls.borrow();
        checked_eq!(calls.len(), 2);
        checked_eq!(calls[0], calls[1]);
        checked_eq!(
            calls[0].support,
            f["source"]["requiredSupport"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        );
        checked_eq!(calls[0].at, at);
        checked_eq!(calls[0].cutoff, f["source"]["cutoff"].as_f64());
        let rq = parse_delta(&f["resolve"]).unwrap();
        let delivery = f["resolveDelivery"].as_array().unwrap();
        checked_eq!(
            preflight_materialization_input(&b, &rq.id, delivery, at).unwrap(),
            MaterializationInputPreflight::InputValid
        );
        let resolved = endpoint(&v, &b, BTreeMap::new())
            .invoke(&rq.id, delivery, at)
            .unwrap();
        checked_eq!(resolved, parse_delta(&f["expected"]["resolve"]).unwrap());
        let mut c = context(&v, &b, &rq);
        c.received_at = Some(at);
        c.evidence = Some(parse_delta(&delivery[1]).unwrap());
        let read = read_materialization_result(&resolved, &c, &limits).unwrap();
        checked_eq!(
            hex::encode(encode(&read.body)),
            f["expected"]["resolveBodyHex"].as_str().unwrap()
        );
        checked_eq!(
            read.classification,
            MaterializationResultClassification::VerifiedContext
        );
        checked!(!read.execution_verified);
        if f["id"] == "supplied_testimony" {
            checked!(
                hex::encode(
                    materialization_bytes(
                        &read_materialization_description(
                            &parse_delta(&f["resolveDelivery"][1]).unwrap(),
                            None
                        )
                        .unwrap(),
                        "result"
                    )
                    .unwrap()
                ) != f["expected"]["gatherBodyHex"].as_str().unwrap()
            );
        }
        assertion_evidence::record(
            "commands",
            include_bytes!("../../../vectors/materialization/commands.json"),
            "positives",
            f,
            assertions - before,
        );
    }
    for f in v["negatives"].as_array().unwrap() {
        let before = assertions;
        let b = if f["boot"].is_object() {
            boot(&serde_json::json!({"boot":f["boot"].clone()}))
        } else {
            boot(&v)
        };
        let base = v["positives"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == f["fixtureSourceId"].as_str().unwrap_or("plant"))
            .unwrap();
        let mut host = source(if f["nativeSource"].is_object() {
            &f["nativeSource"]
        } else {
            base
        });
        host.actions = f["actions"]
            .as_array()
            .map(|xs| xs.iter().map(|x| x.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        let actions = host.actions.clone();
        let refused = host.refused.clone();
        if actions.iter().any(|s| s == "refuse-support-before") {
            refused
                .borrow_mut()
                .insert(f["source"]["requiredSupport"][0].as_str().unwrap().into());
        }
        if actions
            .iter()
            .any(|s| s == "remove-row-before" || s == "replace-row-before")
        {
            let first = host.rows.keys().next().unwrap().clone();
            host.rows.remove(&first);
        }
        if actions.iter().any(|s| s == "replace-row-before") {
            let replacement = v["positives"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == "negated")
                .unwrap()["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| {
                    !v["positives"][0]["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["id"] == d["id"])
                })
                .unwrap();
            let d = parse_delta(replacement).unwrap();
            host.rows.insert(d.id.clone(), d);
        }
        let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
        if !actions.iter().any(|s| s == "absent-grant") {
            grants.insert(
                f["source"]["binding"].as_str().unwrap().into(),
                Box::new(host),
            );
        }
        let q = parse_delta(&f["request"]).unwrap();
        let delivery = f["delivery"].as_array().unwrap();
        let at = f["receivedAt"].as_f64().unwrap_or(1000.);
        let mut e = endpoint(&v, &b, grants);
        if f["first"].is_object() {
            checked_eq!(
                e.invoke(&q.id, delivery, f["first"]["receivedAt"].as_f64().unwrap())
                    .unwrap(),
                parse_delta(&f["first"]["outcome"]).unwrap()
            );
        }
        if actions.iter().any(|s| s == "success-then-revoke") {
            let first = e.invoke(&q.id, delivery, at).unwrap();
            checked_eq!(
                first,
                parse_delta(&v["positives"][0]["expected"]["gather"]).unwrap()
            );
            refused
                .borrow_mut()
                .insert(f["source"]["requiredSupport"][0].as_str().unwrap().into());
        }
        let actual = e.invoke(&q.id, delivery, at).unwrap();
        checked_eq!(
            actual,
            parse_delta(&f["expected"]["outcome"]).unwrap(),
            "{}",
            f["id"]
        );
        let code = f["expected"]["preflight"]
            .as_str()
            .unwrap_or(f["expected"]["code"].as_str().unwrap());
        let expected = match code {
            "input-valid" => MaterializationInputPreflight::InputValid,
            "resource-limit" => MaterializationInputPreflight::OverInputLimit,
            _ => MaterializationInputPreflight::InvalidInput { code: code.into() },
        };
        checked_eq!(
            preflight_materialization_input(&b, &q.id, delivery, at).unwrap(),
            expected,
            "{}",
            f["id"]
        );
        assertion_evidence::record(
            "commands",
            include_bytes!("../../../vectors/materialization/commands.json"),
            "negatives",
            f,
            assertions - before,
        );
    }
    for f in v["resultRejections"].as_array().unwrap() {
        let before = assertions;
        let base = v["positives"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == f["fixture"])
            .unwrap();
        let q = parse_delta(if f["kind"] == "gather" {
            &base["request"]
        } else {
            &base["resolve"]
        })
        .unwrap();
        let mut c = context(&v, &b, &q);
        if f["kind"] == "resolve" {
            c.evidence = Some(parse_delta(&base["resolveDelivery"][1]).unwrap());
        }
        if let Some(s) = f["context"]["receiver"].as_str() {
            c.receiver = s.into();
        }
        if let Some(s) = f["context"]["configuration"].as_str() {
            c.configuration = s.into();
        }
        if let Some(s) = f["context"]["request"].as_str() {
            c.request = s.into();
        }
        if let Some(s) = f["context"]["revision"].as_str() {
            c.revision = Some(s.into());
        }
        checked!(
            read_materialization_result(&parse_delta(&f["outcome"]).unwrap(), &c, &limits).is_err(),
            "{}",
            f["id"]
        );
        assertion_evidence::record(
            "commands",
            include_bytes!("../../../vectors/materialization/commands.json"),
            "resultRejections",
            f,
            assertions - before,
        );
    }
    let f = v["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == "private_provenance")
        .unwrap();
    let q = parse_delta(&f["request"]).unwrap();
    let mut c = context(&v, &b, &q);
    let o = parse_delta(&f["expected"]["gather"]).unwrap();
    let read = read_materialization_result(&o, &c, &limits).unwrap();
    checked_eq!(
        read.source_commitments,
        MaterializationSourceCommitments::Attested
    );
    let bytes = encode(&read.body);
    for s in [
        v["sentinel"].as_str().unwrap(),
        "rawIds",
        "operandIds",
        "exclusions",
    ] {
        checked!(!bytes.windows(s.len()).any(|x| x == s.as_bytes()));
    }
    c.capture = Some(parse_delta(&f["capture"]).unwrap());
    c.snapshot = Some(parse_delta(&f["snapshot"]).unwrap());
    checked_eq!(
        read_materialization_result(&o, &c, &limits)
            .unwrap()
            .source_commitments,
        MaterializationSourceCommitments::CommitmentsVerified
    );
    let q = parse_delta(&v["positives"][0]["request"]).unwrap();
    checked!(endpoint(&v, &b, BTreeMap::new())
        .invoke(
            &q.id,
            v["positives"][0]["delivery"].as_array().unwrap(),
            f64::INFINITY
        )
        .is_err());
    println!("materialization-native:cmd_input_snapshot::batch");
    println!("materialization-native:cmd_public_basis_privacy::batch");
    let _ = assertions;
}
