//! Anchored reads (SPEC-17 proposal): evaluate a gather over the scope S(E) of its anchors instead
//! of over the whole delta set, so a read costs its footprint and not the store. The evaluator is
//! unchanged; this module chooses its input. The scope lemma (SPEC-17 §4) is what makes the
//! answer identical: S(E) is closed under every negation chain that decides a member.
//! Mirrors ../ts/src/resolve/anchored.ts.

use std::collections::{BTreeMap, BTreeSet};

use crate::eval::{
    eval_term, eval_term_at, EvalResult, GroupKey, MaskPolicy, PruneKeep, SchemaRef, Term,
};
use crate::hview::HView;
use crate::pred::{Bindings, EntityMatch, Pred, StrMatch};
use crate::schema::SchemaRegistry;
use crate::set::DeltaSet;
use crate::types::{Delta, Primitive};

/// The read side of a store (SPEC-17 §3). `targets` and `negators` answer from indexes; neither
/// may scan the store.
pub trait DeltaSource {
    fn get(&self, id: &str) -> Option<&Delta>;
    /// Ids of every delta with a pointer whose target is the entity `entity`, any role or context.
    fn targets(&self, entity: &str) -> Vec<String>;
    /// Ids of every delta with a pointer `{role: "negates", target: DeltaRef(id)}`.
    fn negators(&self, id: &str) -> Vec<String>;
    /// The members with these ids. A source that verified its members on the way in overrides
    /// this to skip hashing them again.
    fn subset(&self, ids: &[String]) -> DeltaSet {
        DeltaSet::from_deltas(ids.iter().filter_map(|id| self.get(id).cloned()))
            .expect("a delta source holds only content-addressed deltas")
    }
}

/// A delta source over borrowed indexes: lets a reactor hand its set and indexes to a refresh while
/// its materializations are borrowed mutably.
pub struct IndexedSource<'a> {
    pub set: &'a DeltaSet,
    pub targets: &'a BTreeMap<String, BTreeSet<String>>,
    pub negators: &'a BTreeMap<String, BTreeSet<String>>,
}

impl DeltaSource for IndexedSource<'_> {
    fn get(&self, id: &str) -> Option<&Delta> {
        self.set.get(id)
    }

    fn targets(&self, entity: &str) -> Vec<String> {
        self.targets
            .get(entity)
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn negators(&self, id: &str) -> Vec<String> {
        self.negators
            .get(id)
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn subset(&self, ids: &[String]) -> DeltaSet {
        self.set.subset(ids)
    }
}

/// S(E): every admitted delta pointing at an entity in `entities`, closed under admitted negators,
/// transitively. Sorted ids. Cost is O(|S(E)|) index lookups.
pub fn scope_ids<'a>(
    source: &impl DeltaSource,
    entities: impl IntoIterator<Item = &'a str>,
    admits: Option<&dyn Fn(&Delta) -> bool>,
) -> Vec<String> {
    let mut members = BTreeSet::new();
    let mut pending = Vec::new();
    let consider = |id: String, members: &mut BTreeSet<String>, pending: &mut Vec<String>| {
        if members.contains(&id) {
            return;
        }
        let Some(delta) = source.get(&id) else { return };
        if admits.is_some_and(|f| !f(delta)) {
            return;
        }
        members.insert(id.clone());
        pending.push(id);
    };
    for entity in entities {
        for id in source.targets(entity) {
            consider(id, &mut members, &mut pending);
        }
    }
    while let Some(id) = pending.pop() {
        for negator in source.negators(&id) {
            consider(negator, &mut members, &mut pending);
        }
    }
    members.into_iter().collect()
}

/// Why a term cannot be anchored (SPEC-17 §5). The strings are shared vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnanchoredReason {
    Aliased,
    Reflection,
    ConstGroup,
    ActsFor,
    UnknownSchema,
    ResultSort,
}

impl UnanchoredReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aliased => "aliased",
            Self::Reflection => "reflection",
            Self::ConstGroup => "const-group",
            Self::ActsFor => "acts-for",
            Self::UnknownSchema => "unknown-schema",
            Self::ResultSort => "result-sort",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorAnalysis {
    Anchored { anchors: Vec<String> },
    Unanchored(UnanchoredReason),
}

fn conjuncts(pred: &Pred) -> Vec<&Pred> {
    match pred {
        Pred::And(l, r) => {
            let mut v = conjuncts(l);
            v.extend(conjuncts(r));
            v
        }
        p => vec![p],
    }
}

fn entity_of(m: &EntityMatch, bindings: Option<&Bindings>) -> Option<String> {
    match m {
        EntityMatch::Const(id) => Some(id.clone()),
        EntityMatch::Root => Some("root".to_string()),
        EntityMatch::Hole(name) => match bindings.and_then(|b| b.get(name)) {
            Some(Primitive::Str(s)) => Some(s.clone()),
            _ => None,
        },
    }
}

/// The entity a conjunct pins, when it pins one: "root" for the ambient root.
fn pinned_entity(pred: &Pred, bindings: Option<&Bindings>) -> Option<String> {
    conjuncts(pred).into_iter().find_map(|c| match c {
        Pred::HasPointer(pp) => pp
            .target_entity
            .as_ref()
            .and_then(|m| entity_of(m, bindings)),
        _ => None,
    })
}

struct Analyzer<'a> {
    registry: Option<&'a SchemaRegistry>,
    anchors: BTreeSet<String>,
    seen: BTreeSet<String>,
}

type Walk = Result<(), UnanchoredReason>;

fn check_str(m: Option<&StrMatch>) -> Walk {
    match m {
        Some(StrMatch::Aliased(_)) => Err(UnanchoredReason::Aliased),
        _ => Ok(()),
    }
}

impl Analyzer<'_> {
    fn pred(&mut self, p: &Pred, b: Option<&Bindings>) -> Walk {
        match p {
            Pred::And(l, r) | Pred::Or(l, r) => {
                self.pred(l, b)?;
                self.pred(r, b)
            }
            Pred::Not(inner) => self.pred(inner, b),
            Pred::HasPointer(pp) => {
                check_str(pp.role.as_ref())?;
                check_str(pp.context.as_ref())
            }
            Pred::ActsFor { .. } => Err(UnanchoredReason::ActsFor),
            Pred::InView { term, .. } => {
                let entity = match term.as_ref() {
                    Term::Select { pred, .. } => pinned_entity(pred, b),
                    _ => None,
                };
                let entity = entity.ok_or(UnanchoredReason::Reflection)?;
                if entity != "root" {
                    self.anchors.insert(entity);
                }
                self.walk(term, b)
            }
            _ => Ok(()),
        }
    }

    fn schema(&mut self, r: &SchemaRef, b: Option<&Bindings>) -> Walk {
        let body = self
            .registry
            .and_then(|reg| reg.resolve(r))
            .map(|s| s.body.clone())
            .ok_or(UnanchoredReason::UnknownSchema)?;
        let label = match r {
            SchemaRef::Name(n) => n.clone(),
            SchemaRef::Pinned(h) => h.clone(),
        };
        let key = format!("{label}|{b:?}");
        if !self.seen.insert(key) {
            return Ok(());
        }
        self.walk(&body, b)
    }

    fn walk(&mut self, t: &Term, b: Option<&Bindings>) -> Walk {
        match t {
            Term::Input => Ok(()),
            Term::Select { pred, of } => {
                self.pred(pred, b)?;
                self.walk(of, b)
            }
            Term::Union { left, right } | Term::Intersect { left, right } => {
                self.walk(left, b)?;
                self.walk(right, b)
            }
            Term::Difference { of, without } => {
                self.walk(of, b)?;
                self.walk(without, b)
            }
            Term::Mask { policy, of } => {
                if let MaskPolicy::Trust(p) = policy {
                    self.pred(p, b)?;
                }
                self.walk(of, b)
            }
            Term::Group { key, of } => {
                if let GroupKey::Const(_) = key {
                    let entity = match of.as_ref() {
                        Term::Select { pred, .. } => pinned_entity(pred, b),
                        _ => None,
                    };
                    let entity = entity.ok_or(UnanchoredReason::ConstGroup)?;
                    if entity != "root" {
                        self.anchors.insert(entity);
                    }
                }
                self.walk(of, b)
            }
            Term::Prune { keep, of } => {
                if let PruneKeep::Match(m) = keep {
                    check_str(Some(m))?;
                }
                self.walk(of, b)
            }
            Term::Expand {
                role, schema, of, ..
            } => {
                check_str(Some(role))?;
                self.walk(of, b)?;
                self.schema(schema, b)
            }
            Term::Fix {
                schema,
                entity,
                bindings,
            } => {
                self.anchors.insert(entity.clone());
                self.schema(schema, bindings.as_ref().or(b))
            }
            Term::Resolve { of, .. } => self.walk(of, b),
        }
    }
}

/// Static check (SPEC-17 §5): is every place this term reads deltas tied to an entity it can name?
/// Returns its static anchors (constant `inView`, `group const` and `fix` entities), sorted.
/// Referenced schema bodies are walked through the registry.
pub fn anchor_analysis(
    term: &Term,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
) -> AnchorAnalysis {
    // Discovery reads the gathered HView; a DSet or bare View result shows no anchors.
    let top = match term {
        Term::Resolve { of, .. } => of.as_ref(),
        t => t,
    };
    if !matches!(
        top,
        Term::Group { .. } | Term::Prune { .. } | Term::Expand { .. } | Term::Fix { .. }
    ) {
        return AnchorAnalysis::Unanchored(UnanchoredReason::ResultSort);
    }
    let mut a = Analyzer {
        registry,
        anchors: BTreeSet::new(),
        seen: BTreeSet::new(),
    };
    match a.walk(term, bindings) {
        Ok(()) => AnchorAnalysis::Anchored {
            anchors: a.anchors.into_iter().collect(),
        },
        Err(reason) => AnchorAnalysis::Unanchored(reason),
    }
}

/// The anchors an HView shows: its root and every expanded child, at any depth.
fn visible_anchors(h: &HView, out: &mut BTreeSet<String>) {
    out.insert(h.id.clone());
    for entries in h.props.values() {
        for entry in entries {
            for child in entry.expanded.values() {
                visible_anchors(child, out);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnchoredRead {
    pub result: EvalResult,
    /// The scope E*: the root, the static anchors and every dynamic anchor, sorted.
    pub scope: Vec<String>,
    /// The ids of S(E*), sorted: the deltas the read can depend on.
    pub members: Vec<String>,
}

/// Evaluate an anchored term at `root` over the scope it needs (SPEC-17 §6). The answer equals
/// `eval_term_at` over the whole admitted source. An unanchored term is an error: the caller
/// classifies with `anchor_analysis` first and decides what an unanchored read does.
pub fn eval_anchored(
    term: &Term,
    source: &impl DeltaSource,
    now: f64,
    root: &str,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
    admits: Option<&dyn Fn(&Delta) -> bool>,
) -> Result<AnchoredRead, String> {
    anchored_read(term, source, Some(now), root, registry, bindings, admits)
}

/// The same read with an optional instant: `None` evaluates raw, as `eval_term` does, for the
/// reactor's untimed materializations.
pub(crate) fn anchored_read(
    term: &Term,
    source: &impl DeltaSource,
    now: Option<f64>,
    root: &str,
    registry: Option<&SchemaRegistry>,
    bindings: Option<&Bindings>,
    admits: Option<&dyn Fn(&Delta) -> bool>,
) -> Result<AnchoredRead, String> {
    let anchors = match anchor_analysis(term, registry, bindings) {
        AnchorAnalysis::Anchored { anchors } => anchors,
        AnchorAnalysis::Unanchored(r) => {
            return Err(format!("term is not anchored: {}", r.as_str()))
        }
    };
    let (gather, resolves) = match term {
        Term::Resolve { of, .. } => (of.as_ref(), true),
        t => (t, false),
    };
    let evaluate = |t: &Term, set: &DeltaSet| match now {
        Some(at) => eval_term_at(t, set, at, Some(root), registry, bindings),
        None => eval_term(t, set, Some(root), registry, bindings),
    };
    let mut scope: BTreeSet<String> = anchors.into_iter().collect();
    scope.insert(root.to_string());
    loop {
        let members = scope_ids(source, scope.iter().map(String::as_str), admits);
        let set = source.subset(&members);
        let gathered = evaluate(gather, &set)?;
        let EvalResult::HView(h) = &gathered else {
            return Err("term is not anchored: result-sort".to_string());
        };
        let mut seen = BTreeSet::new();
        visible_anchors(h, &mut seen);
        let missing: Vec<String> = seen.difference(&scope).cloned().collect();
        if missing.is_empty() {
            let result = if resolves {
                evaluate(term, &set)?
            } else {
                gathered
            };
            return Ok(AnchoredRead {
                result,
                scope: scope.into_iter().collect(),
                members,
            });
        }
        scope.extend(missing);
    }
}
