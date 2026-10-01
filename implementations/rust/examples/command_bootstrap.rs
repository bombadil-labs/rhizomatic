//! Emit the actual built-in definition bodies for the command bootstrap contract gate.
use rhizomatic::schema_deltas::{hyper_schema_schema, schema_schema};
use rhizomatic::term_io::{term_canonical_hex, term_hash};
use serde_json::json;

fn main() -> Result<(), String> {
    let hyper = hyper_schema_schema();
    let reading = schema_schema();
    println!(
        "{}",
        json!({
            "HyperSchemaSchema": {
                "name": hyper.name,
                "alg": hyper.alg,
                "canonicalCborHex": term_canonical_hex(&hyper.body)?,
                "termHash": term_hash(&hyper.body)?,
            },
            "SchemaSchema": {
                "name": reading.name,
                "alg": reading.alg,
                "canonicalCborHex": term_canonical_hex(&reading.body)?,
                "termHash": term_hash(&reading.body)?,
            },
        })
    );
    Ok(())
}
