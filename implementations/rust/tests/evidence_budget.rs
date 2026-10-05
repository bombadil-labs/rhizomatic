#[path = "support/evidence_assertions.rs"]
mod assertion_evidence;
// Compile the exact private semantic walkers in this test crate; no production I/O.
use rhizomatic::{cbor, eval, pred, resolution, term_io, term_json, types};
#[allow(dead_code)]
#[path = "../src/evidence_codec.rs"]
mod evidence_codec;
#[path = "../src/reading_budget.rs"]
mod reading_budget;
#[path = "../src/reading_wire_budget.rs"]
mod reading_wire_budget;
mod tests {
    use crate::evidence_codec::ReadingAppearanceLimits;
    use crate::reading_wire_budget::check;
    #[test]
    fn shared_semantic_budget_boundaries() {
        let vs: serde_json::Value = serde_json::from_str(include_str!(
            "../../../vectors/materialization/evidence-envelope.json"
        ))
        .unwrap();
        let mut assertions = 0;
        macro_rules! checked_eq { ($($args:tt)*) => {{ assert_eq!($($args)*); assertions+=1; }}; }
        macro_rules! checked { ($($args:tt)*) => {{ assert!($($args)*); assertions+=1; }}; }
        for v in vs["syntaxBudgets"].as_array().unwrap() {
            let before = assertions;
            let raw = crate::term_io::json_to_cbor(&v["native"]).unwrap();
            let limits = ReadingAppearanceLimits {
                syntax_nodes: v["nodes"].as_u64().unwrap() as usize,
                syntax_depth: v["depth"].as_u64().unwrap() as usize,
                ..Default::default()
            };
            checked!(check(&raw, limits).is_ok(), "{}", v["variant"]);
            checked_eq!(
                check(
                    &raw,
                    ReadingAppearanceLimits {
                        syntax_nodes: limits.syntax_nodes - 1,
                        ..limits
                    }
                ),
                Err(crate::evidence_codec::EvidenceCodecError::ResourceLimit),
                "{}",
                v["variant"]
            );
            checked_eq!(
                check(
                    &raw,
                    ReadingAppearanceLimits {
                        syntax_depth: limits.syntax_depth - 1,
                        ..limits
                    }
                ),
                Err(crate::evidence_codec::EvidenceCodecError::ResourceLimit),
                "{}",
                v["variant"]
            );
            if v["valid"] == true {
                let native = crate::term_json::parse_schema(&v["native"]).unwrap();
                checked!(crate::reading_budget::check(&native, limits).is_ok());
            }
            crate::assertion_evidence::record("syntaxBudgets", v, assertions - before);
        }
    }
}
