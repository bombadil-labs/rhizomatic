//! Following the feed (SPEC-18 proposal §4.6, "Following the feed"; §4.13 readings 55 to 74): a
//! pull cursor over one peer's change feed. A follower starts from a read, takes
//! [`position_of`] its snapshot, and brings what it read up to date one page per [`FeedCursor::pull`].
//! There is no push and no mode that starts at the beginning of the feed.
//!
//! A pull delivers the bytes only of ids the peer still holds at the pull's snapshot (SPEC-4
//! ERRATA V6). `resync-required` is final for a cursor: the caller reads its state again and
//! follows from the new read.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::store::{
    Admission, AppendResult, ChangePage, ChangeRecord, PeerErasure, PeerStore, PurgeReport,
    Revision, Snapshot, StoreError, StoreErrorCode, VerifiedDelta, LOCAL_HISTORY_PREFIX,
    MAX_REVISION,
};
use crate::store_conformance::{FollowReader, Follower};
use crate::store_fresh::{
    answered_only, checked_through, json_revision, on_snapshots, FeedError, StoreFault,
};

/// How many snapshots one pull takes at most: it starts again on `snapshot-moved` three times,
/// as `check_fresh` does (SPEC-18 §4.13 reading 63).
pub const FOLLOW_SNAPSHOTS: usize = 4;

/// Where a follower stands in one history of one peer: what it saves between runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Position {
    pub history: String,
    pub revision: Revision,
}

impl Position {
    /// The object `parse_position` reads back.
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "history": self.history, "revision": self.revision.0 })
    }
}

/// Where a read on this snapshot stands: its history and revision. The only start of a follower
/// (§4.13 reading 55).
pub fn position_of(snapshot: &dyn Snapshot) -> Position {
    Position {
        history: snapshot.history().to_string(),
        revision: snapshot.revision(),
    }
}

fn malformed(reason: &str) -> StoreError {
    StoreError::new(
        StoreErrorCode::InvalidRequest,
        format!("position: {reason}"),
    )
}

/// A position a cursor can stand at: a non-empty history and a revision from 0 to 2^53 − 1.
fn checked(position: Position) -> Result<Position, StoreError> {
    if position.history.is_empty() {
        return Err(malformed("history is empty"));
    }
    if position.revision.0 > MAX_REVISION {
        return Err(malformed("revision is not an integer from 0 to 2^53 - 1"));
    }
    Ok(position)
}

/// The checking parser, for a position that was stored and read back (§4.6, "Positions across a
/// process"; reading 65). It takes exactly `history` and `revision`, in that order of checks:
/// the keys, the history (non-empty, then not local to a process), then the revision. A revision
/// written `3.0` is the integer 3; `1.5` is refused. Every refusal is `invalid-request`.
pub fn parse_position(value: &Value) -> Result<Position, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| malformed("a position is an object"))?;
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != ["history", "revision"] {
        return Err(malformed("a position has exactly history and revision"));
    }
    let history = object["history"]
        .as_str()
        .ok_or_else(|| malformed("history is not a string"))?;
    if history.is_empty() {
        return Err(malformed("history is empty"));
    }
    if history.starts_with(LOCAL_HISTORY_PREFIX) {
        return Err(malformed(&format!(
            "history {history} is local to the process that made it; a position kept across processes needs a history from mintHistory (MemoryStore::with_history_mint)"
        )));
    }
    let revision = json_revision(&object["revision"])
        .ok_or_else(|| malformed("revision is not an integer from 0 to 2^53 - 1"))?;
    checked(Position {
        history: history.to_string(),
        revision: Revision(revision),
    })
}

/// What one pull answers (§4.6).
#[derive(Debug, Clone, PartialEq)]
pub enum Pull {
    /// The page the pull read, and the bytes of every id it adds that the peer holds at the
    /// pull's snapshot, ascending by id, each once, with this peer's arrival record there.
    /// `position` is `{history, through}`, where the cursor now stands.
    Ok {
        position: Position,
        records: Vec<ChangeRecord>,
        deltas: Vec<VerifiedDelta>,
    },
    /// The position no longer names a revision of this feed. `current` is the position of the
    /// snapshot the pull read. Final for the cursor.
    ResyncRequired { current: Position },
}

/// A pull cursor over one peer's feed. It holds its handle: a borrowed one from [`follow_feed`],
/// or one the conformance runner gives it. Pulls take it mutably, so they run one at a time
/// (§4.13 reading 64).
pub struct FeedCursor<'a> {
    peer: Box<dyn PeerStore + 'a>,
    position: Position,
    resync: Option<Position>,
}

impl std::fmt::Debug for FeedCursor<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FeedCursor")
            .field("peer", &self.peer.id())
            .field("position", &self.position)
            .field("resync", &self.resync)
            .finish()
    }
}

/// A cursor over `peer`'s feed from `from`. It makes no store call. Refuses `invalid-request`
/// for an empty history or a revision above 2^53 − 1. A history local to the process is allowed:
/// a cursor inside the process that read it is sound (reading 65).
pub fn follow_feed<'a>(
    peer: &'a dyn PeerStore,
    from: Position,
) -> Result<FeedCursor<'a>, StoreError> {
    cursor(Box::new(Borrowed(peer)), from)
}

/// A borrowed handle, so a cursor can own what it reads through.
struct Borrowed<'a>(&'a dyn PeerStore);

impl PeerStore for Borrowed<'_> {
    fn id(&self) -> &str {
        self.0.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.0.erasure()
    }
    fn history(&self) -> &str {
        self.0.history()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.0.read()
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.0.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.0.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        self.0.changes(from, to)
    }
}

fn cursor<'a>(peer: Box<dyn PeerStore + 'a>, from: Position) -> Result<FeedCursor<'a>, StoreError> {
    Ok(FeedCursor {
        position: checked(from)?,
        peer,
        resync: None,
    })
}

impl FeedCursor<'_> {
    /// Where the cursor stands. Only an ok pull moves it.
    pub fn position(&self) -> &Position {
        &self.position
    }

    /// One pull (§4.6, "One pull"): one snapshot s; another history, or a position past s,
    /// answers `resync-required` with s's position and no feed call; equal revisions answer ok
    /// with no records and no feed call; otherwise one `changes(position, s.revision)` and one
    /// page, then `get` and `arrivals` of the page's added ids on s when it adds any, then the
    /// release. After `resync-required` every pull answers the same with no store call.
    ///
    /// On `snapshot-moved`, from `read` itself or a later call, it starts again on a new
    /// snapshot, at most [`FOLLOW_SNAPSHOTS`] in all, each released. An error leaves the cursor
    /// where it stood, and the cursor stays usable.
    ///
    /// A store that breaks its contract is a [`FeedError::Fault`], found before anything the
    /// store answered is used (§4.13 readings 46, 63 and 68): a page with no progress
    /// (`no-progress`), a page whose `through` is past s's revision (`past-the-bound`), a `get` or
    /// `arrivals` that answers an id it was not asked for, twice, or out of order (`unasked-ids`),
    /// and a `get` and `arrivals` that name other ids (`mismatched-answers`). It never panics on
    /// a store fault.
    pub fn pull(&mut self) -> Result<Pull, FeedError> {
        if let Some(current) = &self.resync {
            return Ok(Pull::ResyncRequired {
                current: current.clone(),
            });
        }
        let pulled = on_snapshots(self.peer.as_ref(), FOLLOW_SNAPSHOTS, |snapshot| {
            self.pull_on(snapshot)
        })?;
        match &pulled {
            Pull::Ok { position, .. } => self.position = position.clone(),
            Pull::ResyncRequired { current } => self.resync = Some(current.clone()),
        }
        Ok(pulled)
    }

    fn pull_on(&self, snapshot: &dyn Snapshot) -> Result<Pull, FeedError> {
        let at = position_of(snapshot);
        let from = self.position.revision;
        if at.history != self.position.history || at.revision < from {
            return Ok(Pull::ResyncRequired { current: at });
        }
        if at.revision == from {
            return Ok(Pull::Ok {
                position: self.position.clone(),
                records: Vec::new(),
                deltas: Vec::new(),
            });
        }
        let (records, through) = match self.peer.changes(from, Some(at.revision))? {
            ChangePage::ResyncRequired { .. } => return Ok(Pull::ResyncRequired { current: at }),
            ChangePage::Ok { records, through } => (records, through),
        };
        checked_through(from, at.revision, through)?;
        let ids: Vec<String> = records
            .iter()
            .flat_map(|r| &r.added)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .cloned()
            .collect();
        let deltas = match ids.is_empty() {
            true => Vec::new(),
            false => {
                let deltas = snapshot.get(&ids)?;
                let arrivals = snapshot.arrivals(&ids)?;
                // Bytes the call did not ask for are never handed out: they may be a purged
                // delta's.
                let got: Vec<String> = deltas.iter().map(|d| d.id.clone()).collect();
                let dated: Vec<String> = arrivals.iter().map(|a| a.id.clone()).collect();
                answered_only("get", &ids, got.clone())?;
                answered_only("arrivals", &ids, dated.clone())?;
                if got != dated {
                    return Err(StoreFault::MismatchedAnswers {
                        get: got,
                        arrivals: dated,
                    }
                    .into());
                }
                deltas
                    .into_iter()
                    .zip(arrivals)
                    .map(|(delta, arrival)| VerifiedDelta { delta, arrival })
                    .collect()
            }
        };
        Ok(Pull::Ok {
            position: Position {
                history: at.history,
                revision: through,
            },
            records,
            deltas,
        })
    }
}

impl Follower for FeedCursor<'_> {
    fn position(&self) -> Position {
        self.position.clone()
    }

    fn pull(&mut self) -> Result<Pull, FeedError> {
        FeedCursor::pull(self)
    }
}

/// This witness's follower, as the conformance runner calls it (`vectors/store/README.md` §10):
/// `position_of` and `follow_feed`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StoreFollow;

impl FollowReader for StoreFollow {
    fn position_of(&self, snapshot: &dyn Snapshot) -> Position {
        position_of(snapshot)
    }

    fn follow<'a>(
        &self,
        peer: Box<dyn PeerStore + 'a>,
        from: Position,
    ) -> Result<Box<dyn Follower + 'a>, StoreError> {
        Ok(Box::new(cursor(peer, from)?))
    }
}
