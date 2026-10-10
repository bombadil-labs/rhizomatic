#[path = "support/materialization_assertions.rs"]
mod assertion_evidence;
use rhizomatic::materialization_data::{
    materialization_description_claims, read_materialization_description, MaterializationVerb,
};
use rhizomatic::{
    delta::{canonical_bytes, compute_id},
    json_profile::parse_claims,
    types::{Delta, EntityRef, Primitive, Target},
};
#[test]
fn shared_description_oracle() {
    let mut assertions = 0;
    macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
    macro_rules! checked {($($args:tt)*)=>{{assert!($($args)*);assertions+=1;}};}

    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/command-descriptions.json"
    ))
    .unwrap();
    for f in vectors["positives"].as_array().unwrap() {
        let before = assertions;
        let claims = parse_claims(&f["claims"]).unwrap();
        checked_eq!(
            hex::encode(canonical_bytes(&claims).unwrap()),
            f["expectedClaimsHex"].as_str().unwrap()
        );
        let d = Delta {
            id: compute_id(&claims).unwrap(),
            claims: claims.clone(),
            sig: None,
        };
        let verb = f["verb"].as_str().and_then(MaterializationVerb::parse);
        let fs = read_materialization_description(&d, verb)
            .unwrap_or_else(|e| panic!("{}: {e}", f["id"]));
        let written = materialization_description_claims(
            &claims.author,
            1000.0,
            f["kind"].as_str().unwrap(),
            &fs,
        )
        .unwrap();
        checked_eq!(
            hex::encode(canonical_bytes(&written).unwrap()),
            f["expectedClaimsHex"].as_str().unwrap()
        );
        let mut permuted = d.clone();
        permuted.claims.pointers.reverse();
        checked_eq!(
            read_materialization_description(&permuted, verb).unwrap(),
            fs
        );
        assertion_evidence::record(
            "command-descriptions",
            include_bytes!("../../../vectors/materialization/command-descriptions.json"),
            "positives",
            f,
            assertions - before,
        );
    }
    for n in vectors["negatives"].as_array().unwrap() {
        let before = assertions;
        let f = vectors["positives"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == n["base"])
            .unwrap();
        let mut claims = parse_claims(&f["claims"]).unwrap();
        let verb = f["verb"].as_str().and_then(MaterializationVerb::parse);
        match n["mutation"].as_str().unwrap() {
            "extra-role" => claims.pointers.push(rhizomatic::types::Pointer {
                role: "rhizomatic.materialization.extra".into(),
                target: Target::Primitive(Primitive::Bool(true)),
            }),
            "duplicate-receiver" => claims.pointers.push(
                claims
                    .pointers
                    .iter()
                    .find(|p| p.role.ends_with("receiver"))
                    .unwrap()
                    .clone(),
            ),
            "reference-context" => {
                let p = claims
                    .pointers
                    .iter_mut()
                    .find(|p| p.role.ends_with("evidence"))
                    .unwrap();
                if let Target::Delta(r) = &mut p.target {
                    r.context = Some("secret".into());
                }
            }
            "unknown-name" => {
                claims
                    .pointers
                    .iter_mut()
                    .find(|p| p.role.ends_with("name"))
                    .unwrap()
                    .target = Target::Entity(EntityRef {
                    id: "rhizomatic.materialization.install".into(),
                    context: None,
                });
            }
            "wrong-mime" => {
                let p = claims
                    .pointers
                    .iter_mut()
                    .find(|p| p.role.ends_with("spec"))
                    .unwrap();
                if let Target::Bytes { mime, .. } = &mut p.target {
                    *mime = "text/plain".into();
                }
            }
            _ => panic!("unknown mutation"),
        }
        checked!(
            read_materialization_description(
                &Delta {
                    id: compute_id(&claims).unwrap(),
                    claims,
                    sig: None
                },
                verb
            )
            .is_err(),
            "{}",
            n["id"]
        );
        assertion_evidence::record(
            "command-descriptions",
            include_bytes!("../../../vectors/materialization/command-descriptions.json"),
            "negatives",
            n,
            assertions - before,
        );
    }
    let _ = assertions;
}
