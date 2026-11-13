//! Freshness (SPEC-18 proposal §4.6, "Freshness check", "The window", "History"; §4.13 readings
//! 24 to 45): a capture of what one anchored read depended on, the pure function [`touching`],
//! and [`check_fresh`] over a peer's change feed.
//!
//! A [`Capture`] has private fields and exactly two constructors, [`make_capture`] and
//! [`parse_capture`], and both check every rule of §4.6. So `touching` and `check_fresh` answer
//! only for a checked capture by construction: no copy, cast or unparsed value can reach them
//! (§4.13 reading 42). Neither constructor sorts or repairs (reading 40).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::store::{
    negated_ids, target_entities, Anchor, ChangePage, ChangeRecord, PeerStore, Revision, Snapshot,
    StoreError, StoreErrorCode, LOCAL_HISTORY_PREFIX, MAX_REVISION,
};
use crate::types::Delta;

/// How many snapshots `check_fresh` takes at most: it starts again on `snapshot-moved` three
/// times (SPEC-18 §4.13 reading 35).
pub const FRESHNESS_SNAPSHOTS: usize = 4;

/// The validity window of a read's operand at its `now` (SPEC-18 §4.6, "The window"). `since` is
/// the greatest `validFrom` or `validUntil` at or before `now`, and `expires_at` the least strictly
/// after it. A bound that is `None` is open.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ValidityWindow {
    pub since: Option<f64>,
    pub expires_at: Option<f64>,
}

/// The window of these deltas at `now`. Negators count like every other delta: pass the whole
/// operand, never what a store returned.
pub fn validity_window<'a>(
    deltas: impl IntoIterator<Item = &'a Delta>,
    now: f64,
) -> ValidityWindow {
    let mut window = ValidityWindow::default();
    for delta in deltas {
        let claims = &delta.claims;
        for bound in std::iter::once(claims.valid_from).chain(claims.valid_until) {
            if bound <= now {
                window.since = Some(window.since.map_or(bound, |s| s.max(bound)));
            } else {
                window.expires_at = Some(window.expires_at.map_or(bound, |e| e.min(bound)));
            }
        }
    }
    window
}

/// Every boundary of these deltas, ascending and distinct, for answering windows by search.
pub fn validity_boundaries<'a>(deltas: impl IntoIterator<Item = &'a Delta>) -> Vec<f64> {
    let mut bounds: Vec<f64> = deltas
        .into_iter()
        .flat_map(|delta| std::iter::once(delta.claims.valid_from).chain(delta.claims.valid_until))
        .collect();
    bounds.sort_by(f64::total_cmp);
    bounds.dedup();
    bounds
}

/// The window at `now` over boundaries that `validity_boundaries` sorted. O(log boundaries).
pub fn window_at(boundaries: &[f64], now: f64) -> ValidityWindow {
    let after = boundaries.partition_point(|&bound| bound <= now);
    ValidityWindow {
        since: after.checked_sub(1).map(|at| boundaries[at]),
        expires_at: boundaries.get(after).copied(),
    }
}

/// What one anchored read depended on in the store (SPEC-18 §4.6). It holds ids, never bytes. Its
/// fields are private and checked by both constructors; a built capture cannot be changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
    history: String,
    revision: Revision,
    anchors: Vec<Anchor>,
    members: Vec<String>,
    since: Option<f64>,
    expires_at: Option<f64>,
}

fn malformed(reason: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidRequest, format!("capture: {reason}"))
}

fn strictly_ascending<'a>(mut items: impl Iterator<Item = &'a str>) -> bool {
    let Some(mut last) = items.next() else {
        return true;
    };
    for item in items {
        if item <= last {
            return false;
        }
        last = item;
    }
    true
}

fn entity(anchor: &Anchor) -> &str {
    match anchor {
        Anchor::Entity { entity } => entity,
    }
}

fn checked(
    history: String,
    revision: Revision,
    anchors: Vec<Anchor>,
    members: Vec<String>,
    since: Option<f64>,
    expires_at: Option<f64>,
) -> Result<Capture, StoreError> {
    if history.is_empty() {
        return Err(malformed("history is empty"));
    }
    if revision.0 > MAX_REVISION {
        return Err(malformed("revision is not an integer from 0 to 2^53 - 1"));
    }
    // A Rust `String` orders by its UTF-8 bytes.
    if !strictly_ascending(anchors.iter().map(entity)) {
        return Err(malformed(
            "anchors is not strictly ascending by UTF-8 bytes",
        ));
    }
    if !strictly_ascending(members.iter().map(String::as_str)) {
        return Err(malformed(
            "members is not strictly ascending by UTF-8 bytes",
        ));
    }
    if since.is_some_and(|s| !s.is_finite()) {
        return Err(malformed("since is not null or a finite number"));
    }
    if expires_at.is_some_and(|e| !e.is_finite()) {
        return Err(malformed("expiresAt is not null or a finite number"));
    }
    if let (Some(s), Some(e)) = (since, expires_at) {
        if s >= e {
            return Err(malformed("since is not below expiresAt"));
        }
    }
    Ok(Capture {
        history,
        revision,
        anchors,
        members,
        since,
        expires_at,
    })
}

/// The maker (SPEC-18 §4.6): a capture of a live snapshot. `history` and `revision` are read
/// from `snapshot`, the snapshot the read ran on; `anchors` are the read's whole scope and
/// `members` its raw scope, each strictly ascending by UTF-8 bytes; the window is the operand's.
/// Refuses `invalid-request` with a reason that starts `capture: `. It does not sort. A history
/// local to the process is allowed here.
///
/// It is not a way to reload a stored capture: that comes back only through [`parse_capture`],
/// which refuses a process-local history. A host that fabricates a snapshot to feed stored values
/// to this maker defeats that refusal and can get a false `current`.
pub fn make_capture(
    snapshot: &dyn Snapshot,
    anchors: Vec<Anchor>,
    members: Vec<String>,
    window: ValidityWindow,
) -> Result<Capture, StoreError> {
    checked(
        snapshot.history().to_string(),
        snapshot.revision(),
        anchors,
        members,
        window.since,
        window.expires_at,
    )
}

/// The anchor kinds of SPEC-18 §4.7.1 that a capture cannot hold yet. A stored capture that
/// names one is well formed and refused `capability-absent`; another kind is malformed. Slice 6
/// defines their fields, so only the kind is read.
const OTHER_ANCHOR_KINDS: [&str; 2] = ["value", "derived-index"];

/// A revision as JSON writes it: an integer from 0 to 2^53 − 1. JSON has one number type, so
/// `1.0` is the integer 1; `1.5` is not an integer.
fn json_revision(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let n = value.as_f64()?;
    let whole = n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= MAX_REVISION as f64;
    whole.then_some(n as u64)
}

/// The checking parser, for a capture that was stored and read back (SPEC-18 §4.6). It takes the
/// JSON object [`Capture::to_json`] writes: exactly `history`, `revision`, `anchors`, `members`,
/// `since` and `expiresAt`. It checks what `make_capture` checks, and also refuses another shape
/// and a history local to one process. It checks shape, not truth: a host that keeps captures
/// where it does not trust what is at rest protects their integrity itself.
pub fn parse_capture(value: &Value) -> Result<Capture, StoreError> {
    const KEYS: [&str; 6] = [
        "anchors",
        "expiresAt",
        "history",
        "members",
        "revision",
        "since",
    ];
    let object = value
        .as_object()
        .ok_or_else(|| malformed("a capture is an object"))?;
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != KEYS {
        return Err(malformed(
            "a capture has exactly history, revision, anchors, members, since and expiresAt",
        ));
    }
    let history = object["history"]
        .as_str()
        .ok_or_else(|| malformed("history is not a string"))?;
    if history.starts_with(LOCAL_HISTORY_PREFIX) {
        return Err(malformed(&format!(
            "history {history} is local to the process that made it; a capture kept across processes needs a history from mintHistory (MemoryStore::with_history_mint)"
        )));
    }
    let revision = json_revision(&object["revision"])
        .ok_or_else(|| malformed("revision is not an integer from 0 to 2^53 - 1"))?;
    let anchors = object["anchors"]
        .as_array()
        .ok_or_else(|| malformed("anchors is not a list"))?
        .iter()
        .map(|anchor| {
            let fields = anchor
                .as_object()
                .ok_or_else(|| malformed("an anchor is not an object"))?;
            match fields.get("kind").and_then(Value::as_str) {
                Some("entity") => {}
                Some(kind) if OTHER_ANCHOR_KINDS.contains(&kind) => {
                    return Err(StoreError::new(
                        StoreErrorCode::CapabilityAbsent,
                        format!("capture: a {kind} anchor; this witness reads entity anchors only"),
                    ))
                }
                Some(_) => {
                    return Err(malformed(
                        "an anchor's kind is not entity, value or derived-index",
                    ))
                }
                None => return Err(malformed("an anchor has no kind")),
            }
            if fields.len() != 2 {
                return Err(malformed("an entity anchor has exactly kind and entity"));
            }
            let entity = fields
                .get("entity")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("an entity anchor has no entity string"))?;
            Ok(Anchor::Entity {
                entity: entity.to_string(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let members = object["members"]
        .as_array()
        .ok_or_else(|| malformed("members is not a list"))?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_string)
                .ok_or_else(|| malformed("members holds a value that is not a string"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let bound = |key: &str| -> Result<Option<f64>, StoreError> {
        match &object[key] {
            Value::Null => Ok(None),
            Value::Number(n) => Ok(n.as_f64()),
            _ => Err(malformed(&format!("{key} is not null or a finite number"))),
        }
    };
    checked(
        history.to_string(),
        Revision(revision),
        anchors,
        members,
        bound("since")?,
        bound("expiresAt")?,
    )
}

impl Capture {
    pub fn history(&self) -> &str {
        &self.history
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    /// The read's whole scope, ascending by UTF-8 bytes, each once.
    pub fn anchors(&self) -> &[Anchor] {
        &self.anchors
    }

    /// The raw scope S(anchors over H) at `revision`, ascending, each once.
    pub fn members(&self) -> &[String] {
        &self.members
    }

    pub fn since(&self) -> Option<f64> {
        self.since
    }

    pub fn expires_at(&self) -> Option<f64> {
        self.expires_at
    }

    /// The object `parse_capture` reads back.
    pub fn to_json(&self) -> Value {
        let bound = |b: Option<f64>| b.map_or(Value::Null, Value::from);
        serde_json::json!({
            "history": self.history,
            "revision": self.revision.0,
            "anchors": self.anchors.iter().map(|a| serde_json::json!({
                "kind": "entity",
                "entity": entity(a),
            })).collect::<Vec<_>>(),
            "members": self.members,
            "since": bound(self.since),
            "expiresAt": bound(self.expires_at),
        })
    }

    fn holds(&self, id: &str) -> bool {
        self.members
            .binary_search_by(|member| member.as_str().cmp(id))
            .is_ok()
    }

    fn anchored_at(&self, target: &str) -> bool {
        self.anchors
            .binary_search_by(|anchor| entity(anchor).cmp(target))
            .is_ok()
    }
}

/// Why a change touches a capture (SPEC-18 §4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchReason {
    RemovedMember,
    TargetsAnchor,
    NegatesMember,
}

impl TouchReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RemovedMember => "removed-member",
            Self::TargetsAnchor => "targets-anchor",
            Self::NegatesMember => "negates-member",
        }
    }
}

/// The first change that touches a capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Touch {
    pub revision: Revision,
    pub id: String,
    pub reason: TouchReason,
}

/// The first touch of these records on the capture, or `None` (SPEC-18 §4.6, §4.13 readings 31
/// and 32). `records` are the change records with `capture.revision < revision ≤ r′`, ascending;
/// `added` holds, by id, the delta of every id in some record's `added` that the peer still
/// holds at r′. Records in order; within one record `removed` before `added`, each list in its
/// own order; for one delta, `targets-anchor` before `negates-member`. An added id absent from
/// `added` is no longer held and touches nothing. Pure; each test is a binary search.
pub fn touching(
    capture: &Capture,
    records: &[ChangeRecord],
    added: &BTreeMap<String, Delta>,
) -> Option<Touch> {
    let touch = |revision: Revision, id: &str, reason| Touch {
        revision,
        id: id.to_string(),
        reason,
    };
    for record in records {
        if let Some(id) = record.removed.iter().find(|id| capture.holds(id)) {
            return Some(touch(record.revision, id, TouchReason::RemovedMember));
        }
        for id in &record.added {
            let Some(delta) = added.get(id) else { continue };
            if target_entities(&delta.claims)
                .into_iter()
                .any(|target| capture.anchored_at(target))
            {
                return Some(touch(record.revision, id, TouchReason::TargetsAnchor));
            }
            if negated_ids(&delta.claims)
                .into_iter()
                .any(|negated| capture.holds(negated))
            {
                return Some(touch(record.revision, id, TouchReason::NegatesMember));
            }
        }
    }
    None
}

/// What `check_fresh` answers (SPEC-18 §4.6).
#[derive(Debug, Clone, PartialEq)]
pub enum Freshness {
    /// Unchanged at the snapshot the check read, and valid at `now`.
    Current,
    /// A change since the capture touches it.
    Stale(Touch),
    /// `now` is before the window: `now < since`.
    NotYet { since: f64 },
    /// `now` is at or after the window's end: `now ≥ expires_at`.
    Expired { expires_at: f64 },
    /// The capture cannot be judged: another history, a later revision than the peer's, or a
    /// feed that no longer keeps the records since it. `current` is the peer's revision.
    ResyncRequired { current: Revision },
}

impl Freshness {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Stale(_) => "stale",
            Self::NotYet { .. } => "not-yet",
            Self::Expired { .. } => "expired",
            Self::ResyncRequired { .. } => "resync-required",
        }
    }
}

/// Releases a snapshot when it goes out of scope, on every path.
struct Held(Box<dyn Snapshot>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// Whether a capture is still what a read at `now` would depend on (SPEC-18 §4.6, §4.13 readings
/// 33 to 35). One `read`; with another history, nothing more; with a revision r′ below the
/// capture's, `resync-required`; with r′ above it, `changes(capture.revision, r′)` page by page,
/// one `get` of each page's added ids on the snapshot before the page is judged, and no call after
/// the first touch. The answers in order: `resync-required`, `stale`, `not-yet`, `expired`,
/// `current`. On `snapshot-moved` it starts again on a new snapshot, at most
/// [`FRESHNESS_SNAPSHOTS`] in all; each is released. Its calls depend on the records and ids since
/// the capture, never on the holdings or on records before the capture. Refuses
/// `invalid-request` for a `now` that is not finite.
///
/// # Panics
///
/// Panics when a page of the feed makes no progress short of r′. That page cannot vouch for the
/// rest of the range, so the store broke the change feed contract (§4.6, "Pages"); no code of
/// the shared vocabulary names a store fault, and a verdict would hide it (§4.13 reading 46).
pub fn check_fresh(
    peer: &dyn PeerStore,
    capture: &Capture,
    now: f64,
) -> Result<Freshness, StoreError> {
    if !now.is_finite() {
        return Err(StoreError::new(
            StoreErrorCode::InvalidRequest,
            "checkFresh needs a now that is a finite number",
        ));
    }
    let mut taken = 0;
    loop {
        taken += 1;
        match check_on_one_snapshot(peer, capture, now) {
            Err(e) if e.code == StoreErrorCode::SnapshotMoved && taken < FRESHNESS_SNAPSHOTS => {}
            other => return other,
        }
    }
}

fn check_on_one_snapshot(
    peer: &dyn PeerStore,
    capture: &Capture,
    now: f64,
) -> Result<Freshness, StoreError> {
    let snapshot = Held(peer.read()?);
    let at_read = snapshot.0.revision();
    if snapshot.0.history() != capture.history {
        return Ok(Freshness::ResyncRequired { current: at_read });
    }
    if at_read < capture.revision {
        return Ok(Freshness::ResyncRequired { current: at_read });
    }
    let mut at = capture.revision;
    while at < at_read {
        let (records, through) = match peer.changes(at, Some(at_read))? {
            ChangePage::ResyncRequired { current } => {
                return Ok(Freshness::ResyncRequired { current })
            }
            ChangePage::Ok { records, through } => (records, through),
        };
        let ids: BTreeSet<&String> = records.iter().flat_map(|r| &r.added).collect();
        let added: BTreeMap<String, Delta> = match ids.is_empty() {
            true => BTreeMap::new(),
            false => {
                let ids: Vec<String> = ids.into_iter().cloned().collect();
                snapshot
                    .0
                    .get(&ids)?
                    .into_iter()
                    .map(|delta| (delta.id.clone(), delta))
                    .collect()
            }
        };
        if let Some(touch) = touching(capture, &records, &added) {
            return Ok(Freshness::Stale(touch));
        }
        // A store fault, not a verdict: such a page cannot vouch for the rest of the range.
        assert!(
            through > at,
            "checkFresh: the store's page from {} made no progress toward {}; the store breaks the change feed contract (SPEC-18 §4.6)",
            at.0,
            at_read.0
        );
        at = through;
    }
    Ok(match (capture.since, capture.expires_at) {
        (Some(since), _) if now < since => Freshness::NotYet { since },
        (_, Some(expires_at)) if now >= expires_at => Freshness::Expired { expires_at },
        _ => Freshness::Current,
    })
}

/// The raw scope of these entities on one snapshot (SPEC-18 §4.13 reading 29): `targets` of the
/// entities once, then `negators` of each new layer until a layer adds nothing. It asks for each
/// member once, so it costs O(|members| × log N) in closure depth plus one calls. Ascending.
pub fn raw_scope(snapshot: &dyn Snapshot, entities: &[String]) -> Result<Vec<String>, StoreError> {
    let mut members: BTreeSet<String> = BTreeSet::new();
    let mut layer: Vec<String> = snapshot
        .targets(entities)?
        .into_iter()
        .filter(|id| members.insert(id.clone()))
        .collect();
    while !layer.is_empty() {
        layer = snapshot
            .negators(&layer)?
            .into_iter()
            .filter(|id| members.insert(id.clone()))
            .collect();
    }
    Ok(members.into_iter().collect())
}
