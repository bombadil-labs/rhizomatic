//! Several reads at one revision (SPEC-18 proposal §4.13, readings 127 to 129). A snapshot holds
//! no engine transaction (decision S4-2), so a purge that releases a holding between two calls
//! moves it, and each later call refuses `snapshot-moved`. `with_snapshot` runs the reads again
//! on a new snapshot. It is a reader over the store contract: a store implements nothing for it.
//! The rules follow the TypeScript `src/storage/with-snapshot.ts` line by line.

use crate::store::{PeerStore, Snapshot, StoreError, StoreErrorCode};
use crate::store_fresh::{revision_in_range, FeedError, StoreFault};

/// How many times a read starts again on a new snapshot after `snapshot-moved`, by default.
pub const SNAPSHOT_RETRIES: usize = 3;

/// The most snapshots one call of [`with_snapshot`] may take.
const MOST_SNAPSHOTS: usize = 16;

/// The largest `within_ms`: 2^53 − 1, the largest integer every witness carries exactly.
const MOST_WITHIN_MS: u64 = (1 << 53) - 1;

/// How far [`with_snapshot`] tries. `SnapshotRetry::default()` is 4 snapshots and no bound in
/// time.
#[derive(Clone, Copy)]
pub struct SnapshotRetry<'a> {
    /// Snapshots in all, a refused `read()` included: from 1 to 16.
    pub snapshots: usize,
    /// No snapshot after the first starts once this many ms of `clock` have passed since the
    /// call began: at most 2^53 − 1. The first snapshot always starts, and a running body is
    /// never stopped. It needs `clock`. `None` is no bound in time.
    pub within_ms: Option<u64>,
    /// The host's clock in ms, read only for `within_ms`. The crate reads no clock of its own. A
    /// reading below the first is refused.
    pub clock: Option<&'a dyn Fn() -> f64>,
}

impl Default for SnapshotRetry<'_> {
    fn default() -> Self {
        Self {
            snapshots: SNAPSHOT_RETRIES + 1,
            within_ms: None,
            clock: None,
        }
    }
}

/// What [`with_snapshot`] answers: the body's value, and how many snapshots it took.
#[derive(Debug, Clone, PartialEq)]
pub struct OnSnapshot<T> {
    pub value: T,
    /// Snapshots taken, a `read()` that the peer refused included. 1 when the first held still.
    /// The `attempt` that the body gets counts the same way, so a body after a refused `read()`
    /// gets 2.
    pub attempts: usize,
}

/// An error that may carry a store refusal. [`with_snapshot`] starts the body again only when
/// its code is `snapshot-moved`.
pub trait StoreRefusal {
    /// The store refusal code, when this is one.
    fn store_code(&self) -> Option<StoreErrorCode>;
}

impl StoreRefusal for StoreError {
    fn store_code(&self) -> Option<StoreErrorCode> {
        Some(self.code)
    }
}

impl StoreRefusal for FeedError {
    fn store_code(&self) -> Option<StoreErrorCode> {
        match self {
            Self::Refused(e) => Some(e.code),
            _ => None,
        }
    }
}

fn refuse(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidRequest, message)
}

/// The bound of one call: the snapshots, and the bound in time with its clock.
type Policy<'a> = (usize, Option<(u64, &'a dyn Fn() -> f64)>);

fn policy<'a>(retry: &SnapshotRetry<'a>) -> Result<Policy<'a>, StoreError> {
    let SnapshotRetry {
        snapshots,
        within_ms,
        clock,
    } = *retry;
    if !(1..=MOST_SNAPSHOTS).contains(&snapshots) {
        return Err(refuse(format!(
            "with_snapshot: snapshots is an integer from 1 to {MOST_SNAPSHOTS}"
        )));
    }
    if within_ms.is_some_and(|ms| ms > MOST_WITHIN_MS) {
        return Err(refuse(
            "with_snapshot: within_ms is an integer from 0 to 2^53 - 1".into(),
        ));
    }
    match (within_ms, clock) {
        (Some(_), None) => Err(refuse(
            "with_snapshot: within_ms needs clock, the host's clock in ms".into(),
        )),
        (Some(ms), Some(clock)) => Ok((snapshots, Some((ms, clock)))),
        (None, _) => Ok((snapshots, None)),
    }
}

/// One reading of the host's clock. A reading that is not a finite number, or that is below
/// `since`, is refused. A panic of the clock passes up unchanged.
fn reading(clock: &dyn Fn() -> f64, since: f64) -> Result<f64, StoreError> {
    let at = clock();
    if !at.is_finite() {
        return Err(refuse(
            "with_snapshot: clock answered no finite number".into(),
        ));
    }
    if at < since {
        return Err(refuse(format!(
            "with_snapshot: clock answered {at}, below {since}, its reading when the call began"
        )));
    }
    Ok(at)
}

/// Releases a snapshot when it goes out of scope, on every path.
struct Held(Box<dyn Snapshot>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// Runs `body` on one snapshot of `peer`, and releases the snapshot on every path. The
/// snapshot's revision is checked first (`revision-out-of-range`). On `snapshot-moved`, from
/// `read()` itself or from `body`, it runs `body` again on a new snapshot, within `retry`; past
/// the bound the last `snapshot-moved` passes up. Any other error passes up at once, unchanged:
/// `store-unavailable` too, because the engine has already waited. A `snapshot-moved` of another
/// peer's snapshot that `body` reads starts it again too. A refused clock reading passes up after
/// the snapshot is released, and so does a panic of the clock. A refused `retry` reads nothing.
///
/// `body` reads only, through the snapshot it is given. It keeps nothing from an earlier attempt,
/// and its side effects go after this returns: it can run up to `retry.snapshots` times. A purge
/// of the same peer inside it moves its own snapshot; an append does not (§4.13 reading 130).
pub fn with_snapshot<T, E>(
    peer: &dyn PeerStore,
    mut body: impl FnMut(&dyn Snapshot, usize) -> Result<T, E>,
    retry: &SnapshotRetry<'_>,
) -> Result<OnSnapshot<T>, E>
where
    E: From<StoreError> + From<StoreFault> + StoreRefusal,
{
    let (snapshots, within) = policy(retry)?;
    let started = match within {
        Some((_, clock)) => reading(clock, f64::NEG_INFINITY)?,
        None => 0.0,
    };
    let again = |attempts: usize| -> Result<bool, StoreError> {
        Ok(attempts < snapshots
            && match within {
                None => true,
                Some((ms, clock)) => reading(clock, started)? - started < ms as f64,
            })
    };
    let moved = |e: &E| e.store_code() == Some(StoreErrorCode::SnapshotMoved);
    let mut attempts = 1;
    loop {
        let snapshot = match peer.read() {
            Ok(snapshot) => Held(snapshot),
            Err(e) if e.code == StoreErrorCode::SnapshotMoved && again(attempts)? => {
                attempts += 1;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let answer = revision_in_range(snapshot.0.revision())
            .map_err(|fault| fault.into())
            .and_then(|()| body(snapshot.0.as_ref(), attempts));
        match answer {
            Ok(value) => return Ok(OnSnapshot { value, attempts }),
            Err(e) if moved(&e) && again(attempts)? => attempts += 1,
            Err(e) => return Err(e),
        }
    }
}
