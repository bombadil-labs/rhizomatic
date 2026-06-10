//! Deterministic CBOR encoder — Rhizomatic v0 profile (spec/01-delta.ERRATA.md D1-D4).
//! Must reproduce ../ts/src/cbor.ts byte-for-byte.

use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq)]
pub enum CborValue {
    Tstr(String),
    Float(f64),
    Bool(bool),
    Array(Vec<CborValue>),
    /// text-string keys; sorted at encode time (ERRATA D4)
    Map(Vec<(String, CborValue)>),
}

pub fn encode(value: &CborValue) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(&mut out, value);
    out
}

/// CBOR head: major type (high 3 bits) plus unsigned argument, shortest form.
fn write_head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let mt = major << 5;
    if arg < 24 {
        out.push(mt | arg as u8);
    } else if arg < 0x100 {
        out.push(mt | 24);
        out.push(arg as u8);
    } else if arg < 0x1_0000 {
        out.push(mt | 25);
        out.extend_from_slice(&(arg as u16).to_be_bytes());
    } else if arg <= 0xffff_ffff {
        out.push(mt | 26);
        out.extend_from_slice(&(arg as u32).to_be_bytes());
    } else {
        out.push(mt | 27);
        out.extend_from_slice(&arg.to_be_bytes());
    }
}

// ERRATA D1: numbers encode as float only; f32 when it round-trips exactly, else f64.
// (-0.0 normalized to +0.0; float16 reduction deferred to M0.x.)
fn write_float(out: &mut Vec<u8>, value: f64) {
    assert!(
        value.is_finite(),
        "non-finite number is not representable: {value}"
    );
    let n = value + 0.0; // normalize -0 to +0
    if (n as f32) as f64 == n {
        out.push(0xfa);
        out.extend_from_slice(&(n as f32).to_be_bytes());
    } else {
        out.push(0xfb);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn encode_into(out: &mut Vec<u8>, value: &CborValue) {
    match value {
        CborValue::Tstr(s) => {
            let normalized: String = s.nfc().collect();
            let bytes = normalized.as_bytes();
            write_head(out, 3, bytes.len() as u64);
            out.extend_from_slice(bytes);
        }
        CborValue::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
        CborValue::Float(n) => write_float(out, *n),
        CborValue::Array(items) => {
            write_head(out, 4, items.len() as u64);
            for item in items {
                encode_into(out, item);
            }
        }
        CborValue::Map(entries) => {
            // ERRATA D4: sort entries by bytewise lex order of the encoded key.
            let mut encoded: Vec<(Vec<u8>, &CborValue)> = entries
                .iter()
                .map(|(k, v)| {
                    let mut kb = Vec::new();
                    encode_into(&mut kb, &CborValue::Tstr(k.clone()));
                    (kb, v)
                })
                .collect();
            encoded.sort_by(|a, b| a.0.cmp(&b.0));
            for w in encoded.windows(2) {
                assert!(w[0].0 != w[1].0, "duplicate map key in canonical CBOR");
            }
            write_head(out, 5, encoded.len() as u64);
            for (kb, v) in encoded {
                out.extend_from_slice(&kb);
                encode_into(out, v);
            }
        }
    }
}
