//! An admission built from a snapshot, for a host that keeps no journal (SPEC-18 proposal §4.13
//! reading 133). A journal peer builds its own frame and next head; the store only commits them.
//! The rules follow the TypeScript `src/storage/admission.ts` line by line. The checks that
//! TypeScript needs for values of the wrong type (a list that is not a list, a lone surrogate, a
//! fraction) are not representable here.

use std::collections::BTreeMap;

use crate::delta::compute_id;
use crate::store::{
    signature_form, Admission, ArrivalRecord, Snapshot, StoreError, StoreErrorCode, VerifiedDelta,
    MAX_ARRIVAL_COUNTER,
};
use crate::types::Delta;

/// What [`admission_of`] cannot read from a snapshot. Every field is required, so the type has
/// no `Default`.
#[derive(Debug, Clone, PartialEq)]
pub struct AdmissionOptions {
    /// The receiver's clock when the deltas arrive, in ms. A finite number.
    pub at: f64,
    /// `local`, `unattributed` or the sending peer's id (SPEC-6 §3). Not empty.
    pub sender: String,
    /// The head this append commits. There is no default: a made-up head could be taken for a
    /// journal head. Choose one the peer never had, so an admission built on an older snapshot
    /// answers `Conflict`.
    pub next_head: String,
}

/// An [`Admission`] of `deltas` on the snapshot's state: `expected_head` is the snapshot's head,
/// `frame` is `None`, the arrival sequences start at `snapshot.last_sequence() + 1` in ascending
/// id order (SPEC-6 §3), one per distinct id, and every arrival record carries the transfer
/// ordinal `snapshot.last_transfer() + 1`, `at` and `sender`. Every entry is checked as the store
/// checks it, a repeat of an id too: its id recomputes from its claims and its signature has the
/// store's form. Of a repeated id the first entry is kept. An empty list builds a head-only
/// append. It calls no snapshot query and does not check what the peer holds: an id the peer
/// already holds keeps the store's rule (it is skipped and its sequence is not used), so a host
/// that wants no gap passes only ids that `snapshot.get` does not answer. An append of this
/// admission after another commit that moved the head answers `Conflict`. After one that kept the
/// head it is refused `invalid-admission` when a new id's sequence or transfer does not pass the
/// peer's last one, and otherwise commits with sequences and a transfer above every committed
/// one. Refuses `invalid-request` for a malformed snapshot, delta or option, and for a sequence or
/// a transfer past 2^53 − 1.
pub fn admission_of(
    snapshot: &dyn Snapshot,
    deltas: &[Delta],
    options: AdmissionOptions,
) -> Result<Admission, StoreError> {
    let refuse = |what: &str| -> Result<Admission, StoreError> {
        Err(StoreError::new(
            StoreErrorCode::InvalidRequest,
            format!("admission_of: {what}"),
        ))
    };
    let head = snapshot.head();
    let last = snapshot.last_sequence();
    let last_transfer = snapshot.last_transfer();
    if head.is_some_and(str::is_empty) {
        return refuse("the snapshot's head is None or a non-empty string");
    }
    if last > MAX_ARRIVAL_COUNTER {
        return refuse("the snapshot's last_sequence is an integer from 0 to 2^53 − 1");
    }
    if last_transfer > MAX_ARRIVAL_COUNTER {
        return refuse("the snapshot's last_transfer is an integer from 0 to 2^53 − 1");
    }

    let AdmissionOptions {
        at,
        sender,
        next_head,
    } = options;
    if !at.is_finite() {
        return refuse("at is a finite number");
    }
    if sender.is_empty() {
        return refuse("sender is a non-empty string");
    }
    if next_head.is_empty() {
        return refuse("next_head is a non-empty string");
    }

    let mut own: BTreeMap<&str, &Delta> = BTreeMap::new();
    for delta in deltas {
        if compute_id(&delta.claims).ok().as_deref() != Some(delta.id.as_str()) {
            return refuse("a delta is malformed, or its id does not match its claims");
        }
        if delta.sig.as_deref().is_some_and(|sig| !signature_form(sig)) {
            return refuse("a signature is not 128 lowercase hex characters");
        }
        own.entry(delta.id.as_str()).or_insert(delta);
    }
    let count = own.len() as u64;
    if count > MAX_ARRIVAL_COUNTER - last {
        return refuse("the arrival sequences would pass 2^53 − 1");
    }
    if count > 0 && last_transfer >= MAX_ARRIVAL_COUNTER {
        return refuse("the transfer ordinal would pass 2^53 − 1");
    }
    let transfer = last_transfer + 1;
    let added = own
        .into_values()
        .zip(last + 1..)
        .map(|(delta, sequence)| VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: at + 0.0,
                sequence,
                transfer,
                sender: sender.clone(),
            },
        })
        .collect();
    Ok(Admission {
        expected_head: head.map(str::to_string),
        next_head,
        frame: None,
        added,
    })
}
