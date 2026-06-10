//! BLAKE3-256 + multihash wrapping (SPEC-1 §4, ERRATA D7). Mirrors ../ts/src/hash.ts.

const BLAKE3_MULTICODEC: u8 = 0x1e;

/// id = multihash(BLAKE3-256(data)) as lowercase hex.
/// The multicodec (0x1e) and length (32 = 0x20) each fit a single-byte varint.
pub fn content_address(data: &[u8]) -> String {
    let digest = blake3::hash(data);
    let bytes = digest.as_bytes(); // &[u8; 32]
    let mut mh = Vec::with_capacity(2 + bytes.len());
    mh.push(BLAKE3_MULTICODEC);
    mh.push(bytes.len() as u8);
    mh.extend_from_slice(bytes);
    hex::encode(mh)
}
