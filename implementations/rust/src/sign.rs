//! Ed25519 signing & verification (SPEC-1 §5, ERRATA D8-D9). Mirrors ../ts/src/sign.ts.
//! Deterministic (RFC 8032): signature bytes are reproducible across implementations.

use crate::delta::compute_id;
use crate::types::{Claims, Delta};
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::scalar::Scalar;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha512};

pub const AUTHOR_PREFIX: &str = "ed25519:";

fn signing_key_from_seed(seed_hex: &str) -> Result<SigningKey, String> {
    let bytes = hex::decode(seed_hex).map_err(|e| format!("bad seed hex: {e}"))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "seed must be exactly 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn public_key_from_seed(seed_hex: &str) -> Result<String, String> {
    Ok(hex::encode(
        signing_key_from_seed(seed_hex)?.verifying_key().to_bytes(),
    ))
}

/// The author string a signed delta MUST carry for this seed (ERRATA D8).
pub fn author_for_seed(seed_hex: &str) -> Result<String, String> {
    Ok(format!(
        "{AUTHOR_PREFIX}{}",
        public_key_from_seed(seed_hex)?
    ))
}

/// Sign claims, producing a complete delta. Refuses to sign claims whose author does not match
/// the signing key — a signature contradicting its own author field is born broken (ERRATA D8).
pub fn sign_claims(claims: &Claims, seed_hex: &str) -> Result<Delta, String> {
    let expected = author_for_seed(seed_hex)?;
    if claims.author != expected {
        return Err(format!(
            "author must be {expected} for this signing key, got {}",
            claims.author
        ));
    }
    let id = compute_id(claims)?;
    let id_bytes = hex::decode(&id).expect("compute_id emits valid hex");
    let sig = signing_key_from_seed(seed_hex)?.sign(&id_bytes);
    Ok(Delta {
        id,
        claims: claims.clone(),
        sig: Some(hex::encode(sig.to_bytes())),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    Verified,
    Unsigned,
    Invalid,
}

/// Decompress a 32-byte point encoding, accepting only the canonical spelling: the bytes must
/// decompress to a curve point AND recompress to the identical bytes (SPEC-1 §5.1 checks 2/3).
fn decode_canonical_point(bytes: &[u8; 32]) -> Option<curve25519_dalek::edwards::EdwardsPoint> {
    let point = CompressedEdwardsY(*bytes).decompress()?;
    if point.compress().to_bytes() != *bytes {
        return None;
    }
    Some(point)
}

/// The SPEC-1 §5.1 strict criterion (ERRATA D13), implemented check by check — deliberately NOT
/// a library default, because "strict" varies subtly between libraries and the spec text is the
/// criterion. Pinned by vectors/l0-delta/deltas-sig-edge.json.
fn verify_sig_strict(sig: &[u8], msg: &[u8], pubkey: &[u8]) -> bool {
    if sig.len() != 64 || pubkey.len() != 32 {
        return false;
    }
    let r_bytes: [u8; 32] = sig[..32].try_into().expect("length checked");
    let s_bytes: [u8; 32] = sig[32..].try_into().expect("length checked");
    let a_bytes: [u8; 32] = pubkey.try_into().expect("length checked");
    // 1. canonical scalar: S < L
    let Some(s) = Option::<Scalar>::from(Scalar::from_canonical_bytes(s_bytes)) else {
        return false;
    };
    // 2./3. canonical point encodings
    let (Some(a), Some(r)) = (
        decode_canonical_point(&a_bytes),
        decode_canonical_point(&r_bytes),
    ) else {
        return false;
    };
    // 4. no small-order components
    if a.is_small_order() || r.is_small_order() {
        return false;
    }
    // 5. cofactorless equation: [S]B = R + [k]A, k = SHA-512(R ‖ A ‖ M) mod L
    let mut h = Sha512::new();
    h.update(r_bytes);
    h.update(a_bytes);
    h.update(msg);
    let k = Scalar::from_bytes_mod_order_wide(&h.finalize().into());
    ED25519_BASEPOINT_POINT * s == r + a * k
}

/// Full verification per ERRATA D9: content addressing must hold, then the signature must verify
/// over the raw id bytes against the key named in `author`, under the §5.1 strict criterion.
pub fn verify_delta(delta: &Delta) -> Verification {
    match compute_id(&delta.claims) {
        Ok(id) if id == delta.id => {}
        _ => return Verification::Invalid,
    }
    let Some(sig_hex) = &delta.sig else {
        return Verification::Unsigned;
    };
    let Some(pub_hex) = delta.claims.author.strip_prefix(AUTHOR_PREFIX) else {
        return Verification::Invalid;
    };
    let (Ok(pub_bytes), Ok(sig_bytes), Ok(id_bytes)) = (
        hex::decode(pub_hex),
        hex::decode(sig_hex),
        hex::decode(&delta.id),
    ) else {
        return Verification::Invalid;
    };
    if verify_sig_strict(&sig_bytes, &id_bytes, &pub_bytes) {
        Verification::Verified
    } else {
        Verification::Invalid
    }
}
