//! Scoped batch gather (SPEC-16 §4a): each shared delivery, replayed into a fresh Rust endpoint,
//! must yield the exact outcome the corpus records, and pass the scope to the current check.
//! Mirrors ../ts/test/materialization-scoped-commands.test.ts.
use rhizomatic::{
    json_profile::parse_delta,
    materialization_command::*,
    materialization_input::MaterializationInputBoot,
    materialization_source::*,
    sign::sign_claims,
    types::{Claims, Delta},
};
use serde_json::Value;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

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
struct Source {
    revision: String,
    checks: Rc<RefCell<Vec<Option<Vec<String>>>>>,
}
impl MaterializationSourceCapability for Source {
    fn capture(
        &mut self,
        _: &str,
        _: f64,
        _: Option<f64>,
    ) -> Result<MaterializationCapture, MaterializationSourceFailure> {
        Err(MaterializationSourceFailure::SourceUnavailable)
    }
    fn reacquire_snapshot(
        &mut self,
        _: &str,
        _: &Delta,
        _: f64,
    ) -> Result<Vec<u8>, MaterializationSourceFailure> {
        Err(MaterializationSourceFailure::SourceUnavailable)
    }
    fn check_current(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: f64,
        _: Option<f64>,
        _: &[String],
    ) -> Result<(), MaterializationSourceFailure> {
        panic!("a batch gather asks the scoped current check")
    }
    fn check_current_scoped(
        &mut self,
        _: &str,
        revision: &str,
        _: &str,
        _: f64,
        _: Option<f64>,
        _: &[String],
        scope: Option<&[String]>,
    ) -> Result<(), MaterializationSourceFailure> {
        self.checks.borrow_mut().push(scope.map(<[String]>::to_vec));
        if revision == self.revision {
            Ok(())
        } else {
            Err(MaterializationSourceFailure::SourceChanged)
        }
    }
}

#[test]
fn shared_scoped_commands() {
    let v: Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/scoped-commands.json"
    ))
    .unwrap();
    let deltas = |x: &Value| -> Vec<Delta> {
        x.as_array()
            .unwrap()
            .iter()
            .map(|d| parse_delta(d).unwrap())
            .collect()
    };
    let boot = MaterializationInputBoot {
        configuration: parse_delta(&v["boot"]["configuration"]).unwrap(),
        declarations: deltas(&v["boot"]["declarations"]),
        bindings: deltas(&v["boot"]["bindings"]),
    };
    for c in v["cases"].as_array().unwrap() {
        let id = c["id"].as_str().unwrap();
        let checks = Rc::new(RefCell::new(Vec::new()));
        let mut grants = BTreeMap::<String, Box<dyn MaterializationSourceCapability>>::new();
        for b in &boot.bindings {
            grants.insert(
                b.id.clone(),
                Box::new(Source {
                    revision: c["revision"].as_str().unwrap().into(),
                    checks: checks.clone(),
                }),
            );
        }
        let mut endpoint = MaterializationEndpoint::boot(
            &boot,
            Box::new(Signer {
                author: v["keys"]["receiver"].as_str().unwrap().into(),
                seed: v["seeds"]["receiver"].as_str().unwrap().into(),
            }),
            grants,
            Box::new(|e| panic!("unexpected fault: {e}")),
        )
        .unwrap();
        let request = parse_delta(&c["request"]).unwrap();
        let outcome = endpoint
            .invoke(&request.id, c["delivery"].as_array().unwrap(), 1000.)
            .unwrap();
        assert_eq!(
            outcome,
            parse_delta(&c["expected"]["outcome"]).unwrap(),
            "{id}"
        );
        let expected_checks: Vec<Option<Vec<String>>> =
            serde_json::from_value(c["expected"]["checks"].clone()).unwrap();
        assert_eq!(*checks.borrow(), expected_checks, "{id}");
    }
}
