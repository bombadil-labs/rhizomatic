//! HyperSchemas and the schema registry (SPEC-3 §2-3 §6, ERRATA-2 E10/E13).
//! Mirrors ../ts/src/schema.ts: indexed by name AND by term hash; pinned refs resolve by hash.

use std::collections::HashMap;

use crate::eval::{SchemaRef, Term};
use crate::term_io::term_hash;

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

#[derive(Debug, Clone, Default)]
pub struct SchemaRegistry {
    by_name: HashMap<String, HyperSchema>,
    by_hash: HashMap<String, HyperSchema>,
}

impl SchemaRegistry {
    /// Rejects duplicate names, unresolved refs, and reference cycles (SPEC-3 §3).
    /// Data cycles remain legal — the DAG constraint is on programs, not data.
    pub fn build(schemas: Vec<HyperSchema>) -> Result<Self, String> {
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
        Ok(Self { by_name, by_hash })
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
}
