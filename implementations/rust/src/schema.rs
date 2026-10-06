//! HyperSchemas and the schema registry (SPEC-3 §2-3 §6, ERRATA-2 E10/E13).
//! Mirrors ../ts/src/schema.ts: indexed by name AND by term hash; pinned refs resolve by hash.
//! Since issue #23 it also holds resolution Schemas ("readings"), indexed the same two ways, so
//! an expand term can name both halves of a child's lens and be validated at build time.

use std::collections::HashMap;

use crate::eval::{SchemaRef, Term};
use crate::resolution::Schema;
use crate::term_io::{schema_hash, term_hash};

#[derive(Debug, Clone, PartialEq)]
pub struct HyperSchema {
    pub name: String,
    /// L2 algebra version
    pub alg: u32,
    /// an HView-sort term, a function of the ambient root
    pub body: Term,
}

/// refs are derived from the body — every expand/fix schema reference (E10).
pub fn collect_refs(term: &Term) -> Vec<SchemaRef> {
    let mut out = Vec::new();
    fn walk(t: &Term, out: &mut Vec<SchemaRef>) {
        match t {
            Term::Input => {}
            Term::Select { of, .. }
            | Term::Mask { of, .. }
            | Term::Group { of, .. }
            | Term::Prune { of, .. }
            | Term::Resolve { of, .. } => walk(of, out),
            Term::Union { left, right } | Term::Intersect { left, right } => {
                walk(left, out);
                walk(right, out);
            }
            Term::Difference { of, without } => {
                walk(of, out);
                walk(without, out);
            }
            Term::Expand { schema, of, .. } => {
                out.push(schema.clone());
                walk(of, out);
            }
            Term::Fix { schema, .. } => out.push(schema.clone()),
        }
    }
    walk(term, &mut out);
    out
}

/// Reading refs are derived the same way — every expand's `reading` (issue #23). Kept separate
/// from collect_refs because they resolve against a different index (readings, not hyperschemas).
pub fn collect_reading_refs(term: &Term) -> Vec<SchemaRef> {
    let mut out = Vec::new();
    fn walk(t: &Term, out: &mut Vec<SchemaRef>) {
        match t {
            Term::Input | Term::Fix { .. } => {}
            Term::Select { of, .. }
            | Term::Mask { of, .. }
            | Term::Group { of, .. }
            | Term::Prune { of, .. }
            | Term::Resolve { of, .. } => walk(of, out),
            Term::Union { left, right } | Term::Intersect { left, right } => {
                walk(left, out);
                walk(right, out);
            }
            Term::Difference { of, without } => {
                walk(of, out);
                walk(without, out);
            }
            Term::Expand { reading, of, .. } => {
                if let Some(r) = reading {
                    out.push(r.clone());
                }
                walk(of, out);
            }
        }
    }
    walk(term, &mut out);
    out
}

#[derive(Debug, Clone, Default)]
pub struct SchemaRegistry {
    by_name: HashMap<String, HyperSchema>,
    by_hash: HashMap<String, HyperSchema>,
    readings_by_name: HashMap<String, Schema>,
    readings_by_hash: HashMap<String, Schema>,
}

impl SchemaRegistry {
    /// Rejects duplicate names, unresolved refs (gather AND reading), and reference cycles
    /// (SPEC-3 §3). Data cycles remain legal — the DAG constraint is on programs, not data.
    pub fn build(schemas: Vec<HyperSchema>, readings: Vec<Schema>) -> Result<Self, String> {
        let mut readings_by_name: HashMap<String, Schema> = HashMap::new();
        let mut readings_by_hash: HashMap<String, Schema> = HashMap::new();
        for r in &readings {
            let name = r
                .name
                .as_ref()
                .ok_or("a registered reading must carry a name (issue #23)")?;
            if readings_by_name.contains_key(name) {
                return Err(format!("duplicate reading name: {name}"));
            }
            readings_by_name.insert(name.clone(), r.clone());
            let h = schema_hash(r)?;
            // As with hyperschema bodies, two names MAY share a hash; first registration wins.
            readings_by_hash.entry(h).or_insert_with(|| r.clone());
        }
        let resolve_reading_ref = |r: &SchemaRef, from: &str| -> Result<(), String> {
            let found = match r {
                SchemaRef::Name(n) => readings_by_name.contains_key(n),
                SchemaRef::Pinned(h) => readings_by_hash.contains_key(h),
            };
            if found {
                return Ok(());
            }
            let label = match r {
                SchemaRef::Name(n) => n.clone(),
                SchemaRef::Pinned(h) => format!("pinned:{h}"),
            };
            Err(format!(
                "schema {from} references unknown reading {label} (issue #23)"
            ))
        };
        let mut by_name: HashMap<String, HyperSchema> = HashMap::new();
        let mut by_hash: HashMap<String, HyperSchema> = HashMap::new();
        for s in &schemas {
            if by_name.contains_key(&s.name) {
                return Err(format!("duplicate schema name: {}", s.name));
            }
            by_name.insert(s.name.clone(), s.clone());
            let h = term_hash(&s.body)?;
            // Two names MAY share a body hash; first registration wins the hash index.
            by_hash.entry(h).or_insert_with(|| s.clone());
            for r in collect_reading_refs(&s.body) {
                resolve_reading_ref(&r, &s.name)?;
            }
        }
        let resolve_name = |r: &SchemaRef, from: &str| -> Result<String, String> {
            match r {
                SchemaRef::Name(n) => by_name
                    .get(n)
                    .map(|s| s.name.clone())
                    .ok_or(format!("schema {from} references unknown schema {n}")),
                SchemaRef::Pinned(h) => by_hash.get(h).map(|s| s.name.clone()).ok_or(format!(
                    "schema {from} references unknown pinned schema {h} (E13)"
                )),
            }
        };
        let mut refs: HashMap<String, Vec<String>> = HashMap::new();
        for s in &schemas {
            let rs = collect_refs(&s.body)
                .iter()
                .map(|r| resolve_name(r, &s.name))
                .collect::<Result<Vec<_>, _>>()?;
            refs.insert(s.name.clone(), rs);
        }
        // DFS cycle detection over the resolved reference graph.
        #[derive(PartialEq)]
        enum State {
            Visiting,
            Done,
        }
        fn visit(
            name: &str,
            path: &mut Vec<String>,
            refs: &HashMap<String, Vec<String>>,
            state: &mut HashMap<String, State>,
        ) -> Result<(), String> {
            match state.get(name) {
                Some(State::Done) => return Ok(()),
                Some(State::Visiting) => {
                    return Err(format!(
                        "schema reference cycle: {} -> {name} (SPEC-3 §3)",
                        path.join(" -> ")
                    ));
                }
                None => {}
            }
            state.insert(name.to_string(), State::Visiting);
            path.push(name.to_string());
            if let Some(rs) = refs.get(name) {
                for r in rs {
                    visit(r, path, refs, state)?;
                }
            }
            path.pop();
            state.insert(name.to_string(), State::Done);
            Ok(())
        }
        let mut state = HashMap::new();
        for s in &schemas {
            visit(&s.name, &mut Vec::new(), &refs, &mut state)?;
        }
        Ok(Self {
            by_name,
            by_hash,
            readings_by_name,
            readings_by_hash,
        })
    }

    pub fn get(&self, name: &str) -> Option<&HyperSchema> {
        self.by_name.get(name)
    }

    pub fn get_by_hash(&self, hash: &str) -> Option<&HyperSchema> {
        self.by_hash.get(hash)
    }

    pub fn resolve(&self, r: &SchemaRef) -> Option<&HyperSchema> {
        match r {
            SchemaRef::Name(n) => self.by_name.get(n),
            SchemaRef::Pinned(h) => self.by_hash.get(h),
        }
    }

    pub fn get_reading(&self, name: &str) -> Option<&Schema> {
        self.readings_by_name.get(name)
    }

    pub fn resolve_reading(&self, r: &SchemaRef) -> Option<&Schema> {
        match r {
            SchemaRef::Name(n) => self.readings_by_name.get(n),
            SchemaRef::Pinned(h) => self.readings_by_hash.get(h),
        }
    }

    /// Evaluation overlay: retain signed name/hash lookups while lowering runtime bodies.
    pub fn map_evaluation_bodies<F, G>(&self, map_term: F, map_reading: G) -> Result<Self, String>
    where
        F: Fn(&Term) -> Result<Term, String>,
        G: Fn(&Schema) -> Result<Schema, String>,
    {
        let by_name: HashMap<String, HyperSchema> = self
            .by_name
            .iter()
            .map(|(name, schema)| {
                Ok((
                    name.clone(),
                    HyperSchema {
                        body: map_term(&schema.body)?,
                        ..schema.clone()
                    },
                ))
            })
            .collect::<Result<_, String>>()?;
        let by_hash = self
            .by_hash
            .iter()
            .map(|(hash, schema)| Ok((hash.clone(), by_name[&schema.name].clone())))
            .collect::<Result<_, String>>()?;
        let readings_by_name: HashMap<String, Schema> = self
            .readings_by_name
            .iter()
            .map(|(name, reading)| Ok((name.clone(), map_reading(reading)?)))
            .collect::<Result<_, String>>()?;
        let readings_by_hash = self
            .readings_by_hash
            .iter()
            .map(|(hash, reading)| {
                let name = reading
                    .name
                    .as_ref()
                    .expect("registered reading has a name");
                Ok((hash.clone(), readings_by_name[name].clone()))
            })
            .collect::<Result<_, String>>()?;
        Ok(Self {
            by_name,
            by_hash,
            readings_by_name,
            readings_by_hash,
        })
    }
}

/// Complete executable reference discovery for explicit definition selection. Legacy registry
/// construction keeps its established compatibility behavior; this walk includes predicates,
/// orders, aliased trust predicates and anonymous resolution Schemas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramSort {
    DSet,
    HView,
    View,
}
#[derive(Debug, Clone)]
pub struct ProgramReference {
    pub reference: SchemaRef,
    pub reading: bool,
    pub bindings: crate::pred::Bindings,
}
#[derive(Debug, Clone, Default)]
pub struct ProgramInspection {
    pub references: Vec<ProgramReference>,
    pub acts_for: bool,
    pub contextual_reading: bool,
    pub invalid: bool,
}
impl ProgramInspection {
    fn reference(
        &mut self,
        reference: &SchemaRef,
        reading: bool,
        bindings: &crate::pred::Bindings,
    ) {
        self.references.push(ProgramReference {
            reference: reference.clone(),
            reading,
            bindings: bindings.clone(),
        });
    }
    fn string_match(&mut self, m: &crate::pred::StrMatch, b: &crate::pred::Bindings) {
        if let crate::pred::StrMatch::Aliased(a) = m {
            if let Some(p) = &a.trust {
                self.predicate(p, b);
            }
        }
    }
    fn predicate(&mut self, p: &crate::pred::Pred, b: &crate::pred::Bindings) {
        use crate::pred::{EntityMatch, MatchConst, Param, Pred, ValMatch};
        match p {
            Pred::ActsFor { .. } => self.acts_for = true,
            Pred::Match {
                constant: MatchConst::Hole(h),
                ..
            } => self.invalid |= !b.contains_key(h),
            Pred::HasPointer(p) => {
                if let Some(EntityMatch::Hole(h)) = &p.target_entity {
                    self.invalid |= !matches!(b.get(h), Some(crate::types::Primitive::Str(_)));
                }
                if let Some(ValMatch::Vcmp {
                    value: Param::Hole(h),
                    ..
                }) = &p.target_value
                {
                    self.invalid |= !b.contains_key(h);
                }
                for m in [&p.role, &p.context].into_iter().flatten() {
                    self.string_match(m, b);
                }
            }
            Pred::And(l, r) | Pred::Or(l, r) => {
                self.predicate(l, b);
                self.predicate(r, b);
            }
            Pred::Not(p) => self.predicate(p, b),
            Pred::InView { term, .. } => {
                self.invalid |= self.term(term, b) != Some(ProgramSort::DSet)
            }
            _ => {}
        }
    }
    fn order(&mut self, o: &crate::resolution::Order, b: &crate::pred::Bindings) {
        use crate::resolution::Order;
        match o {
            Order::ByPred { pred, then } => {
                fn contextual(p: &crate::pred::Pred) -> bool {
                    use crate::pred::{Pred, StrMatch};
                    match p {
                        Pred::ActsFor { .. } | Pred::InView { .. } => true,
                        Pred::And(l, r) | Pred::Or(l, r) => contextual(l) || contextual(r),
                        Pred::Not(p) => contextual(p),
                        Pred::HasPointer(p) => [&p.role, &p.context]
                            .into_iter()
                            .flatten()
                            .any(|s| matches!(s, StrMatch::Aliased(_))),
                        _ => false,
                    }
                }
                self.contextual_reading |= contextual(pred);
                self.predicate(pred, b);
                self.order(then, b);
            }
            Order::Chain(xs) => {
                for x in xs {
                    self.order(x, b);
                }
            }
            _ => {}
        }
    }
    fn policy(&mut self, p: &crate::resolution::Policy, b: &crate::pred::Bindings) {
        use crate::resolution::Policy;
        match p {
            Policy::Pick(o) | Policy::All(o, _) | Policy::Conflicts(o) => self.order(o, b),
            Policy::AbsentAs { then, .. } => self.policy(then, b),
            _ => {}
        }
    }
    fn reading(&mut self, s: &Schema, b: &crate::pred::Bindings) {
        for p in s.props.values() {
            self.policy(p, b);
        }
        self.policy(&s.default, b);
    }
    fn term(&mut self, t: &Term, b: &crate::pred::Bindings) -> Option<ProgramSort> {
        use crate::eval::{MaskPolicy, PruneKeep};
        let result = match t {
            Term::Input => Some(ProgramSort::DSet),
            Term::Select { pred, of } => {
                self.predicate(pred, b);
                (self.term(of, b) == Some(ProgramSort::DSet)).then_some(ProgramSort::DSet)
            }
            Term::Mask { policy, of } => {
                if let MaskPolicy::Trust(p) = policy {
                    self.predicate(p, b);
                }
                (self.term(of, b) == Some(ProgramSort::DSet)).then_some(ProgramSort::DSet)
            }
            Term::Union { left, right } | Term::Intersect { left, right } => {
                let l = self.term(left, b);
                let r = self.term(right, b);
                (l == Some(ProgramSort::DSet) && r == Some(ProgramSort::DSet))
                    .then_some(ProgramSort::DSet)
            }
            Term::Difference { of, without } => {
                let l = self.term(of, b);
                let r = self.term(without, b);
                (l == Some(ProgramSort::DSet) && r == Some(ProgramSort::DSet))
                    .then_some(ProgramSort::DSet)
            }
            Term::Group { of, .. } => {
                (self.term(of, b) == Some(ProgramSort::DSet)).then_some(ProgramSort::HView)
            }
            Term::Prune { keep, of } => {
                if let PruneKeep::Match(m) = keep {
                    self.string_match(m, b);
                }
                (self.term(of, b) == Some(ProgramSort::HView)).then_some(ProgramSort::HView)
            }
            Term::Expand {
                role,
                schema,
                reading,
                of,
            } => {
                self.string_match(role, b);
                self.reference(schema, false, b);
                if let Some(r) = reading {
                    self.reference(r, true, b);
                } else {
                    self.invalid = true;
                }
                (self.term(of, b) == Some(ProgramSort::HView)).then_some(ProgramSort::HView)
            }
            Term::Fix {
                schema, bindings, ..
            } => {
                self.reference(schema, false, bindings.as_ref().unwrap_or(b));
                Some(ProgramSort::HView)
            }
            Term::Resolve { schema, of } => {
                self.reading(schema, b);
                (self.term(of, b) == Some(ProgramSort::HView)).then_some(ProgramSort::View)
            }
        };
        self.invalid |= result.is_none();
        result
    }
}
pub fn inspect_program_term(
    term: &Term,
    bindings: &crate::pred::Bindings,
) -> (ProgramInspection, Option<ProgramSort>) {
    let mut inspection = ProgramInspection::default();
    let sort = inspection.term(term, bindings);
    (inspection, sort)
}
pub fn inspect_program_reading(
    reading: &Schema,
    bindings: &crate::pred::Bindings,
) -> ProgramInspection {
    let mut inspection = ProgramInspection::default();
    inspection.reading(reading, bindings);
    inspection
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramSelectionError {
    PinMismatch,
    AmbiguousDefinition,
    DefinitionClosure,
    DefinitionCycle,
    InvalidProgram,
}
#[derive(Debug, Clone)]
pub struct SelectedProgram {
    pub gather: HyperSchema,
    pub reading: Schema,
    pub registry: SchemaRegistry,
}
pub struct ProgramSelection<'a> {
    pub top_gather: &'a str,
    pub top_reading: &'a str,
    pub gather_pin: &'a str,
    pub reading_pin: &'a str,
    pub bindings: &'a crate::pred::Bindings,
    pub allow_principal: bool,
}
/// Validate the exact supplied closure in stable category order. Inputs are in signed-ID order;
/// names and content pins resolve solely within this registry, preserving first-content rules.
pub fn select_program(
    gathers: Vec<(String, HyperSchema)>,
    readings: Vec<(String, Schema)>,
    selection: ProgramSelection<'_>,
) -> Result<SelectedProgram, ProgramSelectionError> {
    select_program_mode(gathers, readings, selection, false)
}
pub fn select_materialization_program(
    gathers: Vec<(String, HyperSchema)>,
    readings: Vec<(String, Schema)>,
    mut selection: ProgramSelection<'_>,
) -> Result<SelectedProgram, ProgramSelectionError> {
    selection.allow_principal = false;
    select_program_mode(gathers, readings, selection, true)
}
fn select_program_mode(
    gathers: Vec<(String, HyperSchema)>,
    readings: Vec<(String, Schema)>,
    selection: ProgramSelection<'_>,
    pure_reading_orders: bool,
) -> Result<SelectedProgram, ProgramSelectionError> {
    let ProgramSelection {
        top_gather,
        top_reading,
        gather_pin,
        reading_pin,
        bindings,
        allow_principal,
    } = selection;
    use ProgramSelectionError as E;
    #[derive(Clone)]
    enum Body {
        Gather(HyperSchema),
        Reading(Schema),
    }
    let mut bodies: Vec<(String, Body)> = gathers
        .into_iter()
        .map(|(id, s)| (id, Body::Gather(s)))
        .chain(readings.into_iter().map(|(id, s)| (id, Body::Reading(s))))
        .collect();
    bodies.sort_by(|a, b| a.0.cmp(&b.0));
    let gather_index = bodies
        .iter()
        .position(|(id, b)| id == top_gather && matches!(b, Body::Gather(_)))
        .ok_or(E::InvalidProgram)?;
    let reading_index = bodies
        .iter()
        .position(|(id, b)| id == top_reading && matches!(b, Body::Reading(_)))
        .ok_or(E::InvalidProgram)?;
    let hash = |body: &Body| match body {
        Body::Gather(s) => term_hash(&s.body),
        Body::Reading(s) => crate::term_io::schema_hash(s),
    };
    if hash(&bodies[gather_index].1).map_err(|_| E::InvalidProgram)? != gather_pin
        || hash(&bodies[reading_index].1).map_err(|_| E::InvalidProgram)? != reading_pin
    {
        return Err(E::PinMismatch);
    }
    let mut names: HashMap<(bool, String), usize> = HashMap::new();
    let mut hashes: HashMap<(bool, String), usize> = HashMap::new();
    for (i, (_, body)) in bodies.iter().enumerate() {
        let (reading, name) = match body {
            Body::Gather(s) => (false, s.name.clone()),
            Body::Reading(s) => (true, s.name.clone().ok_or(E::InvalidProgram)?),
        };
        if names.insert((reading, name), i).is_some() {
            return Err(E::AmbiguousDefinition);
        }
        hashes
            .entry((reading, hash(body).map_err(|_| E::InvalidProgram)?))
            .or_insert(i);
    }
    let resolve = |r: &ProgramReference| {
        match &r.reference {
            SchemaRef::Name(n) => names.get(&(r.reading, n.clone())),
            SchemaRef::Pinned(h) => hashes.get(&(r.reading, h.clone())),
        }
        .copied()
        .ok_or(E::DefinitionClosure)
    };
    let inspect = |body: &Body, b: &crate::pred::Bindings| match body {
        Body::Gather(s) => {
            let (mut a, sort) = inspect_program_term(&s.body, b);
            a.invalid |= sort != Some(ProgramSort::HView);
            a
        }
        Body::Reading(s) => inspect_program_reading(s, b),
    };
    let edges = bodies
        .iter()
        .map(|(_, body)| {
            inspect(body, bindings)
                .references
                .iter()
                .map(&resolve)
                .collect::<Result<Vec<_>, E>>()
        })
        .collect::<Result<Vec<_>, E>>()?;
    fn reach(i: usize, edges: &[Vec<usize>], seen: &mut std::collections::BTreeSet<usize>) {
        if seen.insert(i) {
            for j in &edges[i] {
                reach(*j, edges, seen);
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    reach(gather_index, &edges, &mut seen);
    reach(reading_index, &edges, &mut seen);
    if seen.len() != bodies.len() {
        return Err(E::DefinitionClosure);
    }
    fn cycle(i: usize, edges: &[Vec<usize>], states: &mut [u8]) -> bool {
        if states[i] == 1 {
            return true;
        }
        if states[i] == 2 {
            return false;
        }
        states[i] = 1;
        for j in &edges[i] {
            if cycle(*j, edges, states) {
                return true;
            }
        }
        states[i] = 2;
        false
    }
    let mut states = vec![0; bodies.len()];
    for i in 0..bodies.len() {
        if cycle(i, &edges, &mut states) {
            return Err(E::DefinitionCycle);
        }
    }
    // Walk each invocation environment after the DAG is known. Fix's explicit bindings shadow
    // the request environment; an unrelated branch cannot supply another branch's holes.
    let mut pending = vec![
        (gather_index, bindings.clone()),
        (reading_index, bindings.clone()),
    ];
    let mut checked = Vec::new();
    while let Some((i, b)) = pending.pop() {
        if checked
            .iter()
            .any(|(index, environment)| *index == i && environment == &b)
        {
            continue;
        }
        checked.push((i, b.clone()));
        let a = inspect(&bodies[i].1, &b);
        if a.invalid
            || (!allow_principal && a.acts_for)
            || (pure_reading_orders && a.contextual_reading)
        {
            return Err(E::InvalidProgram);
        }
        for r in a.references {
            pending.push((resolve(&r)?, r.bindings));
        }
    }
    let gathers = bodies
        .iter()
        .filter_map(|(_, b)| {
            if let Body::Gather(s) = b {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    let readings = bodies
        .iter()
        .filter_map(|(_, b)| {
            if let Body::Reading(s) = b {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    let registry = SchemaRegistry::build(gathers, readings).map_err(|_| E::InvalidProgram)?;
    let Body::Gather(gather) = &bodies[gather_index].1 else {
        unreachable!()
    };
    let Body::Reading(reading) = &bodies[reading_index].1 else {
        unreachable!()
    };
    Ok(SelectedProgram {
        gather: gather.clone(),
        reading: reading.clone(),
        registry,
    })
}
