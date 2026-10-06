// Executed assertion receipts supplement tests/review; they do not prove arbitrary assertion semantics.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub fn record(corpus: &str, bytes: &[u8], group: &str, v: &Value, assertions: usize) {
    println!(
        "materialization-m2-assertion:{}",
        json!({"corpus":corpus,"corpusId":hex::encode(Sha256::digest(bytes)),"group":group,"id":v["id"],"assertions":assertions})
    );
}
