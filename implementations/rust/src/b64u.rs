//! Canonical unpadded base64url (RFC 4648 §5) — the JSON-profile transport for a bytes target's
//! payload (SPEC-1 §4.2, ERRATA D12). Mirrors ../ts/src/b64u.ts. Identity is computed from the raw
//! bytes, never from this encoding; encoding is canonical by construction and decoding *validates*
//! canonicality (reject, never repair — SPEC-4 §2): no padding, alphabet only, length never ≡ 1
//! (mod 4), and a final character's unused low bits MUST be zero.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode raw bytes as canonical unpadded base64url.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

fn sextet(c: u8) -> Result<u32, String> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        // '=' padding lands here too — deliberately rejected (canonical form is unpadded).
        _ => return Err(format!("base64url: invalid character {:?}", c as char)),
    };
    Ok(v as u32)
}

/// Decode canonical unpadded base64url, rejecting any non-canonical input.
pub fn decode(s: &str) -> Result<Vec<u8>, String> {
    let bytes = s.as_bytes();
    if bytes.len() % 4 == 1 {
        return Err("base64url: invalid length (≡ 1 mod 4)".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    let mut i = 0;
    while i < bytes.len() {
        let group = &bytes[i..(i + 4).min(bytes.len())];
        let mut acc = 0u32;
        for &c in group {
            acc = (acc << 6) | sextet(c)?;
        }
        match group.len() {
            4 => {
                out.push((acc >> 16) as u8);
                out.push((acc >> 8) as u8);
                out.push(acc as u8);
            }
            3 => {
                // 18 bits carried; the last 2 are spill and MUST be zero.
                if acc & 0x3 != 0 {
                    return Err("base64url: non-canonical trailing bits".into());
                }
                let acc = acc >> 2;
                out.push((acc >> 8) as u8);
                out.push(acc as u8);
            }
            2 => {
                // 12 bits carried; the last 4 are spill and MUST be zero.
                if acc & 0xf != 0 {
                    return Err("base64url: non-canonical trailing bits".into());
                }
                out.push((acc >> 4) as u8);
            }
            _ => unreachable!("chunk of 0 or 1 impossible after the length check"),
        }
        i += 4;
    }
    Ok(out)
}
