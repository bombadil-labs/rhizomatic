//! The pack format (SPEC-8, ERRATA-8). Mirrors ../ts/src/pack.ts byte-for-byte.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{decode, encode, CborValue};
use crate::hash::content_address;
use crate::reactor::manifest_member_ids;
use crate::set::{make_delta, DeltaSet};
use crate::types::{Claims, Delta, Pointer, Primitive, Target};

const PACK_VERSION: f64 = 1.0;

fn strings_of(delta: &Delta, out: &mut BTreeSet<String>) {
    out.insert(delta.id.clone()); // stored ids make rehydration self-verifying (SPEC-8 §4)
    out.insert(delta.claims.author.clone());
    if let Some(sig) = &delta.sig {
        out.insert(sig.clone());
    }
    for p in &delta.claims.pointers {
        out.insert(p.role.clone());
        match &p.target {
            Target::Entity(er) => {
                out.insert(er.id.clone());
                if let Some(c) = &er.context {
                    out.insert(c.clone());
                }
            }
            Target::Delta(dr) => {
                out.insert(dr.delta.clone());
                if let Some(c) = &dr.context {
                    out.insert(c.clone());
                }
            }
            Target::Primitive(Primitive::Str(s)) => {
                out.insert(s.clone());
            }
            Target::Primitive(_) => {}
        }
    }
}

fn fidx(idx: &BTreeMap<String, usize>, s: &str) -> CborValue {
    CborValue::Float(idx[s] as f64)
}

fn ptr_to_cbor(p: &Pointer, idx: &BTreeMap<String, usize>) -> CborValue {
    let mut entries = vec![("r".to_string(), fidx(idx, &p.role))];
    let mut context: Option<&String> = None;
    match &p.target {
        Target::Entity(er) => {
            entries.push(("e".to_string(), fidx(idx, &er.id)));
            context = er.context.as_ref();
        }
        Target::Delta(dr) => {
            entries.push(("d".to_string(), fidx(idx, &dr.delta)));
            context = dr.context.as_ref();
        }
        Target::Primitive(Primitive::Str(s)) => entries.push(("s".to_string(), fidx(idx, s))),
        Target::Primitive(Primitive::Num(n)) => {
            entries.push(("n".to_string(), CborValue::Float(*n)))
        }
        Target::Primitive(Primitive::Bool(b)) => {
            entries.push(("b".to_string(), CborValue::Bool(*b)))
        }
    }
    if let Some(c) = context {
        entries.push(("c".to_string(), fidx(idx, c)));
    }
    CborValue::Map(entries)
}

fn hydrated_record(d: &Delta, idx: &BTreeMap<String, usize>) -> CborValue {
    let mut entries = vec![
        ("i".to_string(), fidx(idx, &d.id)),
        ("a".to_string(), fidx(idx, &d.claims.author)),
        ("t".to_string(), CborValue::Float(d.claims.timestamp)),
        (
            "p".to_string(),
            CborValue::Array(
                d.claims
                    .pointers
                    .iter()
                    .map(|p| ptr_to_cbor(p, idx))
                    .collect(),
            ),
        ),
    ];
    if let Some(sig) = &d.sig {
        entries.push(("s".to_string(), fidx(idx, sig)));
    }
    CborValue::Map(entries)
}

fn member_record(
    d: &Delta,
    manifest: &Delta,
    envelope_idx: usize,
    idx: &BTreeMap<String, usize>,
) -> CborValue {
    let mut entries = vec![
        ("i".to_string(), fidx(idx, &d.id)),
        ("m".to_string(), CborValue::Float(envelope_idx as f64)),
        (
            "p".to_string(),
            CborValue::Array(
                d.claims
                    .pointers
                    .iter()
                    .map(|p| ptr_to_cbor(p, idx))
                    .collect(),
            ),
        ),
    ];
    // Dehydrate against the envelope (SPEC-8 §3.1); divergent fields stored explicitly (P2).
    if d.claims.author != manifest.claims.author {
        entries.push(("a".to_string(), fidx(idx, &d.claims.author)));
    }
    let dt = d.claims.timestamp - manifest.claims.timestamp;
    if dt != 0.0 {
        entries.push(("dt".to_string(), CborValue::Float(dt)));
    }
    if let Some(sig) = &d.sig {
        entries.push(("s".to_string(), fidx(idx, sig)));
    }
    CborValue::Map(entries)
}

pub fn pack_set(set: &DeltaSet) -> Vec<u8> {
    let deltas: Vec<&Delta> = set.iter().collect(); // DeltaSet iterates id-sorted
    let manifests: Vec<&Delta> = deltas
        .iter()
        .copied()
        .filter(|d| !manifest_member_ids(d).is_empty())
        .collect();
    // Each member is dehydrated against the lexicographically FIRST claiming manifest (P1).
    let mut member_to_manifest: BTreeMap<String, usize> = BTreeMap::new();
    for (i, m) in manifests.iter().enumerate() {
        for id in manifest_member_ids(m) {
            if set.contains(&id) {
                member_to_manifest.entry(id).or_insert(i);
            }
        }
    }
    let manifest_ids: BTreeSet<&str> = manifests.iter().map(|m| m.id.as_str()).collect();
    let members: Vec<&Delta> = deltas
        .iter()
        .copied()
        .filter(|d| member_to_manifest.contains_key(&d.id) && !manifest_ids.contains(d.id.as_str()))
        .collect();
    let loose: Vec<&Delta> = deltas
        .iter()
        .copied()
        .filter(|d| {
            !member_to_manifest.contains_key(&d.id) && !manifest_ids.contains(d.id.as_str())
        })
        .collect();

    let mut string_set = BTreeSet::new();
    for d in &deltas {
        strings_of(d, &mut string_set);
    }
    let strings: Vec<String> = string_set.into_iter().collect();
    let idx: BTreeMap<String, usize> = strings
        .iter()
        .enumerate()
        .map(|(i, s)| (s.clone(), i))
        .collect();

    let packed = CborValue::Map(vec![
        ("version".to_string(), CborValue::Float(PACK_VERSION)),
        (
            "strings".to_string(),
            CborValue::Array(strings.iter().map(|s| CborValue::Tstr(s.clone())).collect()),
        ),
        (
            "envelopes".to_string(),
            CborValue::Array(manifests.iter().map(|m| hydrated_record(m, &idx)).collect()),
        ),
        (
            "members".to_string(),
            CborValue::Array(
                members
                    .iter()
                    .map(|d| {
                        let mi = member_to_manifest[&d.id];
                        member_record(d, manifests[mi], mi, &idx)
                    })
                    .collect(),
            ),
        ),
        (
            "loose".to_string(),
            CborValue::Array(loose.iter().map(|d| hydrated_record(d, &idx)).collect()),
        ),
    ]);
    encode(&packed)
}

pub fn pack_id(bytes: &[u8]) -> String {
    content_address(bytes)
}

// --- unpacking --------------------------------------------------------------------------------------

fn as_map(v: &CborValue, what: &str) -> Result<BTreeMap<String, CborValue>, String> {
    match v {
        CborValue::Map(entries) => Ok(entries.iter().cloned().collect()),
        _ => Err(format!("pack: expected map for {what}")),
    }
}

fn as_array<'a>(v: Option<&'a CborValue>, what: &str) -> Result<&'a [CborValue], String> {
    match v {
        Some(CborValue::Array(items)) => Ok(items),
        _ => Err(format!("pack: expected array for {what}")),
    }
}

fn as_num(v: Option<&CborValue>, what: &str) -> Result<f64, String> {
    match v {
        Some(CborValue::Float(n)) => Ok(*n),
        _ => Err(format!("pack: expected number for {what}")),
    }
}

fn ptr_from_cbor(v: &CborValue, strings: &[String]) -> Result<Pointer, String> {
    let o = as_map(v, "pointer")?;
    let s = |key: &str| -> Result<String, String> {
        Ok(strings[as_num(o.get(key), key)? as usize].clone())
    };
    let role = s("r")?;
    let context = if o.contains_key("c") {
        Some(s("c")?)
    } else {
        None
    };
    let target = if o.contains_key("e") {
        Target::Entity(crate::types::EntityRef {
            id: s("e")?,
            context,
        })
    } else if o.contains_key("d") {
        Target::Delta(crate::types::DeltaRef {
            delta: s("d")?,
            context,
        })
    } else if o.contains_key("s") {
        Target::Primitive(Primitive::Str(s("s")?))
    } else if o.contains_key("n") {
        Target::Primitive(Primitive::Num(as_num(o.get("n"), "n")?))
    } else if o.contains_key("b") {
        match o.get("b") {
            Some(CborValue::Bool(b)) => Target::Primitive(Primitive::Bool(*b)),
            _ => return Err("pack: expected bool for b".to_string()),
        }
    } else {
        return Err("pack: pointer record has no target".to_string());
    };
    Ok(Pointer { role, target })
}

/// SPEC-8 §4: hydrate -> canonical CBOR -> multihash MUST equal the stored id. Free fsck.
fn verified_delta(claims: Claims, sig: Option<String>, stored_id: &str) -> Result<Delta, String> {
    let d = make_delta(claims, sig)?;
    if d.id != stored_id {
        return Err(format!(
            "pack: rehydrated delta {} does not match stored id {stored_id}",
            d.id
        ));
    }
    Ok(d)
}

fn hydrate_record(v: &CborValue, strings: &[String]) -> Result<Delta, String> {
    let o = as_map(v, "record")?;
    let claims = Claims {
        author: strings[as_num(o.get("a"), "a")? as usize].clone(),
        timestamp: as_num(o.get("t"), "t")?,
        pointers: as_array(o.get("p"), "p")?
            .iter()
            .map(|p| ptr_from_cbor(p, strings))
            .collect::<Result<Vec<_>, _>>()?,
    };
    let sig = if o.contains_key("s") {
        Some(strings[as_num(o.get("s"), "s")? as usize].clone())
    } else {
        None
    };
    verified_delta(claims, sig, &strings[as_num(o.get("i"), "i")? as usize])
}

pub fn unpack_set(bytes: &[u8]) -> Result<DeltaSet, String> {
    let top = as_map(&decode(bytes)?, "pack")?;
    if as_num(top.get("version"), "version")? != PACK_VERSION {
        return Err("pack: unsupported version".to_string());
    }
    let strings: Vec<String> = as_array(top.get("strings"), "strings")?
        .iter()
        .map(|s| match s {
            CborValue::Tstr(x) => Ok(x.clone()),
            _ => Err("pack: string table entries must be text".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = DeltaSet::new();
    let envelopes: Vec<Delta> = as_array(top.get("envelopes"), "envelopes")?
        .iter()
        .map(|e| hydrate_record(e, &strings))
        .collect::<Result<Vec<_>, _>>()?;
    for m in &envelopes {
        out.add(m.clone())?;
    }
    for rec in as_array(top.get("members"), "members")? {
        let o = as_map(rec, "member")?;
        let manifest = envelopes
            .get(as_num(o.get("m"), "m")? as usize)
            .ok_or("pack: member references missing envelope")?;
        let author = if o.contains_key("a") {
            strings[as_num(o.get("a"), "a")? as usize].clone()
        } else {
            manifest.claims.author.clone()
        };
        let dt = if o.contains_key("dt") {
            as_num(o.get("dt"), "dt")?
        } else {
            0.0
        };
        let claims = Claims {
            author,
            timestamp: manifest.claims.timestamp + dt,
            pointers: as_array(o.get("p"), "p")?
                .iter()
                .map(|p| ptr_from_cbor(p, &strings))
                .collect::<Result<Vec<_>, _>>()?,
        };
        let sig = if o.contains_key("s") {
            Some(strings[as_num(o.get("s"), "s")? as usize].clone())
        } else {
            None
        };
        out.add(verified_delta(
            claims,
            sig,
            &strings[as_num(o.get("i"), "i")? as usize],
        )?)?;
    }
    for rec in as_array(top.get("loose"), "loose")? {
        out.add(hydrate_record(rec, &strings)?)?;
    }
    Ok(out)
}
