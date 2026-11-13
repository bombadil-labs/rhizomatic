//! Two right stores the freshness runs need (`vectors/store/README.md` §9.4, §8): one that
//! applies the whole selection in `scope` and reports nothing applied (run 6), and one whose
//! revisions are k times the reference's ("Stores that must pass").

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ChangePage, ChangeRecord, ErasurePosture, Exporter,
    PeerErasure, PeerStore, PurgeReport, PushdownFields, Revision, ScopeRequest, ScopeResult,
    Snapshot, Store, StoreError, StoreErrorCode, StoreProfile,
};
use rhizomatic::types::Delta;

/// A store whose `scope` applies every field it was asked for, as the memory store does, and
/// reports none applied, which SPEC-18 §4.3 allows.
pub struct ReportsNothingApplied {
    inner: MemoryStore,
}

impl ReportsNothingApplied {
    pub fn new(inner: MemoryStore) -> Self {
        Self { inner }
    }
}

/// How a wrapped handle changes what the memory store answers.
#[derive(Clone, Copy)]
enum Twist {
    ReportsNothing,
    Scale(u64),
}

impl Twist {
    fn scale(self) -> u64 {
        match self {
            Twist::Scale(k) => k,
            Twist::ReportsNothing => 1,
        }
    }
}

fn wrap(inner: Box<dyn PeerStore>, twist: Twist) -> Box<dyn PeerStore> {
    Box::new(Peer { inner, twist })
}

impl Store for ReportsNothingApplied {
    fn profile(&self) -> &StoreProfile {
        self.inner.profile()
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(wrap(self.inner.create_peer(id, e)?, Twist::ReportsNothing))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(wrap(self.inner.peer(id)?, Twist::ReportsNothing))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.inner.open_admin()
    }
    fn close(&self) {
        self.inner.close()
    }
}

/// A store whose revisions are `scale` times the reference's. `changes(from, to)` asks the
/// reference for `floor(from / k)` to `floor(to / k)`, and a complete page says `through` = the
/// clamped `to`. It refuses `to < from` itself, and answers `resync-required` itself for a `from`
/// above k times the reference's revision (README §8).
pub struct Scaled {
    inner: MemoryStore,
    scale: u64,
}

impl Scaled {
    pub fn new(inner: MemoryStore, scale: u64) -> Self {
        Self { inner, scale }
    }
}

impl Store for Scaled {
    fn profile(&self) -> &StoreProfile {
        self.inner.profile()
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(wrap(
            self.inner.create_peer(id, e)?,
            Twist::Scale(self.scale),
        ))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(wrap(self.inner.peer(id)?, Twist::Scale(self.scale)))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.inner.open_admin()
    }
    fn close(&self) {
        self.inner.close()
    }
}

struct Peer {
    inner: Box<dyn PeerStore>,
    twist: Twist,
}

impl Peer {
    fn out(&self, r: Revision) -> Revision {
        Revision(r.0 * self.twist.scale())
    }

    fn current(&self) -> Result<Revision, StoreError> {
        let mut snapshot = self.inner.read()?;
        let revision = snapshot.revision();
        snapshot.release();
        Ok(revision)
    }
}

impl PeerStore for Peer {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        let inner = self.inner.read()?;
        Ok(Box::new(Snap {
            revision: self.out(inner.revision()),
            inner,
            twist: self.twist,
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        match self.inner.append(batch)? {
            AppendResult::Committed { revision, added } => Ok(AppendResult::Committed {
                revision: self.out(revision),
                added,
            }),
            other => Ok(other),
        }
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        let mut report = self.inner.purge(ids)?;
        report.revision = self.out(report.revision);
        Ok(report)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        let k = self.twist.scale();
        if k == 1 {
            return self.inner.changes(from, to);
        }
        if to.is_some_and(|to| to < from) {
            return Err(StoreError::new(
                StoreErrorCode::InvalidRequest,
                "to is below from",
            ));
        }
        let current = self.out(self.current()?);
        if from > current {
            return Ok(ChangePage::ResyncRequired { current });
        }
        let down = |r: Revision| Revision(r.0 / k);
        match self.inner.changes(down(from), to.map(down))? {
            ChangePage::Ok { records, through } => {
                let end = to.map_or(current, |to| to.min(current));
                let inner_current = down(current);
                let complete =
                    through == to.map_or(inner_current, |to| down(to).min(inner_current));
                let records: Vec<ChangeRecord> = records
                    .into_iter()
                    .map(|record| ChangeRecord {
                        revision: self.out(record.revision),
                        ..record
                    })
                    .collect();
                let through = match (complete, records.last()) {
                    (false, Some(last)) => last.revision,
                    _ => end,
                };
                Ok(ChangePage::Ok { records, through })
            }
            ChangePage::ResyncRequired { current } => Ok(ChangePage::ResyncRequired {
                current: self.out(current),
            }),
        }
    }
}

struct Snap {
    inner: Box<dyn Snapshot>,
    revision: Revision,
    twist: Twist,
}

impl Snapshot for Snap {
    fn revision(&self) -> Revision {
        self.revision
    }
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        let mut answer = self.inner.scope(request)?;
        if let Twist::ReportsNothing = self.twist {
            answer.applied = PushdownFields::default();
        }
        Ok(answer)
    }
    fn release(&mut self) {
        self.inner.release()
    }
}

/// The memory store with a profile that declares no change feed.
pub struct DeclaresNoFeed {
    inner: MemoryStore,
    profile: StoreProfile,
}

impl DeclaresNoFeed {
    pub fn new(inner: MemoryStore) -> Self {
        let mut profile = inner.profile().clone();
        profile.change_retention = rhizomatic::store::ChangeRetention::None;
        Self { inner, profile }
    }
}

impl Store for DeclaresNoFeed {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        self.inner.create_peer(id, e)
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        self.inner.peer(id)
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.inner.open_admin()
    }
    fn close(&self) {
        self.inner.close()
    }
}
