//! The holdings digest (SPEC-18 proposal §4.7.6; §4.13 readings 139 to 142). A tree over the hex
//! digits of the held ids: the node of a prefix covers the held ids that start with it. A node of
//! at most 16 ids is a leaf, whose hash is over its ids in ascending order; any other node has 16
//! children, one per next digit, and its hash is over their counts and hashes. The node of every
//! prefix is defined by the set of ids alone, so two stores that hold one set give one root,
//! whatever the order the ids arrived in. TypeScript's `digest.ts` is the same tree.
//!
//! Each hash is the content address of one canonical CBOR array whose first item is a tag of its
//! own. A delta id is the content address of a CBOR map, so a leaf, a node and a delta never hash
//! the same bytes. The digest holds ids only: no claims, no payload and no arrival data.

use std::collections::BTreeSet;

use crate::cbor::{encode, CborValue};
use crate::hash::content_address;
use crate::store::{StoreError, StoreErrorCode};
use crate::types::VOCAB_PREFIX;

/// One node of the holdings digest: how many held ids share its prefix, and its hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestNode {
    pub count: u64,
    pub hash: String,
}

/// A node of at most this many ids is a leaf.
pub const DIGEST_LEAF: usize = 16;

const DIGITS: &[u8; 16] = b"0123456789abcdef";

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// The value of a lowercase hex digit.
fn digit(byte: u8) -> Option<usize> {
    match byte {
        b'0'..=b'9' => Some(usize::from(byte - b'0')),
        b'a'..=b'f' => Some(usize::from(byte - b'a') + 10),
        _ => None,
    }
}

/// True for a content address: `1e20` and 64 lowercase hex digits, the form of every delta id.
fn is_id(id: &str) -> bool {
    id.len() == 68 && id.starts_with("1e20") && id.bytes().all(lower_hex)
}

/// True for a prefix a digest call takes: lowercase hex digits, the empty string too.
pub(crate) fn is_digest_prefix(prefix: &str) -> bool {
    prefix.bytes().all(lower_hex)
}

/// The hash of a leaf over its ids, ascending. The leaf of no id is the empty node.
pub(crate) fn leaf_hash(ids: &[String]) -> String {
    content_address(&encode(&CborValue::Array(vec![
        CborValue::Tstr(format!("{VOCAB_PREFIX}.digest.leaf")),
        CborValue::Array(ids.iter().map(|id| CborValue::Tstr(id.clone())).collect()),
    ])))
}

/// The hash of a node over its 16 children, in digit order. A count is a CBOR number, as the
/// delta profile encodes numbers.
pub(crate) fn node_hash(children: &[DigestNode]) -> String {
    let pairs = children
        .iter()
        .map(|child| {
            CborValue::Array(vec![
                CborValue::Float(child.count as f64),
                CborValue::Tstr(child.hash.clone()),
            ])
        })
        .collect();
    content_address(&encode(&CborValue::Array(vec![
        CborValue::Tstr(format!("{VOCAB_PREFIX}.digest.node")),
        CborValue::Array(pairs),
    ])))
}

/// The hash of the leaf of no id, `leaf_hash(&[])`: `hash.empty` of `vectors/store/digest.json`.
/// A constant, because an update hashes it for every empty child of a node it rewrites.
const EMPTY_HASH: &str = "1e2053de1e1f40b83d7b30c20ec4c558637d025871f74c48d245ec58be7901006d3b";

/// The node of a prefix that no held id starts with, and the root of an empty peer.
pub fn empty_digest() -> DigestNode {
    DigestNode {
        count: 0,
        hash: EMPTY_HASH.to_string(),
    }
}

/// The 16 children of a prefix, in digit order.
pub(crate) fn children_of(prefix: &str) -> Vec<String> {
    DIGITS
        .iter()
        .map(|d| format!("{prefix}{}", char::from(*d)))
        .collect()
}

/// The ids grouped by the digit at `depth`, in digit order; each keeps its order. An id with no
/// hex digit there is in no group.
fn by_digit(ids: &[String], depth: usize) -> Vec<Vec<String>> {
    let mut groups = vec![Vec::new(); 16];
    for id in ids {
        if let Some(d) = id.as_bytes().get(depth).copied().and_then(digit) {
            groups[d].push(id.clone());
        }
    }
    groups
}

/// A stored node: a leaf keeps its ids, ascending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DigestRow {
    pub(crate) count: u64,
    pub(crate) hash: String,
    pub(crate) ids: Option<Vec<String>>,
}

impl DigestRow {
    pub(crate) fn node(&self) -> DigestNode {
        DigestNode {
            count: self.count,
            hash: self.hash.clone(),
        }
    }
}

/// The node of `prefix` over `ids`, which start with it, ascending. With `into`, each node it
/// visits that holds an id is written there, children before their parent.
fn node_of(
    ids: &[String],
    prefix: &str,
    mut into: Option<&mut Vec<(String, DigestRow)>>,
) -> DigestNode {
    let count = ids.len() as u64;
    if ids.len() <= DIGEST_LEAF {
        let node = DigestNode {
            count,
            hash: leaf_hash(ids),
        };
        if let (Some(into), false) = (into, ids.is_empty()) {
            into.push((
                prefix.to_string(),
                DigestRow {
                    count,
                    hash: node.hash.clone(),
                    ids: Some(ids.to_vec()),
                },
            ));
        }
        return node;
    }
    let groups = by_digit(ids, prefix.len());
    let children: Vec<DigestNode> = children_of(prefix)
        .iter()
        .zip(&groups)
        .map(|(child, group)| node_of(group, child, into.as_deref_mut()))
        .collect();
    let node = DigestNode {
        count,
        hash: node_hash(&children),
    };
    if let Some(into) = into {
        into.push((
            prefix.to_string(),
            DigestRow {
                count,
                hash: node.hash.clone(),
                ids: None,
            },
        ));
    }
    node
}

/// The ids once each, ascending by their bytes.
fn canonical(ids: &[String]) -> Vec<String> {
    ids.iter()
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

/// The node of `prefix` over a set of ids: the reference that every store's `digest` answers.
/// Refuses `invalid-request` for a prefix that is not lowercase hex digits and for an id that is
/// not `1e20` and 64 lowercase hex digits. Costs O(n log n).
pub fn digest_of(ids: &[String], prefix: &str) -> Result<DigestNode, StoreError> {
    if !is_digest_prefix(prefix) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidRequest,
            "digest: a prefix is a string of lowercase hex digits",
        ));
    }
    if !ids.iter().all(|id| is_id(id)) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidRequest,
            "digest: an id is `1e20` and 64 lowercase hex digits",
        ));
    }
    let under: Vec<String> = canonical(ids)
        .into_iter()
        .filter(|id| id.starts_with(prefix))
        .collect();
    Ok(node_of(&under, prefix, None))
}

/// Every node a store keeps for a set of ids, children before their parent: the root when it
/// holds an id, and each child of a node of more than 16 ids that holds an id. A leaf keeps its
/// ids. A prefix below a leaf has no row; its node is the leaf over the leaf's ids that start
/// with it.
pub(crate) fn digest_rows(ids: &[String]) -> Vec<(String, DigestRow)> {
    let mut rows = Vec::new();
    node_of(&canonical(ids), "", Some(&mut rows));
    rows
}

/// The stored rows of one peer's digest, as the update reads and writes them. `held` answers
/// the ids the peer holds now that start with `prefix`, ascending; the update calls it only
/// where the answer is at most 16 ids plus the ids of the change that start with `prefix`.
pub(crate) trait DigestStore {
    fn rows(&mut self, prefixes: &[String]) -> Vec<Option<DigestNode>>;
    fn held(&mut self, prefix: &str) -> Vec<String>;
    fn put(&mut self, prefix: &str, node: &DigestNode, leaf: Option<&[String]>);
    fn drop_row(&mut self, prefix: &str);
    /// Drops every stored row whose prefix starts with `prefix` and is longer.
    fn drop_under(&mut self, prefix: &str);
}

/// Brings a peer's stored digest from its holdings before a change to its holdings after it, and
/// answers the new root. `added` are the ids the change made held, `removed` the ids it
/// released; the holdings already include the change. It visits the path of each changed id,
/// and each node that splits or merges: O(depth × 16) row reads per changed id, never the whole
/// peer.
pub(crate) fn update_digest(
    rows: &mut dyn DigestStore,
    added: &[String],
    removed: &[String],
) -> DigestNode {
    let root = rows.rows(&[String::new()]).pop().flatten();
    visit(
        rows,
        "",
        Some(root.map_or(0, |r| r.count)),
        &canonical(added),
        &canonical(removed),
    )
}

/// The new node of `prefix`. `was` is its count before the change when it was a node of the
/// stored tree, and `None` when it lay below a leaf. Children are written before their parent,
/// so a read of the rows above or below a node sees them as they were before the change.
fn visit(
    rows: &mut dyn DigestStore,
    prefix: &str,
    was: Option<u64>,
    added: &[String],
    removed: &[String],
) -> DigestNode {
    let mut ids = was.is_none().then(|| rows.held(prefix));
    // A damaged count can make this negative; it then takes the leaf path, which counts the ids.
    let count = match (&ids, was) {
        (Some(ids), _) => ids.len() as i128,
        (None, was) => i128::from(was.unwrap_or(0)) + added.len() as i128 - removed.len() as i128,
    };
    let internal = was.is_some_and(|was| was > DIGEST_LEAF as u64);
    let mut leaf = None;
    let node = if count <= DIGEST_LEAF as i128 {
        let ids = ids.take().unwrap_or_else(|| rows.held(prefix));
        // A leaf has no row below it. The rows below are dropped whatever the stored count says,
        // so a damaged count or a lost row cannot keep a row that hashes a released id (reading
        // 142). The leaf takes its count from the holdings it read, so a damaged count above it
        // cannot make a write fail: an append or a purge completes, and `fsck` reports the damage.
        rows.drop_under(prefix);
        let node = DigestNode {
            count: ids.len() as u64,
            hash: leaf_hash(&ids),
        };
        leaf = Some(ids);
        node
    } else {
        let names = children_of(prefix);
        let stored = if internal {
            rows.rows(&names)
        } else {
            vec![None; 16]
        };
        let more = by_digit(added, prefix.len());
        let less = by_digit(removed, prefix.len());
        let mut children = Vec::with_capacity(16);
        for (i, name) in names.iter().enumerate() {
            let (a, r) = (&more[i], &less[i]);
            if internal && a.is_empty() && r.is_empty() {
                children.push(stored[i].clone().unwrap_or_else(empty_digest));
                continue;
            }
            let was = internal.then(|| stored[i].as_ref().map_or(0, |s| s.count));
            children.push(visit(rows, name, was, a, r));
        }
        DigestNode {
            count: count as u64,
            hash: node_hash(&children),
        }
    };
    if node.count == 0 {
        rows.drop_row(prefix);
    } else {
        rows.put(prefix, &node, leaf.as_deref());
    }
    node
}
