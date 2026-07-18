//! The HyperView (SPEC-3 §4), encoded per ERRATA-2 E7/E11. Mirrors ../ts/src/hview.ts.
//! Provenance-complete: every entry carries the full delta; expansion is view structure keyed by
//! pointer index, never a mutation of the delta.

use std::collections::BTreeMap;

use crate::cbor::{encode, CborValue};
use crate::resolution::Schema;
use crate::term_io::schema_hash;
use crate::types::{Claims, Delta, Primitive, Target};

#[derive(Debug, Clone, PartialEq)]
pub struct HVEntry {
    pub delta: Delta,
    /// Annotate tag threaded through group from a mask(annotate) operand (E7).
    pub negated: bool,
    /// expand replacements: pointer index (authored order) -> nested HView (E11).
    pub expanded: BTreeMap<usize, HView>,
    /// The reading (child's resolution Schema) each expansion resolves through, same keying
    /// (issue #23). The full Schema is in-memory registry state; the canonical form carries only
    /// its CONTENT ADDRESS, so a serialized hview stays self-describing and resolvable (a
    /// rehydrator dereferences the hash through the registry).
    pub readings: BTreeMap<usize, Schema>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HView {
    pub id: String,
    /// BTreeMap keeps properties canonically ordered; entries are sorted by delta id.
    pub props: BTreeMap<String, Vec<HVEntry>>,
}

fn target_to_cbor_with_expansion(
    t: &Target,
    expansion: Option<&HView>,
    reading: Option<&Schema>,
) -> CborValue {
    if let Some(h) = expansion {
        // The reading's CONTENT ADDRESS rides the canonical form (issue #23 follow-up): the
        // reading is part of the program identity, and without it a rehydrated hview would be
        // unresolvable. The full Schema stays out (registry state, dereferenced by hash).
        // Key order stays canonical: "id" < "props" < "reading".
        return match (reading, hview_to_cbor(h)) {
            (Some(r), CborValue::Map(mut entries)) => {
                // Infallible in practice: every registered reading was hashed at registry build.
                let hash = schema_hash(r).expect("reading was hashed at registry build");
                entries.push(("reading".to_string(), CborValue::Tstr(hash)));
                CborValue::Map(entries)
            }
            (_, child) => child,
        };
    }
    match t {
        Target::Primitive(Primitive::Str(s)) => CborValue::Tstr(s.clone()),
        Target::Primitive(Primitive::Bool(b)) => CborValue::Bool(*b),
        Target::Primitive(Primitive::Num(n)) => CborValue::Float(*n),
        Target::Entity(e) => {
            let mut m = vec![("id".to_string(), CborValue::Tstr(e.id.clone()))];
            if let Some(c) = &e.context {
                m.push(("context".to_string(), CborValue::Tstr(c.clone())));
            }
            CborValue::Map(m)
        }
        Target::Bytes { mime, value } => CborValue::Map(vec![
            ("mime".to_string(), CborValue::Tstr(mime.clone())),
            ("value".to_string(), CborValue::Bstr(value.clone())),
        ]),
        Target::Delta(d) => {
            let mut m = vec![("delta".to_string(), CborValue::Tstr(d.delta.clone()))];
            if let Some(c) = &d.context {
                m.push(("context".to_string(), CborValue::Tstr(c.clone())));
            }
            CborValue::Map(m)
        }
    }
}

/// Claims rendered for an HVEntry: identical to the L1 canonical claims encoding, except that
/// expanded pointer targets are replaced by nested HView maps (E11). Never used for hashing.
fn claims_to_cbor_with_expansions(
    claims: &Claims,
    expanded: &BTreeMap<usize, HView>,
    readings: &BTreeMap<usize, Schema>,
) -> CborValue {
    CborValue::Map(vec![
        ("author".to_string(), CborValue::Tstr(claims.author.clone())),
        (
            "pointers".to_string(),
            CborValue::Array(
                claims
                    .pointers
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        CborValue::Map(vec![
                            ("role".to_string(), CborValue::Tstr(p.role.clone())),
                            (
                                "target".to_string(),
                                target_to_cbor_with_expansion(
                                    &p.target,
                                    expanded.get(&i),
                                    readings.get(&i),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("timestamp".to_string(), CborValue::Float(claims.timestamp)),
    ])
}

pub fn hv_entry_to_cbor(e: &HVEntry) -> CborValue {
    let mut entries = vec![
        ("id".to_string(), CborValue::Tstr(e.delta.id.clone())),
        (
            "claims".to_string(),
            claims_to_cbor_with_expansions(&e.delta.claims, &e.expanded, &e.readings),
        ),
    ];
    if let Some(sig) = &e.delta.sig {
        entries.push(("sig".to_string(), CborValue::Tstr(sig.clone())));
    }
    if e.negated {
        entries.push(("negated".to_string(), CborValue::Bool(true)));
    }
    CborValue::Map(entries)
}

pub fn hview_to_cbor(h: &HView) -> CborValue {
    let props: Vec<(String, CborValue)> = h
        .props
        .iter()
        .map(|(prop, entries)| {
            (
                prop.clone(),
                CborValue::Array(entries.iter().map(hv_entry_to_cbor).collect()),
            )
        })
        .collect();
    CborValue::Map(vec![
        ("id".to_string(), CborValue::Tstr(h.id.clone())),
        ("props".to_string(), CborValue::Map(props)),
    ])
}

/// HyperViews are content-addressable (SPEC-3 §4): same (schema, DSet) => byte-identical form.
pub fn hview_canonical_hex(h: &HView) -> String {
    hex::encode(encode(&hview_to_cbor(h)))
}
