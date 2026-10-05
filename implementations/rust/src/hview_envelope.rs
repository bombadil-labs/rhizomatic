//! SPEC-16: original appearances and reading metadata, independent of HView identity.
use crate::cbor::{encode, CborPathPart, CborValue};
use crate::delta::{canonical_bytes, compute_id};
use crate::evidence_codec::{
    array, bytes, canonical, canonical_guard, content_id, fields, get, limit, map, string, text,
    ReadingAppearanceLimits, Result, INVALID,
};
use crate::hash::content_address;
use crate::hview::{HVEntry, HView};
use crate::json_profile::parse_claims;
use crate::reading_appearance::{decode_reading_appearance, encode_reading_appearance};
use crate::resolution::Schema;
use crate::sign::{verify_canonical_delta, Verification};
use crate::term_io::cbor_to_json;
use crate::types::{Delta, Primitive, Target};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HViewEnvelopeLimits {
    pub artifact_bytes: usize,
    pub syntax_depth: usize,
    pub syntax_nodes: usize,
    pub appearances: usize,
    pub entries: usize,
    pub nodes: usize,
    pub depth: usize,
    pub pointers: usize,
    pub buckets: usize,
    pub readings: usize,
}
pub const DEFAULT_HVIEW_ENVELOPE_LIMITS: HViewEnvelopeLimits = HViewEnvelopeLimits {
    artifact_bytes: 16_777_216,
    syntax_depth: 64,
    syntax_nodes: 16_384,
    appearances: 4096,
    entries: 16_384,
    nodes: 4096,
    depth: 32,
    pointers: 256,
    buckets: 256,
    readings: 256,
};
impl Default for HViewEnvelopeLimits {
    fn default() -> Self {
        DEFAULT_HVIEW_ENVELOPE_LIMITS
    }
}
impl HViewEnvelopeLimits {
    fn reading(self) -> ReadingAppearanceLimits {
        ReadingAppearanceLimits {
            artifact_bytes: self.artifact_bytes,
            syntax_depth: self.syntax_depth,
            syntax_nodes: self.syntax_nodes,
        }
    }
    fn validate(self) -> Result<Self> {
        self.reading().validate()?;
        for (v, m) in [
            (self.appearances, 4096),
            (self.entries, 16_384),
            (self.nodes, 4096),
            (self.depth, 32),
            (self.pointers, 256),
            (self.buckets, 256),
            (self.readings, 256),
        ] {
            if v == 0 {
                return Err(INVALID);
            }
            limit(v, m)?;
        }
        Ok(self)
    }
}
fn original(delta: &Delta, limits: HViewEnvelopeLimits) -> Result<Vec<u8>> {
    limit(delta.claims.pointers.len(), limits.pointers)?;
    let mut minimum = 0;
    let mut add = |n: usize| -> Result<()> {
        limit(n, limits.artifact_bytes)?;
        minimum += n;
        limit(minimum, limits.artifact_bytes)
    };
    add(delta.claims.author.len())?;
    for p in &delta.claims.pointers {
        add(1)?;
        add(p.role.len())?;
        match &p.target {
            Target::Primitive(Primitive::Str(s)) => add(s.len())?,
            Target::Primitive(_) => {}
            Target::Entity(e) => {
                add(e.id.len())?;
                if let Some(c) = &e.context {
                    add(c.len())?;
                }
            }
            Target::Delta(e) => {
                add(e.delta.len())?;
                if let Some(c) = &e.context {
                    add(c.len())?;
                }
            }
            Target::Bytes { mime, value } => {
                add(mime.len())?;
                add(value.len())?;
            }
        }
    }
    let claims = canonical_bytes(&delta.claims).map_err(|_| INVALID)?;
    limit(claims.len(), limits.artifact_bytes)?;
    content_id(&delta.id)?;
    if compute_id(&delta.claims).map_err(|_| INVALID)? != delta.id {
        return Err(INVALID);
    }
    let mut values = vec![
        ("id", string(&delta.id)),
        ("claims", CborValue::Bstr(claims)),
    ];
    if let Some(sig) = &delta.sig {
        if verify_canonical_delta(delta) != Verification::Verified {
            return Err(INVALID);
        }
        values.push((
            "sig",
            CborValue::Bstr(hex::decode(sig).map_err(|_| INVALID)?),
        ));
    }
    Ok(encode(&map(values)))
}
fn delta_from_bytes(input: &[u8], limits: HViewEnvelopeLimits) -> Result<Delta> {
    let raw = canonical(input, limits.artifact_bytes)?;
    let fs = fields(&raw, &["id", "claims", "sig"])?;
    let claims = canonical_guard(
        bytes(get(&fs, "claims")?)?,
        limits.artifact_bytes,
        &mut |path, is_map, len| {
            if !is_map && path == [CborPathPart::Key("pointers".into())] {
                limit(len, limits.pointers)?;
            }
            Ok(())
        },
    )?;
    let result = Delta {
        id: content_id(text(get(&fs, "id")?)?)?.into(),
        claims: parse_claims(&cbor_to_json(&claims)).map_err(|_| INVALID)?,
        sig: fs
            .get("sig")
            .map(|v| bytes(v).map(hex::encode))
            .transpose()?,
    };
    if original(&result, limits)? != input {
        return Err(INVALID);
    }
    Ok(result)
}
fn valid_slot(delta: &Delta, slot: usize) -> Result<()> {
    if !matches!(
        delta.claims.pointers.get(slot).map(|p| &p.target),
        Some(Target::Entity(_))
    ) {
        return Err(INVALID);
    }
    Ok(())
}
fn table_add(
    table: &mut BTreeMap<String, Vec<u8>>,
    value: Vec<u8>,
    max: usize,
    byte_minimum: &mut usize,
    artifact_maximum: usize,
) -> Result<String> {
    let key = content_address(&value);
    if !table.contains_key(&key) {
        limit(table.len() + 1, max)?;
        limit(value.len(), artifact_maximum)?;
        *byte_minimum += value.len();
        limit(*byte_minimum, artifact_maximum)?;
        table.insert(key.clone(), value);
    }
    Ok(key)
}
struct Encoder {
    limits: HViewEnvelopeLimits,
    nodes: usize,
    entries: usize,
    byte_minimum: usize,
    appearances: BTreeMap<String, Vec<u8>>,
    readings: BTreeMap<String, Vec<u8>>,
}
impl Encoder {
    fn node(&mut self, value: &HView, depth: usize) -> Result<CborValue> {
        limit(depth, self.limits.depth)?;
        self.nodes += 1;
        limit(self.nodes, self.limits.nodes)?;
        limit(value.props.len(), self.limits.buckets)?;
        limit(value.id.len(), self.limits.artifact_bytes)?;
        self.byte_minimum += value.id.len();
        limit(self.byte_minimum, self.limits.artifact_bytes)?;
        let mut props = Vec::new();
        for (key, bucket) in &value.props {
            limit(key.len(), self.limits.artifact_bytes)?;
            self.byte_minimum += key.len();
            limit(self.byte_minimum, self.limits.artifact_bytes)?;
            self.entries += bucket.len();
            limit(self.entries, self.limits.entries)?;
            let mut entries = Vec::new();
            for entry in bucket {
                let appearance = table_add(
                    &mut self.appearances,
                    original(&entry.delta, self.limits)?,
                    self.limits.appearances,
                    &mut self.byte_minimum,
                    self.limits.artifact_bytes,
                )?;
                let mut expanded = Vec::new();
                let mut readings = Vec::new();
                for (slot, child) in &entry.expanded {
                    valid_slot(&entry.delta, *slot)?;
                    expanded.push(map(vec![
                        ("index", CborValue::Float(*slot as f64)),
                        ("child", self.node(child, depth + 1)?),
                    ]));
                }
                for (slot, reading) in &entry.readings {
                    valid_slot(&entry.delta, *slot)?;
                    if !entry.expanded.contains_key(slot) {
                        return Err(INVALID);
                    }
                    let key = table_add(
                        &mut self.readings,
                        encode_reading_appearance(reading, self.limits.reading())?,
                        self.limits.readings,
                        &mut self.byte_minimum,
                        self.limits.artifact_bytes,
                    )?;
                    readings.push(map(vec![
                        ("index", CborValue::Float(*slot as f64)),
                        ("reading", string(key)),
                    ]));
                }
                entries.push(map(vec![
                    ("appearance", string(appearance)),
                    ("negated", CborValue::Bool(entry.negated)),
                    ("expanded", CborValue::Array(expanded)),
                    ("readings", CborValue::Array(readings)),
                ]));
            }
            props.push((key.clone(), CborValue::Array(entries)));
        }
        Ok(map(vec![
            ("id", string(&value.id)),
            ("props", CborValue::Map(props)),
        ]))
    }
}
fn records(values: BTreeMap<String, Vec<u8>>) -> CborValue {
    CborValue::Array(
        values
            .into_iter()
            .map(|(k, v)| map(vec![("key", string(k)), ("value", CborValue::Bstr(v))]))
            .collect(),
    )
}
pub fn encode_hview_envelope(view: &HView, limits: HViewEnvelopeLimits) -> Result<Vec<u8>> {
    let limits = limits.validate()?;
    let mut encoder = Encoder {
        limits,
        nodes: 0,
        entries: 0,
        byte_minimum: 0,
        appearances: BTreeMap::new(),
        readings: BTreeMap::new(),
    };
    let root = encoder.node(view, 1)?;
    let result = encode(&map(vec![
        ("format", string("rhizomatic.hview-envelope/1")),
        ("root", root),
        ("appearances", records(encoder.appearances)),
        ("readings", records(encoder.readings)),
    ]));
    limit(result.len(), limits.artifact_bytes)?;
    Ok(result)
}
fn table<T>(
    value: &CborValue,
    mut parse: impl FnMut(&[u8]) -> Result<T>,
) -> Result<BTreeMap<String, T>> {
    let mut result = BTreeMap::new();
    let mut prior = "";
    for record in array(value)? {
        let fs = fields(record, &["key", "value"])?;
        let key = content_id(text(get(&fs, "key")?)?)?;
        let payload = bytes(get(&fs, "value")?)?;
        if key <= prior || key != content_address(payload) {
            return Err(INVALID);
        }
        prior = key;
        result.insert(key.into(), parse(payload)?);
    }
    Ok(result)
}
fn slots<T>(
    value: &CborValue,
    key: &str,
    mut parse: impl FnMut(&CborValue) -> Result<T>,
) -> Result<BTreeMap<usize, T>> {
    let mut result = BTreeMap::new();
    let mut prior = None;
    for item in array(value)? {
        let fs = fields(item, &["index", key])?;
        let CborValue::Float(slot) = get(&fs, "index")? else {
            return Err(INVALID);
        };
        if !slot.is_finite()
            || *slot < 0.0
            || slot.fract() != 0.0
            || *slot > 9_007_199_254_740_991.0
            || *slot > usize::MAX as f64
        {
            return Err(INVALID);
        }
        let slot = *slot as usize;
        if prior.is_some_and(|p| slot <= p) {
            return Err(INVALID);
        }
        prior = Some(slot);
        result.insert(slot, parse(get(&fs, key)?)?);
    }
    Ok(result)
}
struct Decoder {
    appearances: BTreeMap<String, Delta>,
    readings: BTreeMap<String, Schema>,
    used_appearances: BTreeSet<String>,
    used_readings: BTreeSet<String>,
}
impl Decoder {
    fn node(&mut self, value: &CborValue) -> Result<HView> {
        let fs = fields(value, &["id", "props"])?;
        let mut props = BTreeMap::new();
        for (key, bucket) in fields(get(&fs, "props")?, &[])? {
            let mut entries = Vec::new();
            for entry in array(bucket)? {
                let es = fields(entry, &["appearance", "negated", "expanded", "readings"])?;
                let key = content_id(text(get(&es, "appearance")?)?)?;
                let delta = self.appearances.get(key).ok_or(INVALID)?.clone();
                self.used_appearances.insert(key.into());
                let CborValue::Bool(negated) = get(&es, "negated")? else {
                    return Err(INVALID);
                };
                let expanded = slots(get(&es, "expanded")?, "child", |v| self.node(v))?;
                let readings = slots(get(&es, "readings")?, "reading", |v| {
                    let key = content_id(text(v)?)?;
                    self.used_readings.insert(key.into());
                    self.readings.get(key).cloned().ok_or(INVALID)
                })?;
                for slot in expanded.keys() {
                    valid_slot(&delta, *slot)?;
                }
                for slot in readings.keys() {
                    valid_slot(&delta, *slot)?;
                    if !expanded.contains_key(slot) {
                        return Err(INVALID);
                    }
                }
                entries.push(HVEntry {
                    delta,
                    negated: *negated,
                    expanded,
                    readings,
                });
            }
            props.insert(key.into(), entries);
        }
        Ok(HView {
            id: text(get(&fs, "id")?)?.into(),
            props,
        })
    }
}
pub fn decode_hview_envelope(input: &[u8], limits: HViewEnvelopeLimits) -> Result<HView> {
    let limits = limits.validate()?;
    let mut nodes = 0;
    let mut entries = 0;
    let raw = canonical_guard(input, limits.artifact_bytes, &mut |path, is_map, len| {
        use CborPathPart::{Index, Key};
        if !is_map && path.len() == 1 {
            if path == [Key("appearances".into())] {
                limit(len, limits.appearances)?;
            }
            if path == [Key("readings".into())] {
                limit(len, limits.readings)?;
            }
        }
        let child = matches!(path.last(),Some(Key(k))if k=="child")
            && matches!(path.get(path.len().wrapping_sub(2)), Some(Index(_)))
            && matches!(path.get(path.len().wrapping_sub(3)),Some(Key(k))if k=="expanded");
        if is_map && (path == [Key("root".into())] || child) {
            nodes += 1;
            limit(nodes, limits.nodes)?;
            let depth = 1 + path
                .windows(3)
                .filter(|p| {
                    matches!(&p[0],Key(k)if k=="expanded")
                        && matches!(p[1], Index(_))
                        && matches!(&p[2],Key(k)if k=="child")
                })
                .count();
            limit(depth, limits.depth)?;
        }
        if is_map && matches!(path.last(),Some(Key(k))if k=="props") {
            limit(len, limits.buckets)?;
        }
        if !is_map && matches!(path.get(path.len().wrapping_sub(2)),Some(Key(k))if k=="props") {
            entries += len;
            limit(entries, limits.entries)?;
        }
        Ok(())
    })?;
    let fs = fields(&raw, &["format", "root", "appearances", "readings"])?;
    if text(get(&fs, "format")?)? != "rhizomatic.hview-envelope/1" {
        return Err(INVALID);
    }
    let appearances = table(get(&fs, "appearances")?, |v| delta_from_bytes(v, limits))?;
    let readings = table(get(&fs, "readings")?, |v| {
        decode_reading_appearance(v, limits.reading())
    })?;
    let mut decoder = Decoder {
        appearances,
        readings,
        used_appearances: BTreeSet::new(),
        used_readings: BTreeSet::new(),
    };
    let result = decoder.node(get(&fs, "root")?)?;
    if decoder.used_appearances.len() != decoder.appearances.len()
        || decoder.used_readings.len() != decoder.readings.len()
    {
        return Err(INVALID);
    }
    if encode_hview_envelope(&result, limits)? != input {
        return Err(INVALID);
    }
    Ok(result)
}
