// Assertion receipts complement executed tests; they are not semantic proofs on their own.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub fn record(group: &str, v: &Value, assertions: usize) {
    let bytes = include_bytes!("../../../../vectors/materialization/evidence-envelope.json");
    println!(
        "materialization-assertion:{}",
        json!({"group":group,"id":v.get("id").unwrap_or(&Value::Null),"variant":v["variant"],"corpusId":hex::encode(Sha256::digest(bytes)),"assertions":assertions})
    );
}
