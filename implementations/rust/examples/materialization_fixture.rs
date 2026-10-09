//! Fresh-process test host. Only serialized signed descriptions cross stage boundaries.
use rhizomatic::{
    cbor::encode,
    json_profile::{claims_to_json, parse_delta},
    materialization_data::{
        materialization_bytes, materialization_entity, materialization_role, MaterializationFields,
        MaterializationVerb,
    },
    materialization_description_claims, materialization_max_limits,
    materialization_peer::{
        MaterializationControlInitialize, MaterializationControlRead, MaterializationControlStore,
        MaterializationControlWrite,
    },
    preflight_materialization_input, read_materialization_description, read_materialization_result,
    set::DeltaSet,
    sign::{author_for_seed, sign_claims},
    types::{Claims, Delta, DeltaRef, EntityRef, Primitive, Target},
    MaterializationCapture, MaterializationEndpoint, MaterializationInputBoot,
    MaterializationInputPreflight, MaterializationLifecycleHooks,
    MaterializationResultClassification, MaterializationResultContext, MaterializationSigner,
    MaterializationSourceCapability, MaterializationSourceCommitments,
    MaterializationSourceFailure,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::PathBuf,
    rc::Rc,
    time::Instant,
};
struct Signer {
    author: String,
    seed: String,
    /// The post-CAS signer fault: the outcome signature fails after the transition signed.
    fail_outcome: bool,
}
impl MaterializationSigner for Signer {
    fn author(&self) -> &str {
        &self.author
    }
    fn sign(&self, c: &Claims) -> Result<Delta, String> {
        let outcome = c.pointers.iter().any(|p| {
            p.role == materialization_role("kind")
                && matches!(&p.target, Target::Primitive(Primitive::Str(s)) if s == "outcome/1")
        });
        if self.fail_outcome && outcome {
            return Err("fixture-signer-fault".into());
        }
        sign_claims(c, &self.seed)
    }
}
// ---- M3 durable host: one JSON document per (receiver, configuration), replaced whole by rename.
// The store never decodes an image; it keeps the revision the endpoint named beside the bytes.
// The layout equals the TypeScript host's so either witness can read a directory the other wrote.
fn component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
struct FileControlStore {
    dir: PathBuf,
    fault: Option<String>,
    /// The image another writer lands between this host's read and its CAS (`race`).
    raced: Option<(String, Vec<u8>)>,
}
impl FileControlStore {
    fn path(&self, receiver: &str, configuration: &str) -> PathBuf {
        self.dir
            .join(component(receiver))
            .join(format!("{}.json", component(configuration)))
    }
    fn load(&self, receiver: &str, configuration: &str) -> Option<(String, Vec<u8>)> {
        let text = fs::read_to_string(self.path(receiver, configuration)).ok()?;
        let doc: Value = serde_json::from_str(&text).ok()?;
        Some((
            doc["revision"].as_str()?.to_string(),
            hex::decode(doc["imageHex"].as_str()?).ok()?,
        ))
    }
    fn save(&self, receiver: &str, configuration: &str, revision: &str, bytes: &[u8]) {
        let path = self.path(receiver, configuration);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tmp = path.with_extension("json.tmp");
        fs::write(
            &tmp,
            json!({"revision":revision,"imageHex":hex::encode(bytes)}).to_string(),
        )
        .unwrap();
        fs::rename(tmp, path).unwrap();
    }
    fn state(&self, receiver: &str, configuration: &str) -> Value {
        match self.load(receiver, configuration) {
            Some((revision, bytes)) => json!({"revision":revision,"bytesHex":hex::encode(bytes)}),
            None => json!({"revision":null,"bytesHex":null}),
        }
    }
}
impl MaterializationControlStore for FileControlStore {
    fn initialize(
        &mut self,
        receiver: &str,
        configuration: &str,
        empty: &[u8],
    ) -> Result<MaterializationControlInitialize, String> {
        if let Some((revision, bytes)) = self.load(receiver, configuration) {
            return Ok(MaterializationControlInitialize::Existing { bytes, revision });
        }
        self.save(receiver, configuration, "", empty);
        Ok(MaterializationControlInitialize::Initialized {
            bytes: empty.to_vec(),
        })
    }
    fn read(
        &mut self,
        receiver: &str,
        configuration: &str,
    ) -> Result<MaterializationControlRead, String> {
        Ok(match self.load(receiver, configuration) {
            Some((revision, bytes)) => MaterializationControlRead::Image { bytes, revision },
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
        if let (Some("race"), Some((revision, bytes))) = (self.fault.as_deref(), &self.raced) {
            self.save(receiver, configuration, revision, bytes);
        }
        if self
            .load(receiver, configuration)
            .map(|(r, _)| r)
            .as_deref()
            != Some(expected)
        {
            return Ok(MaterializationControlWrite::Conflict);
        }
        let fault = self.fault.as_deref();
        if fault == Some("rejected") {
            return Ok(MaterializationControlWrite::Rejected {
                reason: "fixture-rejected".into(),
            });
        }
        if fault == Some("unconfirmed-absent") {
            return Ok(MaterializationControlWrite::CommittedUnconfirmed {
                fault: "fixture-unconfirmed".into(),
            });
        }
        if fault == Some("crash-before-cas") {
            std::process::exit(3);
        }
        self.save(receiver, configuration, revision, bytes);
        if fault == Some("crash-after-cas") {
            std::process::exit(3);
        }
        if fault == Some("unconfirmed-present") {
            return Ok(MaterializationControlWrite::CommittedUnconfirmed {
                fault: "fixture-unconfirmed".into(),
            });
        }
        Ok(MaterializationControlWrite::Durable {
            revision: revision.into(),
        })
    }
}
/// One fresh release-B host over a durable directory, with its inspector and call log.
struct LifecycleHost<'a> {
    endpoint: MaterializationEndpoint<'a>,
    inspector: FileControlStore,
    calls: Rc<RefCell<Vec<Value>>>,
    diagnostics: Rc<RefCell<Vec<String>>>,
}
/// The schedule grant: current exactly for the fixture's binding, revision and authority.
struct LifecycleGrant {
    source: Value,
    calls: Rc<RefCell<Vec<Value>>>,
}
impl MaterializationSourceCapability for LifecycleGrant {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        panic!("the fixture source never recaptures")
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        panic!("the fixture source never restores a snapshot")
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
        if b == self.source["binding"]
            && r == self.source["revision"]
            && u == self.source["authority"]
        {
            Ok(())
        } else {
            Err(MaterializationSourceFailure::SourceChanged)
        }
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
            fail_outcome: false,
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
    let step = &v["step"];
    let fault = v["fault"]["kind"].as_str().map(String::from);
    let raced = v["fault"]["image"]["hex"].as_str().map(|h| {
        (
            v["fault"]["image"]["revision"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            hex::decode(h).unwrap(),
        )
    });
    let store_dir = || PathBuf::from(v["store"]["dir"].as_str().unwrap_or("."));
    // A release-B host over the durable directory; faults name one MR-18 point each.
    let lifecycle = |dir: PathBuf, fault: Option<String>| -> Result<LifecycleHost<'_>, String> {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let diagnostics = Rc::new(RefCell::new(Vec::new()));
        let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
        if f["noGrant"] != true {
            grants.insert(
                f["source"]["binding"]
                    .as_str()
                    .ok_or("source binding")?
                    .into(),
                Box::new(LifecycleGrant {
                    source: f["source"].clone(),
                    calls: calls.clone(),
                }),
            );
        }
        let inspector = FileControlStore {
            dir: dir.clone(),
            fault: None,
            raced: None,
        };
        let diag = diagnostics.clone();
        let endpoint = MaterializationEndpoint::boot_maintained(
            &b,
            Box::new(Signer {
                author: receiver.clone(),
                seed: f["seeds"]["receiver"].as_str().unwrap().into(),
                fail_outcome: fault.as_deref() == Some("sign-failure"),
            }),
            grants,
            Box::new(move |e: &str| diag.borrow_mut().push(e.to_string())),
            Box::new(FileControlStore {
                dir,
                fault: fault.clone(),
                raced: raced.clone(),
            }),
            MaterializationLifecycleHooks {
                post_cas_result_materialization: if fault.as_deref() == Some("post-cas-result") {
                    Some(Box::new(|_: &str| Err("fixture-result-fault".to_string())))
                } else {
                    None
                },
            },
        )?;
        Ok(LifecycleHost {
            endpoint,
            inspector,
            calls,
            diagnostics,
        })
    };
    let step_delivery = || -> Result<Vec<Value>, String> {
        Ok(step["delivery"].as_array().ok_or("step delivery")?.clone())
    };
    match v["mode"].as_str().ok_or("mode")? {
        "control-execute" | "control-read" => {
            let LifecycleHost {
                mut endpoint,
                inspector,
                calls,
                diagnostics,
            } = lifecycle(store_dir(), fault)?;
            if v["seed"] == true && !step["initialControl"].is_null() {
                inspector.save(
                    &receiver,
                    &b.configuration.id,
                    step["initialControl"]["revision"]
                        .as_str()
                        .ok_or("revision")?,
                    &hex::decode(step["initialControl"]["hex"].as_str().ok_or("hex")?)
                        .map_err(|e| e.to_string())?,
                );
            }
            let (request, delivery) = if up.is_null() {
                (step["request"].clone(), step_delivery()?)
            } else {
                (
                    up["request"].clone(),
                    up["delivery"].as_array().ok_or("delivery")?.clone(),
                )
            };
            let q = parse_delta(&request)?;
            let outcome = endpoint.invoke(&q.id, &delivery, at)?;
            Ok(json!({
                "request": request,
                "delivery": delivery,
                "outcome": serial(&outcome),
                "preflight": preflight(&b, &q, &delivery, at),
                "calls": *calls.borrow(),
                "diagnostics": *diagnostics.borrow(),
                "store": inspector.state(&receiver, &b.configuration.id),
            }))
        }
        "control-export" => Ok(FileControlStore {
            dir: store_dir(),
            fault: None,
            raced: None,
        }
        .state(&receiver, &b.configuration.id)),
        "control-restore" => {
            let LifecycleHost {
                mut endpoint,
                inspector,
                ..
            } = lifecycle(store_dir(), None)?;
            inspector.save(
                &receiver,
                &b.configuration.id,
                up["revision"].as_str().ok_or("revision")?,
                &hex::decode(up["bytesHex"].as_str().ok_or("bytesHex")?)
                    .map_err(|e| e.to_string())?,
            );
            let q = parse_delta(&step["request"])?;
            let delivery = step_delivery()?;
            let outcome = endpoint.invoke(&q.id, &delivery, at)?;
            Ok(json!({
                "request": step["request"],
                "outcome": serial(&outcome),
                "preflight": preflight(&b, &q, &delivery, at),
                "store": inspector.state(&receiver, &b.configuration.id),
            }))
        }
        "control-result" => {
            let q = parse_delta(&up["request"])?;
            let mut c = context(&q);
            c.control = Some(
                hex::decode(v["control"]["bytesHex"].as_str().ok_or("control")?)
                    .map_err(|e| e.to_string())?,
            );
            if !v["capture"].is_null() && !v["snapshot"].is_null() {
                c.capture = Some(parse_delta(&v["capture"])?);
                c.snapshot = Some(parse_delta(&v["snapshot"])?);
            }
            let read = read_materialization_result(
                &parse_delta(&up["outcome"])?,
                &c,
                &materialization_max_limits(),
            )?;
            Ok(
                json!({"status":read.status,"classification":match read.classification {MaterializationResultClassification::VerifiedContext=>"verified-context",_=>"verified-structure"},"sourceCommitments":match read.source_commitments {MaterializationSourceCommitments::Attested=>"attested",_=>"commitments-verified"},"receiverTestimony":read.receiver_testimony,"executionVerified":read.execution_verified,"bodyHex":hex::encode(encode(&read.body))}),
            )
        }
        "construct" if !step.is_null() => {
            // Re-sign the step's request from its decoded fields: only serialized descriptions cross.
            let q = parse_delta(&step["request"])?;
            let verb = MaterializationVerb::parse(step["verb"].as_str().ok_or("verb")?)
                .ok_or("unknown verb")?;
            let mut fs = read_materialization_description(&q, Some(verb))?;
            fs.remove("kind");
            let out = sign_claims(
                &materialization_description_claims(&caller, q.claims.timestamp, "request/1", &fs)?,
                seed,
            )?;
            let delivery: Vec<Value> = step_delivery()?
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
