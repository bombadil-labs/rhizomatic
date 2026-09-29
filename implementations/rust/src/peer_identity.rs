//! Canonical Ed25519 peer spelling and conservative identity comparison for untrusted sources.

pub fn is_canonical_peer_id(value: &str) -> bool {
    value.strip_prefix("ed25519:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    })
}

fn key_hex(value: &str) -> Option<String> {
    let raw = if value
        .get(.."ed25519:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ed25519:"))
    {
        &value["ed25519:".len()..]
    } else {
        value
    };
    (raw.len() == 64 && raw.bytes().all(|ch| ch.is_ascii_hexdigit()))
        .then(|| raw.to_ascii_lowercase())
}

/// Treat recognized public-key spellings as the same key, even before canonical validation.
pub fn same_peer_id(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    key_hex(a).is_some_and(|left| Some(left) == key_hex(b))
}
