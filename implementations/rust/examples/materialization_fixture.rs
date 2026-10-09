//! Fresh-process test host. Only serialized signed descriptions cross stage boundaries.
use rhizomatic::{
    cbor::encode,
    json_profile::{claims_to_json, parse_delta},
    materialization_data::{materialization_bytes, materialization_entity, MaterializationFields},
    materialization_description_claims, materialization_max_limits,
    preflight_materialization_input, read_materialization_description, read_materialization_result,
    set::DeltaSet,
    sign::{author_for_seed, sign_claims},
    types::{Claims, Delta, DeltaRef, EntityRef, Target},
    MaterializationCapture, MaterializationEndpoint, MaterializationInputBoot,
    MaterializationInputPreflight, MaterializationResultClassification,
    MaterializationResultContext, MaterializationSigner, MaterializationSourceCapability,
    MaterializationSourceCommitments, MaterializationSourceFailure,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Read},
    rc::Rc,
    time::Instant,
};
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
    rows: DeltaSet,
    basis: Value,
    initial_membership: String,
    calls: Rc<RefCell<Vec<Value>>>,
}
impl MaterializationSourceCapability for Source {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        panic!("batch cannot recapture")
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("batch cannot restore")
    }
    fn check_current(
        &mut self,
        b: &str,
        r: &str,
        u: &str,
        at: f64,
        cutoff: Option<f64>,
        support: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        let mut call = json!({"binding":b,"revision":r,"authority":u,"at":at,"support":support});
        if let Some(t) = cutoff {
            call["cutoff"] = json!(t);
        }
        self.calls.borrow_mut().push(call);
        if b != self.basis["binding"].as_str().unwrap()
            || r != self.basis["revision"].as_str().unwrap()
            || u != self.basis["authority"].as_str().unwrap()
            || self.rows.digest() != self.initial_membership
        {
            return Err(MaterializationSourceFailure::SourceChanged);
        }
        Ok(())
    }
}
fn serial(d: &Delta) -> Value {
    let mut v = json!({"id":d.id,"claims":claims_to_json(&d.claims)});
    if let Some(sig) = &d.sig {
        v["sig"] = json!(sig);
    }
    v
}
fn reference(id: &str) -> Target {
    Target::Delta(DeltaRef {
        delta: id.into(),
        context: None,
    })
}
fn preflight(b: &MaterializationInputBoot, q: &Delta, delivery: &[Value], at: f64) -> Value {
    match preflight_materialization_input(b, &q.id, delivery, at).unwrap() {
        MaterializationInputPreflight::InputValid => json!({"status":"input-valid"}),
        MaterializationInputPreflight::OverInputLimit => {
            json!({"status":"over-input-limit","code":"resource-limit"})
        }
        MaterializationInputPreflight::InvalidInput { code } => {
            json!({"status":"invalid-input","code":code})
        }
    }
}
fn run(v: &Value) -> Result<Value, String> {
    let f = &v["fixture"];
    let up = &v["upstream"];
    let b = MaterializationInputBoot {
        configuration: parse_delta(&f["boot"]["configuration"])?,
        declarations: f["boot"]["declarations"]
            .as_array()
            .ok_or("declarations")?
            .iter()
            .map(parse_delta)
            .collect::<Result<_, _>>()?,
        bindings: f["boot"]["bindings"]
            .as_array()
            .ok_or("bindings")?
            .iter()
            .map(parse_delta)
            .collect::<Result<_, _>>()?,
    };
    let at = f["receivedAt"].as_f64().unwrap_or(1000.);
    let receiver = author_for_seed(f["seeds"]["receiver"].as_str().ok_or("seed")?)?;
    let seed = f["seeds"]["caller"].as_str().ok_or("seed")?;
    let caller = author_for_seed(seed)?;
    let describe = |kind: &str, fs: &MaterializationFields| {
        sign_claims(
            &materialization_description_claims(&caller, at, kind, fs)?,
            seed,
        )
    };
    let signer = || {
        Box::new(Signer {
            author: receiver.clone(),
            seed: f["seeds"]["receiver"].as_str().unwrap().into(),
        }) as Box<dyn MaterializationSigner>
    };
    let context = |q: &Delta| MaterializationResultContext {
        receiver: receiver.clone(),
        configuration: b.configuration.id.clone(),
        request: q.id.clone(),
        request_delta: Some(q.clone()),
        received_at: Some(at),
        control: None,
        evidence: None,
        binding: None,
        revision: None,
        authority: None,
        capture: None,
        snapshot: None,
    };
    match v["mode"].as_str().ok_or("mode")? {
        "construct" => {
            let q = parse_delta(&f["request"])?;
            let mut fs = read_materialization_description(
                &q,
                Some(rhizomatic::MaterializationVerb::Gather),
            )?;
            fs.remove("kind");
            let out = sign_claims(
                &materialization_description_claims(&caller, q.claims.timestamp, "request/1", &fs)?,
                seed,
            )?;
            let delivery: Vec<Value> = f["delivery"]
                .as_array()
                .ok_or("delivery")?
                .iter()
                .map(|d| {
                    if d["id"] == q.id {
                        serial(&out)
                    } else {
                        d.clone()
                    }
                })
                .collect();
            Ok(json!({"request":serial(&out),"delivery":delivery}))
        }
        "gather" => {
            let preparing = Instant::now();
            let q = parse_delta(&up["request"])?;
            // Opaque artifact: independent raw fixture basis, never an expected response.
            let rows = DeltaSet::from_deltas(
                f["rows"]
                    .as_array()
                    .ok_or("rows")?
                    .iter()
                    .map(parse_delta)
                    .collect::<Result<Vec<_>, _>>()?,
            )?;
            let initial_membership = rows.digest();
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
            grants.insert(
                f["source"]["binding"]
                    .as_str()
                    .ok_or("source binding")?
                    .into(),
                Box::new(Source {
                    rows,
                    basis: f["source"].clone(),
                    initial_membership,
                    calls: calls.clone(),
                }),
            );
            let mut endpoint = MaterializationEndpoint::boot(
                &b,
                signer(),
                grants,
                Box::new(|e| panic!("unexpected fault {e}")),
            )?;
            let delivery = up["delivery"].as_array().ok_or("delivery")?;
            let preparation_ms = preparing.elapsed().as_secs_f64() * 1000.;
            let started = Instant::now();
            let outcome = endpoint.invoke(&q.id, delivery, at)?;
            let endpoint_ms = started.elapsed().as_secs_f64() * 1000.;
            let mut result = json!({"request":up["request"],"outcome":serial(&outcome),"calls":*calls.borrow(),"preflight":preflight(&b,&q,delivery,at)});
            if v["measureEndpoint"] == true {
                result["measurements"] =
                    json!({"sourceAndBootPreparationMs":preparation_ms,"endpointMs":endpoint_ms});
            }
            Ok(result)
        }
        "wrap-evidence" => {
            let out = parse_delta(&up["outcome"])?;
            let gq = parse_delta(&up["request"])?;
            if read_materialization_result(&out, &context(&gq), &materialization_max_limits())?
                .status
                != "completed"
            {
                return Err("gather refused".into());
            }
            let payload =
                materialization_bytes(&read_materialization_description(&out, None)?, "result")?;
            let evidence = describe(
                "evidence/1",
                &BTreeMap::from([(
                    "result".into(),
                    vec![Target::Bytes {
                        mime: "application/cbor".into(),
                        value: payload,
                    }],
                )]),
            )?;
            let operation = b
                .declarations
                .iter()
                .find(|d| {
                    materialization_entity(
                        &read_materialization_description(d, None).unwrap(),
                        "name",
                    )
                    .unwrap()
                        == "rhizomatic.materialization.resolve"
                })
                .ok_or("operation")?;
            let q = describe(
                "request/1",
                &BTreeMap::from([
                    (
                        "receiver".into(),
                        vec![Target::Entity(EntityRef {
                            id: receiver.clone(),
                            context: None,
                        })],
                    ),
                    ("configuration".into(), vec![reference(&b.configuration.id)]),
                    ("operation".into(), vec![reference(&operation.id)]),
                    ("evidence".into(), vec![reference(&evidence.id)]),
                ]),
            )?;
            Ok(
                json!({"request":serial(&q),"evidence":serial(&evidence),"delivery":[serial(&q),serial(&evidence)],"gather":up}),
            )
        }
        "resolve" => {
            let q = parse_delta(&up["request"])?;
            let delivery = up["delivery"].as_array().ok_or("delivery")?;
            let mut endpoint = MaterializationEndpoint::boot(
                &b,
                signer(),
                BTreeMap::new(),
                Box::new(|e| panic!("unexpected fault {e}")),
            )?;
            let outcome = endpoint.invoke(&q.id, delivery, at)?;
            let mut out = up.clone();
            out["outcome"] = serial(&outcome);
            out["preflight"] = preflight(&b, &q, delivery, at);
            Ok(out)
        }
        "read-result" => {
            let q = parse_delta(&up["request"])?;
            let mut c = context(&q);
            if !up["evidence"].is_null() {
                c.evidence = Some(parse_delta(&up["evidence"])?);
            }
            c.capture = Some(parse_delta(&f["capture"])?);
            c.snapshot = Some(parse_delta(&f["snapshot"])?);
            let read = read_materialization_result(
                &parse_delta(&up["outcome"])?,
                &c,
                &materialization_max_limits(),
            )?;
            Ok(
                json!({"status":read.status,"classification":match read.classification {MaterializationResultClassification::VerifiedContext=>"verified-context",_=>"verified-structure"},"sourceCommitments":match read.source_commitments {MaterializationSourceCommitments::Attested=>"attested",_=>"commitments-verified"},"receiverTestimony":read.receiver_testimony,"executionVerified":read.execution_verified,"bodyHex":hex::encode(encode(&read.body))}),
            )
        }
        _ => Err("unknown fixture mode".into()),
    }
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let v: Value = serde_json::from_str(&input).unwrap();
    match run(&v) {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
