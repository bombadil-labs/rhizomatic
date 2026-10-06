// Compiled only in the disposable instrumented source copy by the narrow allocation probe.
use rhizomatic::{
    json_profile::parse_delta,
    materialization_command::{
        preflight_materialization_input, MaterializationEndpoint, MaterializationInputPreflight,
        MaterializationSigner,
    },
    materialization_input::MaterializationInputBoot,
    sign::sign_claims,
    types::{Claims, Delta},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
fn main() {
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(std::env::args().nth(1).unwrap()).unwrap()).unwrap();
    let mut records = Vec::new();
    for f in corpus["negatives"].as_array().unwrap().iter().filter(|f| {
        f["id"]
            .as_str()
            .unwrap()
            .starts_with("delivery_scan_oversized")
    }) {
        let b = &f["boot"];
        let boot = MaterializationInputBoot {
            configuration: parse_delta(&b["configuration"]).unwrap(),
            declarations: b["declarations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| parse_delta(v).unwrap())
                .collect(),
            bindings: b["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| parse_delta(v).unwrap())
                .collect(),
        };
        let q = parse_delta(&f["request"]).unwrap();
        let expected = parse_delta(&f["expected"]["outcome"]).unwrap();
        let ds = f["delivery"].as_array().unwrap();
        let mut endpoint = MaterializationEndpoint::boot(
            &boot,
            Box::new(Signer {
                author: corpus["keys"]["receiver"].as_str().unwrap().into(),
                seed: corpus["seeds"]["receiver"].as_str().unwrap().into(),
            }),
            BTreeMap::new(),
            Box::new(|_| {}),
        )
        .unwrap();
        for route in ["preflight", "invoke"] {
            rhizomatic::b64u::allocation_probe_reset();
            rhizomatic::delta::allocation_probe_reset();
            if route == "preflight" {
                let result = preflight_materialization_input(&boot, &q.id, ds, 1000.).unwrap();
                if f["expected"]["code"] == "resource-limit" {
                    assert_eq!(result, MaterializationInputPreflight::OverInputLimit);
                } else {
                    assert_eq!(
                        result,
                        MaterializationInputPreflight::InvalidInput {
                            code: "invalid-appearance".into()
                        }
                    );
                }
            } else {
                let d = endpoint.invoke(&q.id, ds, 1000.).unwrap();
                assert_eq!(d, expected);
            }
            let decoded = rhizomatic::b64u::allocation_probe_count();
            let canonical = rhizomatic::delta::allocation_probe_count();
            assert_eq!(decoded, 0, "offered decoder entered");
            assert_eq!(canonical, 0, "offered carrier canonical buffer entered");
            records.push(json!({"id":f["id"],"route":route,"decoderEntries":decoded,"carrierCanonicalBufferEntries":canonical}));
        }
    }
    assert_eq!(records.len(), 6);
    println!("{}", json!({"records":records}));
}
