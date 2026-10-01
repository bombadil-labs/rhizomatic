//! HyperSchemas as deltas + the bootstrap (SPEC-3 §5, ERRATA-3 S1-S3). Mirrors ../ts/src/schema-deltas.ts.

use serde_json::json;

use crate::cbor::decode;
use crate::eval::selected_definition;
use crate::resolution::{Order, Schema};
use crate::schema::HyperSchema;
use crate::set::DeltaSet;
use crate::term_io::{cbor_to_json, schema_canonical_hex, term_canonical_hex};
use crate::term_json::{parse_schema, parse_term};
use crate::types::{Claims, Pointer, Primitive, Target};

/// The vocabulary prefix is one constant pending the naming decision tracked in CLAUDE.md (S4).
pub use crate::types::VOCAB_PREFIX;

fn role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.hyperschema.{suffix}")
}

/// The bootstrap (S2): the (amended, S5) canonical idiom — mask BEFORE select — hand-specified.
pub fn hyper_schema_schema() -> HyperSchema {
    HyperSchema {
        name: format!("{VOCAB_PREFIX}.HyperSchemaSchema"),
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
pub fn publish_hyper_schema_claims(
    schema: &HyperSchema,
    schema_entity: &str,
    author: &str,
    timestamp: f64,
) -> Result<Claims, String> {
    Ok(Claims {
        timestamp,
        valid_from: timestamp,
        valid_until: None,
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
/// Load under a caller-selected governing author predicate and Pick order.
pub fn load_governed_hyper_schema(
    dset: &DeltaSet,
    schema_entity: &str,
    now: f64,
    admits_author: impl Fn(&str) -> bool,
    order: &Order,
) -> Result<HyperSchema, String> {
    let latest = selected_definition(
        &hyper_schema_schema().body,
        dset,
        schema_entity,
        now,
        admits_author,
        order,
    )?;
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

/// Legacy all-author loader with its compatibility ordering made explicit.
pub fn load_hyper_schema(
    dset: &DeltaSet,
    schema_entity: &str,
    now: f64,
) -> Result<HyperSchema, String> {
    load_governed_hyper_schema(
        dset,
        schema_entity,
        now,
        |_| true,
        &Order::ByTimestamp { desc: true },
    )
}

// --- resolution Schema self-hosting (SPEC-3 ERRATA S6, issue #11) ----------------------------------

fn schema_role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.schema.{suffix}")
}

/// SCHEMA_SCHEMA (`rhizomatic.SchemaSchema`): the bootstrap through which resolution Schemas are read
/// (S6). Mechanical parity — reuses the generic gather idiom of `hyper_schema_schema`.
pub fn schema_schema() -> HyperSchema {
    HyperSchema {
        name: format!("{VOCAB_PREFIX}.SchemaSchema"),
        alg: 1,
        body: hyper_schema_schema().body,
    }
}

/// Publish a resolution Schema as claims (parallel to `publish_hyper_schema_claims`). A published
/// Schema MUST be named; the term blob is its content hash over props+default.
pub fn publish_schema_claims(
    schema: &Schema,
    schema_entity: &str,
    author: &str,
    timestamp: f64,
) -> Result<Claims, String> {
    let (Some(name), Some(alg)) = (&schema.name, schema.alg) else {
        return Err("a published Schema must carry a name and alg (SPEC-3 ERRATA S6)".to_string());
    };
    Ok(Claims {
        timestamp,
        valid_from: timestamp,
        valid_until: None,
        author: author.to_string(),
        pointers: vec![
            Pointer {
                role: schema_role("defines"),
                target: Target::Entity(crate::types::EntityRef {
                    id: schema_entity.to_string(),
                    context: Some("definition".to_string()),
                }),
            },
            Pointer {
                role: schema_role("name"),
                target: Target::Primitive(Primitive::Str(name.clone())),
            },
            Pointer {
                role: schema_role("alg"),
                target: Target::Primitive(Primitive::Num(alg)),
            },
            Pointer {
                role: schema_role("term"),
                target: Target::Primitive(Primitive::Str(schema_canonical_hex(schema)?)),
            },
        ],
    })
}

/// Load a resolution Schema from the rhizome (parallel to `load_hyper_schema`): gather via
/// SCHEMA_SCHEMA, take the latest surviving definition, decode props+default, reject non-canonical
/// blobs, and reattach name/alg from the roles.
pub fn load_governed_schema(
    dset: &DeltaSet,
    schema_entity: &str,
    now: f64,
    admits_author: impl Fn(&str) -> bool,
    order: &Order,
) -> Result<Schema, String> {
    let latest = selected_definition(
        &schema_schema().body,
        dset,
        schema_entity,
        now,
        admits_author,
        order,
    )?;
    let Some(Primitive::Str(name)) = primitive_of(&latest.delta.claims, &schema_role("name"))
    else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let Some(Primitive::Num(alg)) = primitive_of(&latest.delta.claims, &schema_role("alg")) else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let Some(Primitive::Str(term_hex)) = primitive_of(&latest.delta.claims, &schema_role("term"))
    else {
        return Err(format!(
            "malformed schema definition delta {}",
            latest.delta.id
        ));
    };
    let bytes = hex::decode(&term_hex).map_err(|e| format!("bad schema hex: {e}"))?;
    let mut schema = parse_schema(&cbor_to_json(&decode(&bytes)?))?;
    // Reject non-canonical blobs: props+default must re-encode to exactly the published bytes (S3).
    if schema_canonical_hex(&schema)? != term_hex {
        return Err(format!(
            "schema definition {} carries a non-canonical schema blob",
            latest.delta.id
        ));
    }
    schema.name = Some(name);
    schema.alg = Some(alg);
    Ok(schema)
}

/// Legacy all-author loader with its compatibility ordering made explicit.
pub fn load_schema(dset: &DeltaSet, schema_entity: &str, now: f64) -> Result<Schema, String> {
    load_governed_schema(
        dset,
        schema_entity,
        now,
        |_| true,
        &Order::ByTimestamp { desc: true },
    )
}

/// An exact signed definition act. This reader never chooses a newer ambient publication.
#[derive(Debug, Clone, PartialEq)]
pub enum ExactDefinition {
    Gather(HyperSchema),
    Reading(Schema),
}
pub fn read_exact_definition(
    delta: &crate::types::Delta,
    at: f64,
) -> Result<ExactDefinition, String> {
    use crate::sign::{verify_canonical_delta, Verification};
    if !at.is_finite()
        || verify_canonical_delta(delta) != Verification::Verified
        || delta.claims.valid_from > at
        || delta.claims.valid_until.is_some_and(|end| at >= end)
        || delta.claims.pointers.len() != 4
    {
        return Err("invalid signed definition validity or shape".into());
    }
    let fields: std::collections::BTreeMap<&str, &Target> = delta
        .claims
        .pointers
        .iter()
        .map(|p| (p.role.as_str(), &p.target))
        .collect();
    if fields.len() != 4 {
        return Err("duplicate definition field".into());
    }
    let prefix = if fields.contains_key(&*role("defines")) {
        format!("{VOCAB_PREFIX}.hyperschema")
    } else {
        format!("{VOCAB_PREFIX}.schema")
    };
    let keys = ["defines", "name", "alg", "term"].map(|s| format!("{prefix}.{s}"));
    if keys.iter().any(|k| !fields.contains_key(k.as_str())) {
        return Err("definition fields".into());
    }
    match fields[keys[0].as_str()] {
        Target::Entity(r) if r.context.as_deref() == Some("definition") => {}
        _ => return Err("definition entity required".into()),
    }
    let name = match fields[keys[1].as_str()] {
        Target::Primitive(Primitive::Str(s)) => s.clone(),
        _ => return Err("definition name".into()),
    };
    if fields[keys[2].as_str()] != &Target::Primitive(Primitive::Num(1.0)) {
        return Err("definition algebra must be 1".into());
    }
    let blob = match fields[keys[3].as_str()] {
        Target::Primitive(Primitive::Str(s)) => s,
        _ => return Err("definition blob".into()),
    };
    let bytes = hex::decode(blob).map_err(|e| e.to_string())?;
    let value = cbor_to_json(&decode(&bytes)?);
    if prefix.ends_with("hyperschema") {
        let body = parse_term(&value)?;
        if term_canonical_hex(&body)? != *blob {
            return Err("noncanonical definition term".into());
        }
        Ok(ExactDefinition::Gather(HyperSchema { name, alg: 1, body }))
    } else {
        let mut reading = parse_schema(&value)?;
        if schema_canonical_hex(&reading)? != *blob {
            return Err("noncanonical definition reading".into());
        }
        reading.name = Some(name);
        reading.alg = Some(1.0);
        Ok(ExactDefinition::Reading(reading))
    }
}
