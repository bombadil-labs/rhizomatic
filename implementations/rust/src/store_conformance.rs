//! The store conformance runner (SPEC-18 proposal §8): runs the shared store vectors against
//! any implementation of the store traits. `vectors/store/README.md` is the contract this file
//! follows; section numbers below are that page's. The runner reads no file: the caller hands
//! it the two parsed JSON documents.
//!
//! Every step asks the store first and judges the answer afterwards (§3.7). The runner answers
//! for the store only where this witness's types cannot hold the vector's value (`1.5`, `-1`, a
//! missing posture); a value a `u64` holds, 2^53 included, goes to the store. Each check has its
//! own message, and `tests/store_runner_rules.rs` holds the runner to every one (§8).
//!
//! On a store that serves a change feed, the runner keeps its own model of each peer's feed
//! (§3.9.2), checks that each commit wrote exactly its record (§3.9.3), and reads each peer's
//! whole kept feed after every step (§3.9.4). `tests/store_feed_rules.rs` holds those checks.
//! The shape checks of §3.9.3 (exact keys) hold by type here: `ChangeRecord` and `ChangePage`
//! have exactly the contract's fields, so no store can add a key.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::Value;

use crate::delta::compute_id;
use crate::json_profile::parse_claims;
use crate::store::{
    negated_ids, target_entities, Admission, Anchor, AppendResult, ArrivalRecord, ChangePage,
    ChangeRecord, ChangeRetention, ErasureClaim, ErasureClass, ErasurePosture, PeerStore, Pushdown,
    PushdownFields, Revision, ScopeRequest, ScopeResult, Snapshot, Store, StoreError,
    StoreErrorCode, StoreProfile, SurfaceState, VerifiedDelta, MAX_REVISION, PURGE_BOUNDARY,
};
use crate::types::Delta;

const SCRIPTS_FORMAT: &str = "rhizomatic-store-scripts/1";
const SCOPE_FORMAT: &str = "rhizomatic-store-scope/1";

/// The two shared vector documents, parsed: `vectors/store/scripts.json` and
/// `vectors/store/scope.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreVectors {
    pub scripts: Value,
    pub scope: Value,
}

/// A script the store's profile made the runner skip, and the requirement it lacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedScript {
    pub name: String,
    pub missing: String,
}

/// What ran. Names are `scripts/<script>` and `scope/<case>`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoreConformanceReport {
    pub passed: Vec<String>,
    pub skipped: Vec<SkippedScript>,
}

/// One failed script or scope case. `step` counts from 0 inside the script or the setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreConformanceFailure {
    pub name: String,
    pub step: Option<usize>,
    pub message: String,
}

/// Every failure of one run, with what still passed and what was skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreConformanceError {
    pub failures: Vec<StoreConformanceFailure>,
    pub report: StoreConformanceReport,
}

impl fmt::Display for StoreConformanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut text = format!(
            "store conformance: {} failed, {} passed, {} skipped",
            self.failures.len(),
            self.report.passed.len(),
            self.report.skipped.len()
        );
        for failure in &self.failures {
            let step = failure
                .step
                .map(|i| format!(" step {i}"))
                .unwrap_or_default();
            text.push_str(&format!("\n  {}{step}: {}", failure.name, failure.message));
        }
        f.write_str(&text)
    }
}

impl std::error::Error for StoreConformanceError {}

type Check<T = ()> = Result<T, String>;

fn field<'a>(v: &'a Value, key: &str) -> Check<&'a Value> {
    v.get(key)
        .ok_or_else(|| format!("the vector has no `{key}`"))
}

fn text<'a>(v: &'a Value, key: &str) -> Check<&'a str> {
    field(v, key)?
        .as_str()
        .ok_or_else(|| format!("`{key}` is not text"))
}

fn list<'a>(v: &'a Value, key: &str) -> Check<&'a Vec<Value>> {
    field(v, key)?
        .as_array()
        .ok_or_else(|| format!("`{key}` is not a list"))
}

fn texts(v: &Value, key: &str) -> Check<Vec<String>> {
    list(v, key)?
        .iter()
        .map(|x| {
            x.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("`{key}` holds a value that is not text"))
        })
        .collect()
}

fn whole(v: &Value, key: &str) -> Check<u64> {
    field(v, key)?
        .as_u64()
        .ok_or_else(|| format!("`{key}` is not a whole number"))
}

/// The common header of both files (§2).
struct Corpus {
    reference_format: String,
    peers: BTreeMap<String, String>,
    deltas: BTreeMap<String, Delta>,
}

impl Corpus {
    fn load(doc: &Value, format: &str) -> Check<Self> {
        if text(doc, "format")? != format {
            return Err(format!("the file is not {format}"));
        }
        let reference_format = text(field(doc, "reference")?, "formatVersion")?.to_string();
        let peers = field(doc, "peers")?
            .as_object()
            .ok_or("`peers` is not an object")?
            .iter()
            .map(|(name, id)| {
                Ok((
                    name.clone(),
                    id.as_str().ok_or("a peer id is not text")?.to_string(),
                ))
            })
            .collect::<Check<_>>()?;
        let mut deltas = BTreeMap::new();
        for entry in list(doc, "deltas")? {
            let name = text(entry, "name")?;
            let delta = Delta {
                id: text(entry, "id")?.to_string(),
                claims: parse_claims(field(entry, "claims")?)
                    .map_err(|e| format!("corpus delta {name}: {e}"))?,
                sig: entry.get("sig").and_then(Value::as_str).map(str::to_string),
            };
            let forged = entry.get("forged").and_then(Value::as_bool) == Some(true);
            if !forged && compute_id(&delta.claims).ok().as_deref() != Some(delta.id.as_str()) {
                return Err(format!("corpus delta {name}: the id does not recompute"));
            }
            if deltas.insert(name.to_string(), delta).is_some() {
                return Err(format!("corpus delta {name} is listed twice"));
            }
        }
        Ok(Self {
            reference_format,
            peers,
            deltas,
        })
    }

    fn delta(&self, name: &str) -> Check<&Delta> {
        self.deltas
            .get(name)
            .ok_or_else(|| format!("the corpus has no delta named {name}"))
    }

    fn id(&self, name: &str) -> Check<String> {
        Ok(self.delta(name)?.id.clone())
    }

    fn ids(&self, v: &Value, key: &str) -> Check<Vec<String>> {
        texts(v, key)?.iter().map(|name| self.id(name)).collect()
    }

    fn peer(&self, name: &str) -> Check<&str> {
        self.peers
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| format!("the file has no peer named {name}"))
    }
}

/// The pushdown fields, in the fixed order the vectors list them.
const FIELDS: [&str; 3] = ["timestampAtMost", "arrivalAtMost", "excludeIds"];

fn fields_of(p: &Pushdown) -> BTreeSet<&'static str> {
    let present = [
        p.timestamp_at_most.is_some(),
        p.arrival_at_most.is_some(),
        p.exclude_ids.is_some(),
    ];
    FIELDS
        .into_iter()
        .zip(present)
        .filter_map(|(name, on)| on.then_some(name))
        .collect()
}

fn flags_of(f: &PushdownFields) -> BTreeSet<&'static str> {
    let present = [f.timestamp_at_most, f.arrival_at_most, f.exclude_ids];
    FIELDS
        .into_iter()
        .zip(present)
        .filter_map(|(name, on)| on.then_some(name))
        .collect()
}

/// The selection restricted to some of its fields.
fn restrict(p: &Pushdown, keep: &BTreeSet<&str>) -> Pushdown {
    Pushdown {
        timestamp_at_most: p.timestamp_at_most.filter(|_| keep.contains(FIELDS[0])),
        arrival_at_most: p.arrival_at_most.filter(|_| keep.contains(FIELDS[1])),
        exclude_ids: p.exclude_ids.clone().filter(|_| keep.contains(FIELDS[2])),
    }
}

/// Whether a held delta passes every present field of a selection (§1.4.1).
fn passes(member: &VerifiedDelta, selection: &Pushdown) -> bool {
    selection
        .timestamp_at_most
        .is_none_or(|t| member.delta.claims.timestamp <= t)
        && selection
            .arrival_at_most
            .is_none_or(|n| member.arrival.sequence <= n)
        && selection
            .exclude_ids
            .as_ref()
            .is_none_or(|ids| !ids.contains(&member.delta.id))
}

/// S(A over D), computed from a plain list (§1.4.1). Ascending ids.
fn scope_over(entities: &BTreeSet<&str>, members: &[&VerifiedDelta]) -> Vec<String> {
    let mut scope: BTreeSet<&str> = members
        .iter()
        .filter(|m| !target_entities(&m.delta.claims).is_disjoint(entities))
        .map(|m| m.delta.id.as_str())
        .collect();
    loop {
        let more: Vec<&str> = members
            .iter()
            .filter(|m| !scope.contains(m.delta.id.as_str()))
            .filter(|m| !negated_ids(&m.delta.claims).is_disjoint(&scope))
            .map(|m| m.delta.id.as_str())
            .collect();
        if more.is_empty() {
            break;
        }
        scope.extend(more);
    }
    scope.into_iter().map(str::to_string).collect()
}

/// How many change records a store keeps per peer, as its profile declares (§1.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keep {
    /// `none`: the store serves no feed, and the runner makes no feed check.
    NoFeed,
    All,
    Last(u64),
    /// Not `none`, `unbounded` or `{revisions: n}` with n of 1 or more.
    Malformed,
}

impl Keep {
    fn of(retention: ChangeRetention) -> Self {
        match retention {
            ChangeRetention::None => Self::NoFeed,
            ChangeRetention::Unbounded => Self::All,
            ChangeRetention::Revisions(n) if n == 0 || n > MAX_REVISION => Self::Malformed,
            ChangeRetention::Revisions(n) => Self::Last(n),
        }
    }
}

/// The runner's model of one peer's feed (§3.9.2).
#[derive(Debug, Default)]
struct FeedModel {
    /// The revision at creation, then the revision after each advance.
    revisions: Vec<Revision>,
    /// One expected record per advance, also the ones a bounded store has dropped.
    records: Vec<ChangeRecord>,
    head: Option<String>,
    ever_held: BTreeSet<String>,
    /// Each record as a page read first returned it, by revision.
    seen: BTreeMap<Revision, ChangeRecord>,
}

impl FeedModel {
    fn current(&self) -> Revision {
        *self
            .revisions
            .last()
            .expect("a model starts with the revision at creation")
    }

    /// How many records the store dropped, and the floor: the revision at creation when it
    /// dropped none, and otherwise the revision of the newest dropped record.
    fn floor(&self, keep: Keep) -> (usize, Revision) {
        let kept = match keep {
            Keep::Last(n) => self.records.len().min(n as usize),
            _ => self.records.len(),
        };
        let dropped = self.records.len() - kept;
        (dropped, self.revisions[dropped])
    }

    /// A `resync-required` answer carries the peer's current revision.
    fn resync_current(&self, carried: Revision) -> Check {
        let current = self.current();
        if carried != current {
            return Err(format!(
                "a resync answer carries current {}, not the peer's revision {}",
                carried.0, current.0
            ));
        }
        Ok(())
    }

    fn record(&self, revision: Revision) -> Option<&ChangeRecord> {
        self.records
            .binary_search_by_key(&revision, |record| record.revision)
            .ok()
            .map(|at| &self.records[at])
    }

    /// Check 1 of §3.9.3 and check 4 of §3.9.5.
    fn names_only_held(&self, peer: &str, records: &[ChangeRecord]) -> Check {
        for record in records {
            for id in record.added.iter().chain(&record.removed) {
                if !self.ever_held.contains(id) {
                    return Err(format!(
                        "the feed of {peer} names {id}, which {peer} never held"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Check 2 of §3.9.3 and check 7 of §3.9.5.
fn ids_ascending(records: &[ChangeRecord]) -> Check {
    for record in records {
        for ids in [&record.added, &record.removed] {
            if ids.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err("a record's ids are not ascending and distinct".into());
            }
        }
    }
    Ok(())
}

fn changes_refused(e: StoreError) -> String {
    format!("changes refused with {}", e.code.as_str())
}

fn revisions_of(records: &[ChangeRecord]) -> Vec<u64> {
    records.iter().map(|record| record.revision.0).collect()
}

/// Checks 4 to 13 of §3.9.5 on one `ok` page read from `at`, with `end` the clamped `to`.
fn check_page(
    peer: &str,
    model: &mut FeedModel,
    at: Revision,
    end: Revision,
    records: &[ChangeRecord],
    through: Revision,
) -> Check {
    model.names_only_held(peer, records)?;
    if records
        .windows(2)
        .any(|pair| pair[0].revision >= pair[1].revision)
    {
        return Err("the page's records are not ascending by revision".into());
    }
    if records.iter().any(|r| r.revision <= at || r.revision > end) {
        return Err(format!(
            "a record lies outside the range ({}, {}]",
            at.0, end.0
        ));
    }
    ids_ascending(records)?;
    let last = records.last().map_or(at, |record| record.revision);
    if through < last || through > end {
        return Err(format!(
            "the page's through {} lies outside [{}, {}]",
            through.0, last.0, end.0
        ));
    }
    // The model is every record the peer ever wrote, dropped ones included.
    for expected in model.records.iter() {
        let r = expected.revision;
        if r > at && r <= last && !records.iter().any(|got| got.revision == r) {
            return Err(format!("the feed has no record for revision {}", r.0));
        }
        if r > last && r <= through {
            return Err(format!(
                "the page claims through {} and leaves out the record at {}",
                through.0, r.0
            ));
        }
    }
    if through <= at && at != end {
        return Err(format!(
            "the page from {} made no progress toward {}",
            at.0, end.0
        ));
    }
    if through != last && through != end {
        return Err(format!(
            "the page's through {} is past its last record and short of {}",
            through.0, end.0
        ));
    }
    for record in records {
        let r = record.revision;
        match model.seen.get(&r) {
            Some(first) if first != record => {
                return Err(format!(
                    "the record at revision {} changed after it was written",
                    r.0
                ))
            }
            Some(_) => {}
            None => {
                model.seen.insert(r, record.clone());
            }
        }
        if model.record(r) != Some(record) {
            return Err(format!(
                "the record at revision {} differs from its commit",
                r.0
            ));
        }
    }
    Ok(())
}

/// Check 14 of §3.9.5: the caller changes what `changes` returned and asks again. A Rust store
/// returns owned values, so a change to them cannot reach the store through the page; the check
/// still asks again. The second answer may be another prefix of the range (§4.13 reading 23):
/// only records that share a revision with the first answer must equal it, no revision appears
/// twice, and checks 4 to 13 run on it from the same `at`.
fn asked_again(
    store: &dyn PeerStore,
    peer: &str,
    model: &mut FeedModel,
    (at, to, end): (Revision, Option<Revision>, Revision),
    first: &[ChangeRecord],
) -> Check {
    let mut returned = first.to_vec();
    if let Some(copy) = returned.first().cloned() {
        returned.push(ChangeRecord {
            head: Some("tampered".into()),
            ..copy
        });
    }
    for record in &mut returned {
        record.head = Some("tampered".into());
        record.added.push("tampered".into());
        record.removed.push("tampered".into());
    }
    drop(returned);
    let differently =
        || "changes answered differently after the caller changed what it returned".to_string();
    let ChangePage::Ok { records, through } = store.changes(at, to).map_err(changes_refused)?
    else {
        return Err(differently());
    };
    let mut revisions = BTreeSet::new();
    for record in &records {
        let before = first.iter().find(|r| r.revision == record.revision);
        if before.is_some_and(|before| before != record) || !revisions.insert(record.revision) {
            return Err(differently());
        }
    }
    check_page(peer, model, at, end, &records, through)
}

/// What a read of pages ended with (§3.9.5).
enum Pages {
    Ok(Vec<ChangeRecord>),
    Resync,
}

/// Reads the pages from `from` to `to` and checks each one (§3.9.5).
fn read_pages(
    store: &dyn PeerStore,
    peer: &str,
    model: &mut FeedModel,
    from: Revision,
    to: Option<Revision>,
) -> Check<Pages> {
    let current = model.current();
    let end = to.map_or(current, |to| to.min(current));
    let mut at = from;
    let mut collected = Vec::new();
    loop {
        let (records, through) = match store.changes(at, to).map_err(changes_refused)? {
            ChangePage::ResyncRequired { current: c } if at == from => {
                model.resync_current(c)?;
                return Ok(Pages::Resync);
            }
            ChangePage::ResyncRequired { .. } => {
                return Err("changes answered resync-required in the middle of a range".into())
            }
            ChangePage::Ok { records, through } => (records, through),
        };
        check_page(peer, model, at, end, &records, through)?;
        asked_again(store, peer, model, (at, to, end), &records)?;
        collected.extend(records);
        if through == end {
            return Ok(Pages::Ok(collected));
        }
        at = through;
    }
}

/// One store under test, with the runner's own record of what each peer admitted (§3.3).
struct Run<'a> {
    corpus: &'a Corpus,
    store: Box<dyn Store>,
    profile: StoreProfile,
    reference: bool,
    /// Handle name to the peer name it belongs to and the handle. A peer's first handle has the
    /// peer's own name (§3.2).
    handles: BTreeMap<String, (String, Box<dyn PeerStore>)>,
    snapshots: BTreeMap<String, (String, Box<dyn Snapshot>)>,
    books: BTreeMap<String, BTreeMap<String, VerifiedDelta>>,
    keep: Keep,
    /// The feed model of each peer the run created, by peer name (§3.9.2).
    feeds: BTreeMap<String, FeedModel>,
    /// Each revision name, with the peer it belongs to and the revision it stands for (§3.9.6).
    names: BTreeMap<String, (String, Revision)>,
}

/// The codes an `expect` accepts as a refusal (§3, "Refusals"): one code, or a list when several
/// causes apply and their order is free.
fn codes_of(expect: &Value) -> Option<Vec<&str>> {
    match expect.get("error")? {
        Value::Array(codes) => Some(codes.iter().filter_map(Value::as_str).collect()),
        code => Some(code.as_str().into_iter().collect()),
    }
}

/// Judges an answer the store already gave against an expected refusal (§3.7: ask first, judge
/// after).
fn refused<T>(op: &str, result: Result<T, StoreError>, codes: &[&str]) -> Check {
    let wanted = codes.join("` or `");
    match result {
        Err(e) if codes.contains(&e.code.as_str()) => Ok(()),
        Err(e) => Err(format!(
            "{op}: expected a refusal `{wanted}`, the store refused `{}`",
            e.code.as_str()
        )),
        Ok(_) => Err(format!(
            "{op}: expected a refusal `{wanted}`, the store answered"
        )),
    }
}

/// A value the vector carries and this witness's types cannot hold. The step counts as refused
/// with this code at the witness's own boundary (§3.3, §3.7). An append compares the head first.
fn unrepresentable(code: StoreErrorCode, what: &str) -> StoreError {
    StoreError::new(code, format!("{what} does not fit this witness's type"))
}

/// A whole number as written, or the boundary refusal when the number is not one a `u64` holds.
fn whole_as_written(v: &Value, key: &str, code: StoreErrorCode) -> Check<Result<u64, StoreError>> {
    let value = field(v, key)?;
    if !value.is_number() {
        return Err(format!("`{key}` is not a number"));
    }
    Ok(value.as_u64().ok_or_else(|| unrepresentable(code, key)))
}

/// The three `expect` shapes of a query (§3.7): a result, a result or one refusal, a refusal.
fn answered<T>(
    op: &str,
    expect: &Value,
    result: Result<T, StoreError>,
    check: impl FnOnce(T) -> Check,
) -> Check {
    if let Some(codes) = codes_of(expect) {
        return refused(op, result, &codes);
    }
    match result {
        Ok(answer) => check(answer),
        Err(e) if expect.get("orError").and_then(Value::as_str) == Some(e.code.as_str()) => Ok(()),
        Err(e) => Err(format!(
            "{op}: the store refused `{}`: {}",
            e.code.as_str(),
            e.message
        )),
    }
}

fn same_ids(what: &str, got: &[String], want: &[String]) -> Check {
    if got == want {
        return Ok(());
    }
    Err(format!(
        "{what}: expected ids {want:?}, the store answered {got:?}"
    ))
}

fn ascending(ids: &[&str]) -> Check {
    if let Some(pair) = ids.windows(2).find(|pair| pair[0] >= pair[1]) {
        return Err(match pair[0] == pair[1] {
            true => format!("scope: the answer holds {} twice", pair[0]),
            false => "scope: the answer is not ascending by id".into(),
        });
    }
    Ok(())
}

/// A returned delta is the named appearance: same id, same signature, claims that recompute.
fn same_appearance(op: &str, got: &Delta, want: &Delta) -> Check {
    if got.id != want.id {
        return Err(format!(
            "{op}: expected delta {}, the store answered {}",
            want.id, got.id
        ));
    }
    if got.sig != want.sig {
        return Err(format!(
            "{op}: delta {} does not carry the signature this peer admitted",
            got.id
        ));
    }
    if compute_id(&got.claims).ok().as_deref() != Some(got.id.as_str()) {
        return Err(format!(
            "{op}: the claims of delta {} do not recompute to its id",
            got.id
        ));
    }
    Ok(())
}

/// The first field in which a returned arrival record differs from the one the peer admitted.
fn arrival_differs(got: &ArrivalRecord, want: &ArrivalRecord) -> Option<&'static str> {
    if got.id != want.id {
        return Some("id");
    }
    if got.at.to_bits() != want.at.to_bits() {
        return Some("at");
    }
    if got.sequence != want.sequence {
        return Some("sequence");
    }
    if got.transfer != want.transfer {
        return Some("transfer");
    }
    if got.sender != want.sender {
        return Some("sender");
    }
    None
}

fn collect<T>(listing: impl Iterator<Item = Result<T, StoreError>>) -> Result<Vec<T>, StoreError> {
    listing.collect()
}

impl<'a> Run<'a> {
    fn open(corpus: &'a Corpus, factory: &StoreFactoryFn<'_>) -> Check<Self> {
        let store = factory().map_err(|e| format!("the factory did not open a store: {e}"))?;
        let profile = store.profile().clone();
        Ok(Self {
            corpus,
            reference: profile.format_version == corpus.reference_format,
            keep: Keep::of(profile.change_retention),
            profile,
            store,
            handles: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            books: BTreeMap::new(),
            feeds: BTreeMap::new(),
            names: BTreeMap::new(),
        })
    }

    /// The first requirement of a script this store's profile fails (§3).
    fn unmet(&self, script: &Value) -> Check<Option<String>> {
        if script.get("requires").is_none() {
            return Ok(None);
        }
        for requirement in texts(script, "requires")? {
            let holds = match requirement.as_str() {
                "purge" => self.profile.capabilities.erasure != ErasureClass::None,
                "journal-absent" => !self.profile.capabilities.journal,
                "changes" => self.profile.change_retention != ChangeRetention::None,
                other => return Err(format!("unknown script requirement `{other}`")),
            };
            if !holds {
                return Ok(Some(requirement));
            }
        }
        Ok(None)
    }

    fn peer(&self, handle: &str) -> Check<&dyn PeerStore> {
        self.handles
            .get(handle)
            .map(|(_, peer)| peer.as_ref())
            .ok_or_else(|| format!("the script has no handle named {handle}"))
    }

    /// The peer a handle belongs to. The bookkeeping is per peer, not per handle.
    fn peer_name(&self, handle: &str) -> Check<String> {
        self.handles
            .get(handle)
            .map(|(peer, _)| peer.clone())
            .ok_or_else(|| format!("the script has no handle named {handle}"))
    }

    fn snapshot(&self, step: &Value) -> Check<(&str, &dyn Snapshot)> {
        let name = text(step, "snapshot")?;
        self.snapshots
            .get(name)
            .map(|(peer, snapshot)| (peer.as_str(), snapshot.as_ref()))
            .ok_or_else(|| format!("the script has no snapshot named {name}"))
    }

    fn revision(&self, handle: &str) -> Check<Revision> {
        let mut snapshot = self
            .peer(handle)?
            .read()
            .map_err(|e| format!("read refused `{}`", e.code.as_str()))?;
        let revision = snapshot.revision();
        snapshot.release();
        Ok(revision)
    }

    fn moved(op: &str, expect: &Value, before: Revision, after: Revision) -> Check {
        let advanced = expect.get("revisionAdvanced").and_then(Value::as_bool) == Some(true);
        match (advanced, after > before, after == before) {
            (true, true, _) | (false, _, true) => Ok(()),
            (true, ..) => Err(format!("{op}: the revision did not advance")),
            (false, ..) => Err(format!("{op}: the revision changed")),
        }
    }

    fn held(&self, op: &str, peer: &str, id: &str) -> Check<&VerifiedDelta> {
        self.books
            .get(peer)
            .and_then(|book| book.get(id))
            .ok_or_else(|| {
                format!("{op}: the store answered {id}, which peer {peer} does not hold")
            })
    }

    /// Runs steps in order and stops at the first that fails, naming its index. After every
    /// step, each peer's whole kept feed is read and checked (§3.9.4).
    fn steps(&mut self, steps: &[Value]) -> Result<(), (Option<usize>, String)> {
        for (i, step) in steps.iter().enumerate() {
            self.step(step)
                .and_then(|()| self.check_feeds())
                .map_err(|message| (Some(i), message))?;
        }
        Ok(())
    }

    fn feed(&self) -> bool {
        self.keep != Keep::NoFeed
    }

    /// The check after every step (§3.9.4), through the handle under each peer's own name.
    fn check_feeds(&mut self) -> Check {
        if !self.feed() {
            return Ok(());
        }
        let keep = self.keep;
        for (peer, model) in self.feeds.iter_mut() {
            let store = self
                .handles
                .get(peer)
                .map(|(_, handle)| handle.as_ref())
                .ok_or_else(|| format!("the script has no handle named {peer}"))?;
            let (dropped, floor) = model.floor(keep);
            if let Pages::Resync = read_pages(store, peer, model, floor, None)? {
                return Err(format!(
                    "changes answered resync-required from {}, and every record after {} is retained",
                    floor.0, floor.0
                ));
            }
            if dropped > 0 {
                // One call each, with no `to` and no paging: at the newest dropped record's
                // predecessor, and just below the floor where revisions skip values.
                let below = model.revisions[dropped - 1];
                let mut asks = vec![below];
                if floor.0 - 1 > below.0 {
                    asks.push(Revision(floor.0 - 1));
                }
                for from in asks {
                    match store.changes(from, None).map_err(changes_refused)? {
                        ChangePage::Ok { .. } => {
                            return Err(format!(
                                "changes answered ok from {}, below the retention floor {}",
                                from.0, floor.0
                            ))
                        }
                        ChangePage::ResyncRequired { current } => model.resync_current(current)?,
                    }
                }
                // The floor probe: a `from` above the floor and below the oldest kept record
                // answers `ok`. Only revisions that skip values leave room for one.
                let oldest = model.revisions[dropped + 1];
                let above = Revision(floor.0 + 1);
                if above < oldest {
                    if let Pages::Resync = read_pages(store, peer, model, above, None)? {
                        return Err(format!(
                            "changes answered resync-required from {}, above the retention floor {}",
                            above.0, floor.0
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Gives a revision name to one peer's revision (§3.9.6).
    fn name_revision(&mut self, name: &str, peer: &str, revision: Revision) -> Check {
        if self.names.contains_key(name) {
            return Err(format!("the vector names revision {name} twice"));
        }
        self.names
            .insert(name.to_string(), (peer.to_string(), revision));
        Ok(())
    }

    /// `revisionAs` on an append or a purge: the peer's revision after the step.
    fn name_step(&mut self, step: &Value, peer: &str, after: Revision) -> Check {
        match step.get("revisionAs") {
            Some(_) => self.name_revision(text(step, "revisionAs")?, peer, after),
            None => Ok(()),
        }
    }

    /// A revision name of this peer, without `ahead`.
    fn named(&self, name: &str, peer: &str) -> Check<Revision> {
        let (owner, revision) = self
            .names
            .get(name)
            .ok_or_else(|| format!("the vector names an unknown revision {name}"))?;
        if owner != peer {
            return Err(format!("the vector names revision {name} of another peer"));
        }
        Ok(*revision)
    }

    /// A revision reference: `{"revision": <name>}`, optionally with `"ahead": k`.
    fn reference(&self, v: &Value, peer: &str) -> Check<Revision> {
        let revision = self.named(text(v, "revision")?, peer)?;
        let ahead = match v.get("ahead") {
            Some(ahead) => ahead
                .as_u64()
                .ok_or("the vector's ahead is not a whole number")?,
            None => 0,
        };
        Ok(Revision(revision.0 + ahead))
    }

    fn mark(&mut self, step: &Value) -> Check {
        let handle = text(step, "peer")?;
        if !self.handles.contains_key(handle) {
            return Err(format!("the vector uses peer {handle} before creating it"));
        }
        let revision = self.revision(handle)?;
        let peer = self.peer_name(handle)?;
        self.name_revision(text(step, "as")?, &peer, revision)
    }

    /// The check of each commit (§3.9.3): every append and every purge, after the model has
    /// taken the step.
    fn check_commit(&mut self, handle: &str, before: Revision, after: Revision) -> Check {
        if !self.feed() {
            return Ok(());
        }
        let peer = self.peer_name(handle)?;
        let store = self.peer(handle)?;
        let mut records = Vec::new();
        let mut at = before;
        loop {
            match store.changes(at, None).map_err(changes_refused)? {
                ChangePage::Ok {
                    records: page,
                    through,
                } => {
                    records.extend(page);
                    if through >= after || through <= at {
                        break;
                    }
                    at = through;
                }
                ChangePage::ResyncRequired { .. } => {
                    return Err("changes from the revision before a commit is not ok".into())
                }
            }
        }
        let model = self
            .feeds
            .get(&peer)
            .ok_or_else(|| format!("the vector uses peer {peer} before creating it"))?;
        model.names_only_held(&peer, &records)?;
        ids_ascending(&records)?;
        if after == before {
            if !records.is_empty() {
                return Err("a step that did not advance the revision wrote a record".into());
            }
            return Ok(());
        }
        let r = after.0;
        let want = model
            .record(after)
            .ok_or_else(|| format!("the runner has no record for revision {r}"))?;
        if records.is_empty() {
            return Err(match want.added.is_empty() && want.removed.is_empty() {
                true => format!("the head-only commit to revision {r} wrote no record"),
                false => format!("the commit to revision {r} wrote no record"),
            });
        }
        if records.len() != 1 || records[0].revision != after {
            return Err(format!(
                "the commit to revision {r} wrote records at {:?}",
                revisions_of(&records)
            ));
        }
        let got = &records[0];
        if got.head != want.head {
            return Err(format!(
                "the record of revision {r} has head {:?}, expected {:?}",
                got.head, want.head
            ));
        }
        if got.added != want.added {
            return Err(format!(
                "the record of revision {r} adds {:?}, expected {:?}",
                got.added, want.added
            ));
        }
        if got.removed != want.removed {
            return Err(format!(
                "the record of revision {r} removes {:?}, expected {:?}",
                got.removed, want.removed
            ));
        }
        Ok(())
    }

    /// A `changes` step (§3.9.6).
    fn changes(&mut self, step: &Value) -> Check {
        let handle = text(step, "peer")?;
        let peer = self.peer_name(handle)?;
        let from = self.reference(field(step, "from")?, &peer)?;
        let to = match step.get("to") {
            Some(to) => Some(self.reference(to, &peer)?),
            None => None,
        };
        let expect = field(step, "expect")?;
        if let Some(codes) = codes_of(expect) {
            return refused("changes", self.peer(handle)?.changes(from, to), &codes);
        }
        if !self.feed() {
            return Err("a changes step on a store that serves no feed".into());
        }
        let resync = match text(expect, "status")? {
            "ok" => false,
            "resync-required" => true,
            other => return Err(format!("the vector expects changes status `{other}`")),
        };
        let want = match resync {
            true => Vec::new(),
            false => list(expect, "records")?
                .iter()
                .map(|record| self.expected_record(record, &peer))
                .collect::<Check<Vec<_>>>()?,
        };
        let keep = self.keep;
        let store = self
            .handles
            .get(handle)
            .map(|(_, handle)| handle.as_ref())
            .ok_or_else(|| format!("the script has no handle named {handle}"))?;
        let model = self
            .feeds
            .get_mut(&peer)
            .ok_or_else(|| format!("the vector uses peer {peer} before creating it"))?;
        let (_, floor) = model.floor(keep);
        let below = from < floor;
        match (resync || below, read_pages(store, &peer, model, from, to)?) {
            (true, Pages::Resync) => Ok(()),
            (true, Pages::Ok(_)) if below => Err(format!(
                "changes answered ok from {}, below the retention floor {}",
                from.0, floor.0
            )),
            (true, Pages::Ok(_)) => Err(format!(
                "changes answered ok from {}, and the step expects resync-required",
                from.0
            )),
            (false, Pages::Resync) => Err(format!(
                "changes answered resync-required from {}, and every record after {} is retained",
                from.0, from.0
            )),
            (false, Pages::Ok(got)) if got == want => Ok(()),
            (false, Pages::Ok(got)) => Err(format!(
                "changes answered the records of {:?}, expected {:?}",
                revisions_of(&got),
                revisions_of(&want)
            )),
        }
    }

    /// A record a `changes` step names: its revision is a name of this peer, its ids corpus
    /// names.
    fn expected_record(&self, v: &Value, peer: &str) -> Check<ChangeRecord> {
        Ok(ChangeRecord {
            revision: self.named(text(v, "revision")?, peer)?,
            head: field(v, "head")?.as_str().map(str::to_string),
            added: self.corpus.ids(v, "added")?,
            removed: self.corpus.ids(v, "removed")?,
        })
    }

    fn step(&mut self, step: &Value) -> Check {
        match text(step, "op")? {
            "createPeer" => self.create_peer(step),
            "openPeer" => self.open_peer(step),
            "append" => self.append(step),
            "purge" => self.purge(step),
            "read" => {
                let handle = text(step, "peer")?;
                let snapshot = self
                    .peer(handle)?
                    .read()
                    .map_err(|e| format!("read refused `{}`", e.code.as_str()))?;
                self.snapshots.insert(
                    text(step, "snapshot")?.to_string(),
                    (self.peer_name(handle)?, snapshot),
                );
                Ok(())
            }
            "release" => {
                let name = text(step, "snapshot")?;
                let (_, snapshot) = self
                    .snapshots
                    .get_mut(name)
                    .ok_or_else(|| format!("the script has no snapshot named {name}"))?;
                snapshot.release();
                Ok(())
            }
            "head" => {
                let want = field(field(step, "expect")?, "head")?.as_str();
                let got = self.snapshot(step)?.1.head();
                if got == want {
                    return Ok(());
                }
                Err(format!("expected head {want:?}, the snapshot has {got:?}"))
            }
            "count" => {
                let want = whole(field(step, "expect")?, "count")?;
                let got = self.snapshot(step)?.1.count();
                if got == want {
                    return Ok(());
                }
                Err(format!("expected count {want}, the snapshot has {got}"))
            }
            "mark" => self.mark(step),
            "changes" => self.changes(step),
            "get" => self.get(step),
            "arrivals" => self.arrivals(step),
            "targets" | "negators" => self.index_read(step),
            "scope" => self.scope(step),
            "export" => self.export(step),
            "exportStored" => {
                let want = self.corpus.ids(field(step, "expect")?, "ids")?;
                let got = collect(self.store.open_admin().stored_ids())
                    .map_err(|e| format!("storedIds refused `{}`", e.code.as_str()))?;
                same_ids("storedIds", &got, &want)
            }
            "exportPeers" => {
                let want: Vec<String> = texts(field(step, "expect")?, "peers")?
                    .iter()
                    .map(|name| self.corpus.peer(name).map(str::to_string))
                    .collect::<Check<_>>()?;
                let got = collect(self.store.open_admin().peers())
                    .map_err(|e| format!("peers refused `{}`", e.code.as_str()))?;
                same_ids("peers", &got, &want)
            }
            other => Err(format!("unknown op `{other}`")),
        }
    }

    fn create_peer(&mut self, step: &Value) -> Check {
        let name = text(step, "peer")?;
        if self.keep == Keep::Malformed {
            return Err(
                "the profile's changeRetention is not none, unbounded or {revisions: n}".into(),
            );
        }
        // A missing posture, or a value that is not one, cannot reach a typed store.
        let posture = match step.get("erasure").and_then(Value::as_str) {
            Some("proven") => Ok(ErasurePosture::Proven),
            Some("unproven") => Ok(ErasurePosture::Unproven),
            _ => Err(unrepresentable(StoreErrorCode::InvalidRequest, "erasure")),
        };
        let expect = field(step, "expect")?;
        let class = self.profile.capabilities.erasure;
        let id = self.corpus.peer(name)?;
        let result = posture
            .clone()
            .and_then(|posture| self.store.create_peer(id, posture));
        let excepted =
            expect.get("unlessStoreErasure").and_then(Value::as_str) == Some(class.as_str());
        if let (Some(codes), false) = (codes_of(expect), excepted) {
            return refused("createPeer", result, &codes);
        }
        let handle = result.map_err(|e| format!("createPeer refused `{}`", e.code.as_str()))?;
        let erasure = handle.erasure();
        if Ok(erasure.posture) != posture {
            return Err(format!(
                "createPeer: the new peer reports posture `{}`, not the one it was created with",
                erasure.posture.as_str()
            ));
        }
        if erasure.store_class != class {
            return Err(format!(
                "createPeer: the new peer reports erasure class `{}`, the store's is `{}`",
                erasure.store_class.as_str(),
                class.as_str()
            ));
        }
        self.handles
            .insert(name.to_string(), (name.to_string(), handle));
        if self.feed() {
            let revision = self.revision(name)?;
            self.feeds.insert(
                name.to_string(),
                FeedModel {
                    revisions: vec![revision],
                    ..FeedModel::default()
                },
            );
        }
        Ok(())
    }

    fn open_peer(&mut self, step: &Value) -> Check {
        let name = text(step, "peer")?;
        let expect = field(step, "expect")?;
        let result = self.store.peer(self.corpus.peer(name)?);
        if let Some(codes) = codes_of(expect) {
            return refused("openPeer", result, &codes);
        }
        let handle = result.map_err(|e| format!("openPeer refused `{}`", e.code.as_str()))?;
        if handle.erasure().posture.as_str() != text(expect, "posture")? {
            return Err(
                "openPeer: the opened peer does not report the posture it was created with".into(),
            );
        }
        // With `handle`, the older handle stays under its own name; both are one peer.
        let kept_as = match step.get("handle") {
            Some(_) => text(step, "handle")?,
            None => name,
        };
        self.handles
            .insert(kept_as.to_string(), (name.to_string(), handle));
        Ok(())
    }

    /// The batch as written. A counter this witness's record cannot hold (`1.5`, `-1`) makes the
    /// whole step a boundary refusal.
    fn admission(&self, step: &Value) -> Check<Result<Admission, StoreError>> {
        let mut added = Vec::new();
        let code = StoreErrorCode::InvalidAdmission;
        for entry in list(step, "added")? {
            let delta = self.corpus.delta(text(entry, "delta")?)?.clone();
            let arrival = field(entry, "arrival")?;
            let id = match arrival.get("id") {
                Some(_) => self.corpus.id(text(arrival, "id")?)?,
                None => delta.id.clone(),
            };
            let arrival = ArrivalRecord {
                id,
                at: field(arrival, "at")?
                    .as_f64()
                    .ok_or("`at` is not a number")?,
                sequence: match whole_as_written(arrival, "sequence", code)? {
                    Ok(sequence) => sequence,
                    Err(refusal) => return Ok(Err(refusal)),
                },
                transfer: match whole_as_written(arrival, "transfer", code)? {
                    Ok(transfer) => transfer,
                    Err(refusal) => return Ok(Err(refusal)),
                },
                sender: text(arrival, "sender")?.to_string(),
            };
            added.push(VerifiedDelta { delta, arrival });
        }
        let frame = match field(step, "frame")? {
            Value::Null => None,
            hex_text => Some(
                hex::decode(hex_text.as_str().ok_or("`frame` is not text")?)
                    .map_err(|_| "`frame` is not hex")?,
            ),
        };
        Ok(Ok(Admission {
            expected_head: field(step, "expectedHead")?.as_str().map(str::to_string),
            next_head: text(step, "nextHead")?.to_string(),
            frame,
            added,
        }))
    }

    fn append(&mut self, step: &Value) -> Check {
        let name = text(step, "peer")?;
        let expect = field(step, "expect")?;
        let batch = self.admission(step)?;
        let before = self.revision(name)?;
        let result = match &batch {
            Ok(batch) => self.peer(name)?.append(batch),
            // The witness answers for the store at its boundary, head first: a stale writer
            // gets `conflict` whatever its batch holds (§3.3).
            Err(refusal) => {
                let mut snapshot = self
                    .peer(name)?
                    .read()
                    .map_err(|e| format!("read refused `{}`", e.code.as_str()))?;
                let stale = snapshot.head() != field(step, "expectedHead")?.as_str();
                snapshot.release();
                if stale {
                    Ok(AppendResult::Conflict)
                } else {
                    Err(refusal.clone())
                }
            }
        };
        let after = self.revision(name)?;
        if let Some(codes) = codes_of(expect) {
            refused("append", result, &codes)?;
            Self::moved("append", expect, before, after)?;
            return self.check_commit(name, before, after);
        }
        let added_entries = batch.map(|batch| batch.added).unwrap_or_default();
        let result =
            result.map_err(|e| format!("append refused `{}`: {}", e.code.as_str(), e.message))?;
        match (text(expect, "status")?, result) {
            ("conflict", AppendResult::Conflict) => {
                Self::moved("append", expect, before, after)?;
                self.check_commit(name, before, after)
            }
            ("committed", AppendResult::Committed { revision, added }) => {
                let want = self.corpus.ids(expect, "added")?;
                same_ids("append added", &added, &want)?;
                if revision != after {
                    return Err(
                        "the append result's revision is not the peer's revision after it".into(),
                    );
                }
                Self::moved("append", expect, before, after)?;
                let peer = self.peer_name(name)?;
                let book = self.books.entry(peer.clone()).or_default();
                for id in &added {
                    if let Some(first) = added_entries.iter().find(|entry| entry.delta.id == *id) {
                        book.insert(id.clone(), first.clone());
                    }
                }
                let next_head = text(step, "nextHead")?.to_string();
                if let Some(model) = self.feeds.get_mut(&peer) {
                    model.head = Some(next_head.clone());
                    model.ever_held.extend(added);
                    if after > before {
                        model.revisions.push(after);
                        model.records.push(ChangeRecord {
                            revision: after,
                            head: Some(next_head),
                            added: want,
                            removed: Vec::new(),
                        });
                    }
                }
                self.name_step(step, &peer, after)?;
                self.check_commit(name, before, after)
            }
            (want, got) => Err(format!(
                "append: expected status `{want}`, the store answered {got:?}"
            )),
        }
    }

    fn purge(&mut self, step: &Value) -> Check {
        let name = text(step, "peer")?;
        let expect = field(step, "expect")?;
        let ids = self.corpus.ids(step, "ids")?;
        let before = self.revision(name)?;
        let result = self.peer(name)?.purge(&ids);
        let after = self.revision(name)?;
        // A claim names one expectation per erasure class that purges, and nothing else
        // (§3.4). Any other shape is a defect of the document, whatever the store answered.
        let claims = field(expect, "claim")?
            .as_object()
            .ok_or("purge: the document's `claim` is not an object; the document is defective")?;
        let mut keys: Vec<&str> = claims.keys().map(String::as_str).collect();
        keys.sort_unstable();
        if keys != ["proven", "unprovable"] {
            return Err(format!(
                "purge: the document's `claim` has the keys {keys:?}, and a claim has exactly `unprovable` and `proven`; the document is defective"
            ));
        }
        let report =
            result.map_err(|e| format!("purge refused `{}`: {}", e.code.as_str(), e.message))?;

        let want: Vec<(String, String)> = list(expect, "targets")?
            .iter()
            .map(|t| {
                Ok((
                    self.corpus.id(text(t, "delta")?)?,
                    text(t, "outcome")?.to_string(),
                ))
            })
            .collect::<Check<_>>()?;
        let got: Vec<(String, String)> = report
            .targets
            .iter()
            .map(|t| (t.id.clone(), t.outcome.as_str().to_string()))
            .collect();
        if got != want {
            return Err(format!(
                "purge targets: expected {want:?}, the store reported {got:?}"
            ));
        }
        if report.revision != after {
            return Err("the purge report's revision is not the peer's revision after it".into());
        }
        Self::moved("purge", expect, before, after)?;
        if report.boundary != PURGE_BOUNDARY {
            return Err(format!(
                "the purge report's boundary is `{}`",
                report.boundary
            ));
        }
        // A store may claim less than it could, never more: `unproven` stands in for `proven`,
        // and nothing else is exchanged.
        let class = self.profile.capabilities.erasure.as_str();
        let claim = text(field(expect, "claim")?, class)?;
        let got = report.claim.as_str();
        if got != claim && !(claim == "proven" && got == "unproven") {
            return Err(format!(
                "expected claim `{claim}`, the store claimed `{got}`"
            ));
        }
        if report.claim == ErasureClaim::Proven
            && (report.surfaces.is_empty()
                || report
                    .surfaces
                    .iter()
                    .any(|s| s.state != SurfaceState::Absent))
        {
            return Err(
                "the report claims `proven` without a surface, or with one that is not absent"
                    .into(),
            );
        }
        if self.reference {
            let want: Vec<(String, String)> = list(expect, "referenceSurfaces")?
                .iter()
                .map(|s| {
                    Ok((
                        text(s, "surface")?.to_string(),
                        text(s, "state")?.to_string(),
                    ))
                })
                .collect::<Check<_>>()?;
            let got: Vec<(String, String)> = report
                .surfaces
                .iter()
                .map(|s| (s.surface.clone(), s.state.as_str().to_string()))
                .collect();
            if got != want {
                return Err(format!(
                    "reference surfaces: expected {want:?}, the store reported {got:?}"
                ));
            }
        }
        let peer = self.peer_name(name)?;
        // What left the holdings: the targets the bookkeeping held when the purge began. The
        // outcome alone does not decide, because a settled debt is also `removed` (§3.9.2).
        let released: Vec<String> = report
            .targets
            .iter()
            .filter(|t| {
                self.books
                    .get(&peer)
                    .is_some_and(|book| book.contains_key(&t.id))
            })
            .map(|t| t.id.clone())
            .collect();
        if let Some(book) = self.books.get_mut(&peer) {
            for target in &report.targets {
                book.remove(&target.id);
            }
        }
        if let Some(model) = self.feeds.get_mut(&peer) {
            if after > before {
                model.revisions.push(after);
                model.records.push(ChangeRecord {
                    revision: after,
                    head: model.head.clone(),
                    added: Vec::new(),
                    removed: released,
                });
            }
        }
        self.name_step(step, &peer, after)?;
        self.check_commit(name, before, after)
    }

    fn get(&self, step: &Value) -> Check {
        let expect = field(step, "expect")?;
        let (_, snapshot) = self.snapshot(step)?;
        let result = snapshot.get(&self.corpus.ids(step, "ids")?);
        answered("get", expect, result, |deltas| {
            let got: Vec<String> = deltas.iter().map(|d| d.id.clone()).collect();
            same_ids("get", &got, &self.corpus.ids(expect, "deltas")?)?;
            let names = texts(expect, "deltas")?;
            deltas
                .iter()
                .zip(&names)
                .try_for_each(|(got, name)| same_appearance("get", got, self.corpus.delta(name)?))
        })
    }

    fn arrivals(&self, step: &Value) -> Check {
        let expect = field(step, "expect")?;
        let (peer, snapshot) = self.snapshot(step)?;
        let result = snapshot.arrivals(&self.corpus.ids(step, "ids")?);
        answered("arrivals", expect, result, |records| {
            let got: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
            same_ids("arrivals", &got, &self.corpus.ids(expect, "ids")?)?;
            for record in &records {
                let admitted = &self.held("arrivals", peer, &record.id)?.arrival;
                if let Some(differs) = arrival_differs(record, admitted) {
                    return Err(format!(
                        "arrivals: the arrival record of {} is not the one peer {peer} first admitted (field `{differs}`)",
                        record.id
                    ));
                }
            }
            Ok(())
        })
    }

    fn index_read(&self, step: &Value) -> Check {
        let expect = field(step, "expect")?;
        let (_, snapshot) = self.snapshot(step)?;
        let op = text(step, "op")?;
        let result = match op {
            "targets" => snapshot.targets(&texts(step, "entities")?),
            _ => snapshot.negators(&self.corpus.ids(step, "ids")?),
        };
        answered(op, expect, result, |ids| {
            same_ids(op, &ids, &self.corpus.ids(expect, "ids")?)
        })
    }

    /// The selection as written. An `arrivalAtMost` this witness's type cannot hold (`1.5`,
    /// `-1`) is a boundary refusal.
    fn pushdown(&self, v: &Value) -> Check<Result<Pushdown, StoreError>> {
        let arrival_at_most = match v.get(FIELDS[1]) {
            Some(_) => match whole_as_written(v, FIELDS[1], StoreErrorCode::InvalidRequest)? {
                Ok(bound) => Some(bound),
                Err(refusal) => return Ok(Err(refusal)),
            },
            None => None,
        };
        Ok(Ok(Pushdown {
            timestamp_at_most: match v.get(FIELDS[0]) {
                Some(t) => Some(t.as_f64().ok_or("`timestampAtMost` is not a number")?),
                None => None,
            },
            arrival_at_most,
            exclude_ids: match v.get(FIELDS[2]) {
                Some(_) => Some(self.corpus.ids(v, FIELDS[2])?),
                None => None,
            },
        }))
    }

    fn anchors(step: &Value) -> Check<Vec<Anchor>> {
        list(step, "anchors")?
            .iter()
            .map(|anchor| match text(anchor, "kind")? {
                "entity" => Ok(Anchor::Entity {
                    entity: text(anchor, "entity")?.to_string(),
                }),
                other => Err(format!("unknown anchor kind `{other}`")),
            })
            .collect()
    }

    /// The checks every scope answer gets (§3.7): ascending, and each member is held by the
    /// peer as the appearance it admitted, with that peer's arrival record.
    fn members(&self, peer: &str, answer: &ScopeResult, requested: &Pushdown) -> Check {
        let ids: Vec<&str> = answer.deltas.iter().map(|m| m.delta.id.as_str()).collect();
        ascending(&ids)?;
        for member in &answer.deltas {
            let held = self.held("scope", peer, &member.delta.id)?;
            same_appearance("scope", &member.delta, &held.delta)?;
            if let Some(differs) = arrival_differs(&member.arrival, &held.arrival) {
                return Err(format!(
                    "scope: member {} does not carry the arrival record peer {peer} first admitted (field `{differs}`)",
                    member.delta.id
                ));
            }
        }
        if !flags_of(&answer.applied).is_subset(&fields_of(requested)) {
            return Err(
                "scope: the store reports a pushdown field applied that was not requested".into(),
            );
        }
        Ok(())
    }

    /// What a memory reference store applies: every requested field its profile offers.
    fn reference_applied(&self, requested: &Pushdown) -> BTreeSet<&'static str> {
        fields_of(requested)
            .intersection(&flags_of(&self.profile.pushdown))
            .copied()
            .collect()
    }

    fn scope(&self, step: &Value) -> Check {
        let expect = field(step, "expect")?;
        let (peer, snapshot) = self.snapshot(step)?;
        let pushdown = match step.get("pushdown").map(|p| self.pushdown(p)).transpose()? {
            Some(Err(refusal)) => {
                return answered("scope", expect, Err(refusal), |_: ScopeResult| Ok(()))
            }
            Some(Ok(pushdown)) => Some(pushdown),
            None => None,
        };
        let request = ScopeRequest {
            anchors: Self::anchors(step)?,
            exclude: match step.get("exclude") {
                Some(_) => self.corpus.ids(step, "exclude")?,
                None => Vec::new(),
            },
            pushdown: pushdown.clone(),
        };
        let requested = pushdown.unwrap_or_default();
        answered("scope", expect, snapshot.scope(&request), |answer| {
            self.members(peer, &answer, &requested)?;
            let got: Vec<String> = answer.deltas.iter().map(|m| m.delta.id.clone()).collect();
            let lower = self.corpus.ids(expect, "lower")?;
            let upper = self.corpus.ids(expect, "upper")?;
            if let Some(missing) = lower.iter().find(|id| !got.contains(id)) {
                return Err(format!(
                    "script lower bound: the scope answer lacks {missing}"
                ));
            }
            if let Some(extra) = got.iter().find(|id| !upper.contains(id)) {
                return Err(format!(
                    "script upper bound: the scope answer holds {extra}, outside the scope"
                ));
            }
            if self.reference {
                let applied = flags_of(&answer.applied);
                if applied != self.reference_applied(&requested) {
                    return Err("reference (script): the applied fields are not the requested fields the profile offers".into());
                }
                if applied == fields_of(&requested) {
                    same_ids("reference (script) scope", &got, &lower)?;
                }
            }
            Ok(())
        })
    }

    fn export(&self, step: &Value) -> Check {
        let expect = field(step, "expect")?;
        let admin = self.store.open_admin();
        let listed = admin
            .peer(self.corpus.peer(text(step, "peer")?)?)
            .and_then(|peer| Ok((collect(peer.ids())?, collect(peer.deltas())?)));
        answered("export", expect, listed, |(ids, deltas)| {
            let names = texts(expect, "deltas")?;
            same_ids("export ids", &ids, &self.corpus.ids(expect, "deltas")?)?;
            if deltas.len() != names.len() {
                return Err(format!(
                    "export: ids lists {} members, deltas lists {}",
                    names.len(),
                    deltas.len()
                ));
            }
            deltas.iter().zip(&names).try_for_each(|(got, name)| {
                same_appearance("export", got, self.corpus.delta(name)?)
            })
        })
    }

    /// One scope case (§4): every subset of the selection pushed down, and the trim lemma.
    fn case(&self, case: &Value) -> Check {
        let handle = text(case, "peer")?;
        let peer = &self.peer_name(handle)?;
        let anchors = Self::anchors(case)?;
        let entities: BTreeSet<&str> = anchors
            .iter()
            .map(|anchor| match anchor {
                Anchor::Entity { entity } => entity.as_str(),
            })
            .collect();
        let selection = self
            .pushdown(field(case, "selection")?)?
            .map_err(|_| "the case's selection is out of range")?;
        let held_ids = self.corpus.ids(case, "held")?;
        let held: Vec<&VerifiedDelta> = held_ids
            .iter()
            .map(|id| self.held("case", peer, id))
            .collect::<Check<_>>()?;
        let mut scopes: BTreeMap<BTreeSet<&str>, Vec<String>> = BTreeMap::new();
        for entry in list(case, "scopes")? {
            let fields = list(entry, "fields")?
                .iter()
                .map(|f| {
                    f.as_str()
                        .ok_or_else(|| "a scope field is not text".to_string())
                })
                .collect::<Check<_>>()?;
            scopes.insert(fields, self.corpus.ids(entry, "ids")?);
        }
        let all = fields_of(&selection);
        let exact = scopes
            .get(&all)
            .ok_or("the case has no entry for the whole selection")?;
        let mut snapshot = self
            .peer(handle)?
            .read()
            .map_err(|e| format!("read refused `{}`", e.code.as_str()))?;
        let outcome = scopes.iter().try_for_each(|(fields, ids)| {
            let pushed = restrict(&selection, fields);
            let request = ScopeRequest {
                anchors: anchors.clone(),
                exclude: held_ids.clone(),
                pushdown: (!fields.is_empty()).then(|| pushed.clone()),
            };
            let answer = snapshot
                .scope(&request)
                .map_err(|e| format!("case: scope refused `{}`: {}", e.code.as_str(), e.message))?;
            self.members(peer, &answer, &pushed)?;
            let applied = flags_of(&answer.applied);
            let got: Vec<String> = answer.deltas.iter().map(|m| m.delta.id.clone()).collect();
            let wanted = ids.iter().filter(|id| !held_ids.contains(id));
            if let Some(missing) = wanted.clone().find(|id| !got.contains(id)) {
                return Err(format!("case lower bound: the scope answer lacks {missing}"));
            }
            let bound = scopes
                .get(&applied.iter().copied().collect::<BTreeSet<&str>>())
                .ok_or("the case has no entry for the applied fields")?;
            if let Some(extra) = got.iter().find(|id| !bound.contains(id)) {
                return Err(format!(
                    "case upper bound: the scope answer holds {extra}, which fails a field reported applied or lies outside the scope"
                ));
            }
            if self.reference {
                if applied != self.reference_applied(&pushed) {
                    return Err("reference (case): the applied fields are not the requested fields the profile offers".into());
                }
                let want: Vec<String> = bound.iter().filter(|id| !held_ids.contains(id)).cloned().collect();
                same_ids("reference (case) scope", &got, &want)?;
            }
            // The trim lemma: the host applies what the store did not, and reaches the exact
            // scope from the answer and what it already holds.
            let residual_fields: BTreeSet<&str> = all.difference(&applied).copied().collect();
            let residual = restrict(&selection, &residual_fields);
            let mut trimmed: BTreeMap<&str, &VerifiedDelta> = answer
                .deltas
                .iter()
                .filter(|m| passes(m, &residual))
                .map(|m| (m.delta.id.as_str(), m))
                .collect();
            for &member in held.iter().filter(|m| passes(m, &selection)) {
                trimmed.insert(member.delta.id.as_str(), member);
            }
            let trimmed: Vec<&VerifiedDelta> = trimmed.into_values().collect();
            same_ids("trim lemma", &scope_over(&entities, &trimmed), exact)
                .map_err(|e| format!("pushing down {fields:?}: {e}"))
        });
        snapshot.release();
        outcome
    }
}

/// Opens one new, empty store for a script.
pub type StoreFactoryFn<'a> = dyn Fn() -> Result<Box<dyn Store>, StoreError> + 'a;

/// Runs every script of `scripts.json` on a new store each, then the setup and every case of
/// `scope.json` on one more. Answers what passed and what the profile made it skip, or every
/// failure.
pub fn run_store_conformance(
    factory: &StoreFactoryFn<'_>,
    vectors: &StoreVectors,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    let mut report = StoreConformanceReport::default();
    let mut failures = Vec::new();
    let mut fail = |name: &str, step: Option<usize>, message: String| {
        failures.push(StoreConformanceFailure {
            name: name.to_string(),
            step,
            message,
        })
    };

    match Corpus::load(&vectors.scripts, SCRIPTS_FORMAT)
        .and_then(|corpus| Ok((list(&vectors.scripts, "scripts")?, corpus)))
    {
        Err(message) => fail("scripts", None, message),
        Ok((scripts, corpus)) => {
            for script in scripts {
                let name = format!("scripts/{}", script["name"].as_str().unwrap_or("?"));
                let outcome = Run::open(&corpus, factory)
                    .map_err(|message| (None, message))
                    .and_then(|mut run| {
                        if let Some(requirement) = run.unmet(script).map_err(|m| (None, m))? {
                            return Ok(Some(requirement));
                        }
                        let steps = list(script, "steps").map_err(|m| (None, m))?;
                        run.steps(steps).map(|()| None)
                    });
                match outcome {
                    Ok(None) => report.passed.push(name),
                    Ok(Some(missing)) => report.skipped.push(SkippedScript { name, missing }),
                    Err((step, message)) => fail(&name, step, message),
                }
            }
        }
    }

    let scope = Corpus::load(&vectors.scope, SCOPE_FORMAT).and_then(|corpus| {
        Ok((
            list(&vectors.scope, "setup")?,
            list(&vectors.scope, "cases")?,
            corpus,
        ))
    });
    match scope {
        Err(message) => fail("scope", None, message),
        Ok((setup, cases, corpus)) => {
            let ready = Run::open(&corpus, factory)
                .map_err(|message| (None, message))
                .and_then(|mut run| run.steps(setup).map(|()| run));
            match ready {
                Err((step, message)) => fail("scope/setup", step, message),
                Ok(run) => {
                    for case in cases {
                        let name = format!("scope/{}", case["name"].as_str().unwrap_or("?"));
                        match run.case(case) {
                            Ok(()) => report.passed.push(name),
                            Err(message) => fail(&name, None, message),
                        }
                    }
                }
            }
        }
    }

    if failures.is_empty() {
        Ok(report)
    } else {
        Err(StoreConformanceError { failures, report })
    }
}
