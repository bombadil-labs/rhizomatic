//! The derivation layer (SPEC-7, ERRATA-7). Mirrors ../ts/src/derivation.ts.
//! Everything that computes is an author.

use std::collections::BTreeMap;

use crate::delta::compute_id;
use crate::hview::HView;
use crate::materialize::MaterializationChange;
use crate::reactor::{IngestResult, Reactor};
use crate::schema_deltas::VOCAB_PREFIX;
use crate::set::make_negation_claims;
use crate::sign::{author_for_seed, sign_claims, verify_delta, Verification};
use crate::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};

/// A v0 derived function: substantive pointer lists, one per claim to emit (G1).
pub type DerivedFn = Box<dyn Fn(&HView, &str) -> Vec<Vec<Pointer>>>;

/// EmissionPolicy (SPEC-7 §5, ERRATA-7 G4).
#[derive(Debug, Clone, PartialEq)]
pub enum Emit {
    Append,
    Supersede,
    /// Supersede per-subject: the key is the sorted (entity id, context) pairs of the
    /// substantive entity pointers whose context is in the set; empty key appends (G4).
    Keyed(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct BindingSpec {
    pub name: String,
    pub fn_id: String,
    pub materialization: String,
    pub pure: bool,
    pub budget: u32,
    pub emit: Emit,
}

// The subject key of an emission under Keyed(contexts); "" when nothing matches (G4).
fn emission_key(substantive: &[Pointer], contexts: &[String]) -> String {
    let mut pairs: Vec<String> = substantive
        .iter()
        .filter_map(|p| match &p.target {
            Target::Entity(er) => er.context.as_ref().and_then(|ctx| {
                contexts
                    .contains(ctx)
                    .then(|| format!("{}\u{0001}{}", er.id, ctx))
            }),
            _ => None,
        })
        .collect();
    pairs.sort();
    pairs.join("\u{0002}")
}

struct Installed {
    spec: BindingSpec,
    fn_: DerivedFn,
    seed_hex: String,
    author: String,
    live_emissions: std::collections::BTreeMap<String, Vec<String>>,
    trigger_count: u32,
    suspended: bool,
}

fn role(suffix: &str) -> String {
    format!("{VOCAB_PREFIX}.derived.{suffix}")
}

fn provenance_pointers(spec: &BindingSpec, input_hex: &str) -> Vec<Pointer> {
    vec![
        Pointer {
            role: role("by"),
            target: Target::Entity(EntityRef {
                id: spec.fn_id.clone(),
                context: None,
            }),
        },
        Pointer {
            role: role("from"),
            target: Target::Primitive(Primitive::Str(input_hex.to_string())),
        },
        Pointer {
            role: role("under"),
            target: Target::Entity(EntityRef {
                id: spec.name.clone(),
                context: None,
            }),
        },
    ]
}

/// Build the full claims for one emission — the exact recipe replay verification re-runs (G5).
pub fn derived_claims(
    spec: &BindingSpec,
    author: &str,
    substantive: Vec<Pointer>,
    input_hex: &str,
) -> Claims {
    let mut pointers = substantive;
    pointers.extend(provenance_pointers(spec, input_hex));
    // timestamp 0: pure output must be a function of (fn, input hash) only (G3).
    Claims {
        timestamp: 0.0,
        author: author.to_string(),
        pointers,
    }
}

#[derive(Default)]
pub struct DerivationHost {
    pub reactor: Reactor,
    bindings: BTreeMap<String, Installed>,
}

impl DerivationHost {
    pub fn new(reactor: Reactor) -> Self {
        Self {
            reactor,
            bindings: BTreeMap::new(),
        }
    }

    /// Installation is an assertion: a signed rdb.derived.binds delta (SPEC-7 §3).
    pub fn install(&mut self, spec: BindingSpec, fn_: DerivedFn, seed_hex: &str) -> String {
        assert!(
            !self.bindings.contains_key(&spec.name),
            "duplicate binding: {}",
            spec.name
        );
        let author = author_for_seed(seed_hex).expect("valid seed");
        let binds = sign_claims(
            &Claims {
                timestamp: 0.0,
                author: author.clone(),
                pointers: vec![
                    Pointer {
                        role: role("binds"),
                        target: Target::Entity(EntityRef {
                            id: spec.fn_id.clone(),
                            context: Some("bindings".to_string()),
                        }),
                    },
                    Pointer {
                        role: role("author"),
                        target: Target::Primitive(Primitive::Str(author.clone())),
                    },
                ],
            },
            seed_hex,
        )
        .expect("binds delta signs");
        self.reactor.ingest(binds);
        self.bindings.insert(
            spec.name.clone(),
            Installed {
                spec,
                fn_,
                seed_hex: seed_hex.to_string(),
                author: author.clone(),
                live_emissions: std::collections::BTreeMap::new(),
                trigger_count: 0,
                suspended: false,
            },
        );
        author
    }

    pub fn is_suspended(&self, name: &str) -> bool {
        self.bindings
            .get(name)
            .map(|b| b.suspended)
            .unwrap_or(false)
    }

    pub fn author_of(&self, name: &str) -> Option<&str> {
        self.bindings.get(name).map(|b| b.author.as_str())
    }

    /// The write-back loop (G2): ingest, then drain triggers until quiescent.
    pub fn ingest(&mut self, delta: Delta) -> IngestResult {
        let result = self.reactor.ingest(delta);
        if result != IngestResult::Accepted {
            return result;
        }
        let pending = self.reactor.changes_from_last_ingest().to_vec();
        self.drain(pending);
        result
    }

    fn drain(&mut self, mut pending: Vec<MaterializationChange>) {
        let mut depth = 0;
        while !pending.is_empty() && depth < 32 {
            depth += 1;
            let mut next = Vec::new();
            let names: Vec<String> = self.bindings.keys().cloned().collect();
            for change in &pending {
                for name in &names {
                    if self.bindings[name].spec.materialization != change.materialization {
                        continue;
                    }
                    next.extend(self.trigger(name, change));
                }
            }
            pending = next;
        }
    }

    fn emit_signed(&mut self, name: &str, claims: Claims) -> Vec<MaterializationChange> {
        let seed = self.bindings[name].seed_hex.clone();
        let signed = sign_claims(&claims, &seed).expect("derived emission signs");
        match self.reactor.ingest(signed) {
            IngestResult::Accepted => self.reactor.changes_from_last_ingest().to_vec(),
            IngestResult::Duplicate => Vec::new(),
            IngestResult::Rejected(e) => panic!("derived emission rejected: {e}"),
        }
    }

    fn trigger(
        &mut self,
        name: &str,
        change: &MaterializationChange,
    ) -> Vec<MaterializationChange> {
        let (author, budget, trigger_count, suspended, emit, spec) = {
            let b = &self.bindings[name];
            (
                b.author.clone(),
                b.spec.budget,
                b.trigger_count,
                b.suspended,
                b.spec.emit.clone(),
                b.spec.clone(),
            )
        };
        if suspended {
            return Vec::new();
        }
        // The default non-reentrancy guard (SPEC-7 §6): skip when the trigger is entirely our own.
        let own = change
            .responsible_delta_ids
            .iter()
            .all(|id| self.reactor.get(id).map(|d| d.claims.author == author) == Some(true));
        if own {
            return Vec::new();
        }
        if trigger_count >= budget {
            self.bindings.get_mut(name).unwrap().suspended = true;
            // Divergence becomes an observable event, not a melted reactor (G2).
            let claims = Claims {
                timestamp: 0.0,
                author: author.clone(),
                pointers: vec![Pointer {
                    role: role("suspended"),
                    target: Target::Entity(EntityRef {
                        id: spec.name.clone(),
                        context: Some("suspensions".to_string()),
                    }),
                }],
            };
            return self.emit_signed(name, claims);
        }
        self.bindings.get_mut(name).unwrap().trigger_count += 1;
        let Some(view) = self
            .reactor
            .materialized_view(&change.materialization, &change.root)
            .cloned()
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if emit == Emit::Supersede {
            // Wholesale supersession: negate every live emission before emitting anew (G4).
            let priors = std::mem::take(&mut self.bindings.get_mut(name).unwrap().live_emissions);
            for prior in priors.into_values().flatten() {
                out.extend(
                    self.emit_signed(name, make_negation_claims(&author, 0.0, &prior, None)),
                );
            }
        }
        let emissions = (self.bindings[name].fn_)(&view, &change.root);
        for substantive in emissions {
            let key = match &emit {
                Emit::Keyed(contexts) => emission_key(&substantive, contexts),
                _ => String::new(),
            };
            // Per-subject supersession: negate only same-key priors; an empty key appends (G4).
            if matches!(emit, Emit::Keyed(_)) && !key.is_empty() {
                let priors = self
                    .bindings
                    .get_mut(name)
                    .unwrap()
                    .live_emissions
                    .insert(key.clone(), Vec::new())
                    .unwrap_or_default();
                for prior in priors {
                    out.extend(
                        self.emit_signed(name, make_negation_claims(&author, 0.0, &prior, None)),
                    );
                }
            }
            let claims = derived_claims(&spec, &author, substantive, &change.new_hex);
            let seed = self.bindings[name].seed_hex.clone();
            let signed = sign_claims(&claims, &seed).expect("emission signs");
            let id = signed.id.clone();
            if self.reactor.ingest(signed) == IngestResult::Accepted {
                self.bindings
                    .get_mut(name)
                    .unwrap()
                    .live_emissions
                    .entry(key)
                    .or_default()
                    .push(id);
                out.extend(self.reactor.changes_from_last_ingest().to_vec());
            }
        }
        out
    }
}

/// Pure-replay verification (SPEC-7 §4, G5).
pub fn verify_pure_derivation(
    emitted: &Delta,
    spec: &BindingSpec,
    fn_: &dyn Fn(&HView, &str) -> Vec<Vec<Pointer>>,
    view: &HView,
    root: &str,
    view_hex: &str,
) -> bool {
    if verify_delta(emitted) != Verification::Verified {
        return false;
    }
    let from_ok = emitted.claims.pointers.iter().any(|p| {
        p.role == role("from")
            && matches!(&p.target, Target::Primitive(Primitive::Str(s)) if s == view_hex)
    });
    if !from_ok {
        return false;
    }
    fn_(view, root).into_iter().any(|substantive| {
        let replayed = derived_claims(spec, &emitted.claims.author, substantive, view_hex);
        compute_id(&replayed).map(|id| id == emitted.id) == Ok(true)
    })
}
