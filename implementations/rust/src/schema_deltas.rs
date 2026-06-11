//! Schemas as deltas + the bootstrap (SPEC-3 §5, ERRATA-3 S1-S3). Mirrors ../ts/src/schema-deltas.ts.

use serde_json::json;

use crate::cbor::decode;
use crate::eval::{eval_term, EvalResult};
use crate::schema::HyperSchema;
use crate::set::DeltaSet;
use crate::term_io::{cbor_to_json, term_canonical_hex};
use crate::term_json::parse_term;
use crate::types::{Claims, Pointer, Primitive, Target};

/// The vocabulary prefix is one constant pending the naming decision tracked in CLAUDE.md (S4).
pub const VOCAB_PREFIX: &str = "rdb";

fn role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.schema.{suffix}")
}

/// The bootstrap (S2): the (amended, S5) canonical idiom — mask BEFORE select — hand-specified.
pub fn schema_schema() -> HyperSchema {
    HyperSchema {
        name: format!("{VOCAB_PREFIX}.SchemaSchema"),
        alg: 1,
        body: parse_term(&json!({
            "op": "group",
            "key": "byTargetContext",
            "in": {
                "op": "select",
                "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
                "in": { "op": "mask", "policy": "drop", "in": "input" }
            }
        }))
        .expect("the bootstrap term is well-formed"),
    }
}

/// Publish a schema definition as claims (S1).
pub fn publish_schema_claims(
    schema: &HyperSchema,
    schema_entity: &str,
    author: &str,
    timestamp: f64,
) -> Result<Claims, String> {
    Ok(Claims {
        timestamp,
        author: author.to_string(),
        pointers: vec![
            Pointer {
                role: role("defines"),
                target: Target::Entity(crate::types::EntityRef {
                    id: schema_entity.to_string(),
                    context: Some("definition".to_string()),
                }),
            },
            Pointer {
                role: role("name"),
                target: Target::Primitive(Primitive::Str(schema.name.clone())),
            },
            Pointer {
                role: role("alg"),
                target: Target::Primitive(Primitive::Num(f64::from(schema.alg))),
            },
            Pointer {
                role: role("term"),
                target: Target::Primitive(Primitive::Str(term_canonical_hex(&schema.body)?)),
            },
        ],
    })
}

fn primitive_of(claims: &Claims, want_role: &str) -> Option<Primitive> {
    claims.pointers.iter().find_map(|p| {
        if p.role != want_role {
            return None;
        }
        match &p.target {
            Target::Primitive(v) => Some(v.clone()),
            _ => None,
        }
    })
}

/// Load a schema definition from the rhizome (S3): evaluate the bootstrap at the schema entity,
/// take the latest surviving definition, decode the term, verify canonicality by re-encoding.
pub fn load_schema(dset: &DeltaSet, schema_entity: &str) -> Result<HyperSchema, String> {
    let boot = schema_schema();
    let result = eval_term(&boot.body, dset, Some(schema_entity), None, None)?;
    let EvalResult::HView(h) = result else {
        return Err("bootstrap body must yield an HView".to_string());
    };
    let empty = Vec::new();
    let defs = h.props.get("definition").unwrap_or(&empty);
    if defs.is_empty() {
        return Err(format!(
            "no surviving schema definition for {schema_entity}"
        ));
    }
    let latest = defs
        .iter()
        .max_by(|a, b| {
            a.delta
                .claims
                .timestamp
                .partial_cmp(&b.delta.claims.timestamp)
                .unwrap()
                .then_with(|| b.delta.id.cmp(&a.delta.id)) // lexById tiebreak (earlier id wins on tie)
        })
        .unwrap();
    let Some(Primitive::Str(name)) = primitive_of(&latest.delta.claims, &role("name")) else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let Some(Primitive::Num(alg)) = primitive_of(&latest.delta.claims, &role("alg")) else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let Some(Primitive::Str(term_hex)) = primitive_of(&latest.delta.claims, &role("term")) else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let bytes = hex::decode(&term_hex).map_err(|e| format!("bad term hex: {e}"))?;
    let term = parse_term(&cbor_to_json(&decode(&bytes)?))?;
    // Reject non-canonical blobs: the term must re-encode to exactly the published bytes (S3).
    if term_canonical_hex(&term)? != term_hex {
        return Err(format!(
            "schema definition {} carries a non-canonical term blob",
            latest.delta.id
        ));
    }
    Ok(HyperSchema {
        name,
        alg: alg as u32,
        body: term,
    })
}
