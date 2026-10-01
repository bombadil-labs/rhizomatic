//! Named lens bindings: one gather pin and one resolution Schema pin, read under explicit trust.

use crate::eval::{eval_term_at, first_by_order, governed_deltas, EvalResult};
use crate::resolution::{Order, Schema};
use crate::schema::HyperSchema;
use crate::schema_deltas::{hyper_schema_schema, VOCAB_PREFIX};
use crate::set::DeltaSet;
use crate::term_io::{schema_hash, term_hash};
use crate::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LensBinding {
    pub name: String,
    pub hyper_schema_pin: String,
    pub schema_pin: String,
    pub delta_id: String,
}

fn role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.lens.{suffix}")
}

pub fn publish_lens_binding_claims(
    name: &str,
    hyper_schema: &HyperSchema,
    schema: &Schema,
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
                role: role("binds"),
                target: Target::Entity(EntityRef {
                    id: name.to_string(),
                    context: Some("lens".to_string()),
                }),
            },
            Pointer {
                role: role("hyperschema"),
                target: Target::Primitive(Primitive::Str(term_hash(&hyper_schema.body)?)),
            },
            Pointer {
                role: role("schema"),
                target: Target::Primitive(Primitive::Str(schema_hash(schema)?)),
            },
        ],
    })
}

fn pin(delta: &Delta, wanted: &str) -> Option<String> {
    let mut found = delta
        .claims
        .pointers
        .iter()
        .filter(|pointer| pointer.role == wanted);
    let first = found.next()?;
    if found.next().is_some() {
        return None;
    }
    match &first.target {
        Target::Primitive(Primitive::Str(value))
            if value.len() == 68
                && value.starts_with("1e20")
                && value[4..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) =>
        {
            Some(value.clone())
        }
        _ => None,
    }
}

fn read_binding(delta: &Delta, name: &str) -> Result<LensBinding, String> {
    let filing = delta.claims.pointers.iter().filter(|pointer| {
        pointer.role == role("binds")
            && matches!(&pointer.target, Target::Entity(entity) if entity.id == name && entity.context.as_deref() == Some("lens"))
    });
    if delta.claims.pointers.len() != 3 || filing.count() != 1 {
        return Err(format!("malformed lens binding delta {}", delta.id));
    }
    let Some(hyper_schema_pin) = pin(delta, &role("hyperschema")) else {
        return Err(format!("malformed lens binding delta {}", delta.id));
    };
    let Some(schema_pin) = pin(delta, &role("schema")) else {
        return Err(format!("malformed lens binding delta {}", delta.id));
    };
    Ok(LensBinding {
        name: name.to_string(),
        hyper_schema_pin,
        schema_pin,
        delta_id: delta.id.clone(),
    })
}

pub fn load_lens_binding(
    input: &DeltaSet,
    name: &str,
    now: f64,
    admits_author: impl Fn(&str) -> bool,
    order: &Order,
) -> Result<LensBinding, String> {
    let governed = governed_deltas(input, now, admits_author)?;
    let result = eval_term_at(
        &hyper_schema_schema().body,
        &governed,
        now,
        Some(name),
        None,
        None,
    )?;
    let EvalResult::HView(view) = result else {
        return Err("lens bootstrap must yield an HView".to_string());
    };
    let chosen = view
        .props
        .get("lens")
        .and_then(|entries| first_by_order(order, entries))
        .ok_or_else(|| format!("no surviving lens binding for {name}"))?;
    read_binding(&chosen.delta, name)
}
