//! Explicit semantic AST occurrences, plus a byte lower bound before serialization.
//! Metadata/containers add no AST nodes. Their actual data still consumes artifact bytes.
use crate::eval::{GroupKey, MaskPolicy, PruneKeep, SchemaRef, Term};
use crate::evidence_codec::{limit, ReadingAppearanceLimits, Result, INVALID};
use crate::pred::{EntityMatch, Field, InViewExtract, MatchConst, Param, Pred, StrMatch, ValMatch};
use crate::resolution::{Order, Policy, Schema};
use crate::types::Primitive;
pub(crate) fn check(schema: &Schema, limits: ReadingAppearanceLimits) -> Result<()> {
    Counter {
        count: 0,
        bytes: 0,
        limits,
    }
    .schema(schema, 1)
}
struct Counter {
    count: usize,
    bytes: usize,
    limits: ReadingAppearanceLimits,
}
impl Counter {
    fn add(&mut self, n: usize) -> Result<()> {
        limit(n, self.limits.artifact_bytes)?;
        self.bytes += n;
        limit(self.bytes, self.limits.artifact_bytes)
    }
    fn text(&mut self, s: &str) -> Result<()> {
        self.add(s.len())
    }
    fn primitive(&mut self, p: &Primitive) -> Result<()> {
        self.add(1)?;
        if let Primitive::Str(s) = p {
            self.text(s)?;
        }
        Ok(())
    }
    fn node(&mut self, d: usize) -> Result<()> {
        self.add(1)?;
        self.count += 1;
        limit(self.count, self.limits.syntax_nodes)?;
        limit(d, self.limits.syntax_depth)
    }
    fn schema(&mut self, s: &Schema, d: usize) -> Result<()> {
        self.node(d)?;
        if let Some(n) = &s.name {
            self.text(n)?;
        }
        self.policy(&s.default, d + 1)?;
        for (k, p) in &s.props {
            self.text(k)?;
            self.policy(p, d + 1)?;
        }
        Ok(())
    }
    fn policy(&mut self, p: &Policy, d: usize) -> Result<()> {
        self.node(d)?;
        match p {
            Policy::Pick(o) | Policy::All(o, _) | Policy::Conflicts(o) => self.order(o, d + 1)?,
            Policy::AbsentAs { constant, then } => {
                self.primitive(constant)?;
                self.policy(then, d + 1)?;
            }
            Policy::Merge(_) => {}
        }
        Ok(())
    }
    fn order(&mut self, o: &Order, d: usize) -> Result<()> {
        self.node(d)?;
        match o {
            Order::ByPred { pred, then } => {
                self.pred(pred, d + 1)?;
                self.order(then, d + 1)?;
            }
            Order::Chain(os) => {
                for o in os {
                    self.order(o, d + 1)?;
                }
            }
            Order::ByAuthorRank(ss) => {
                for s in ss {
                    self.add(1)?;
                    self.text(s)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn str_match(&mut self, s: &StrMatch, d: usize) -> Result<()> {
        self.node(d)?;
        match s {
            StrMatch::Exact(s) | StrMatch::Prefix(s) => self.text(s)?,
            StrMatch::InSet(ss) => {
                for s in ss {
                    self.add(1)?;
                    self.text(s)?;
                }
            }
            StrMatch::Aliased(a) => {
                self.text(&a.name)?;
                if let Some(v) = &a.via {
                    self.text(v)?;
                }
                if let Some(p) = &a.trust {
                    self.pred(p, d + 1)?;
                }
            }
        }
        Ok(())
    }
    fn pred(&mut self, p: &Pred, d: usize) -> Result<()> {
        self.node(d)?;
        match p {
            Pred::True | Pred::False => {}
            Pred::ActsFor { root, policy } => {
                self.text(root)?;
                self.node(d + 1)?;
                self.text(&policy.scope)?;
            }
            Pred::Match { constant, .. } => match constant {
                MatchConst::Hole(s) => {
                    self.node(d + 1)?;
                    self.text(s)?;
                }
                MatchConst::One(v) => self.primitive(v)?,
                MatchConst::Many(vs) => {
                    for v in vs {
                        self.primitive(v)?;
                    }
                }
            },
            Pred::And(l, r) | Pred::Or(l, r) => {
                self.pred(l, d + 1)?;
                self.pred(r, d + 1)?;
            }
            Pred::Not(p) => self.pred(p, d + 1)?,
            Pred::HasPointer(p) => {
                self.node(d + 1)?;
                if let Some(s) = &p.target_delta {
                    self.text(s)?;
                }
                if let Some(s) = &p.role {
                    self.str_match(s, d + 2)?;
                }
                if let Some(s) = &p.context {
                    self.str_match(s, d + 2)?;
                }
                if let Some(e) = &p.target_entity {
                    self.node(d + 2)?;
                    match e {
                        EntityMatch::Const(s) | EntityMatch::Hole(s) => self.text(s)?,
                        EntityMatch::Root => {}
                    }
                }
                if let Some(v) = &p.target_value {
                    self.node(d + 2)?;
                    match v {
                        ValMatch::Vcmp { value, .. } => match value {
                            Param::Hole(s) => {
                                self.node(d + 3)?;
                                self.text(s)?;
                            }
                            Param::Lit(v) => self.primitive(v)?,
                        },
                        ValMatch::Between { lo, hi } => {
                            self.primitive(lo)?;
                            self.primitive(hi)?;
                        }
                        ValMatch::InSet(vs) => {
                            for v in vs {
                                self.primitive(v)?;
                            }
                        }
                    }
                }
            }
            Pred::InView {
                term,
                field,
                extract,
            } => {
                if matches!(field, Field::Timestamp) {
                    return Err(INVALID);
                }
                self.term(term, d + 1)?;
                self.node(d + 1)?;
                if let InViewExtract::Role(s) = extract {
                    self.text(s)?;
                }
            }
        }
        Ok(())
    }
    fn reference(&mut self, r: &SchemaRef, d: usize) -> Result<()> {
        self.node(d)?;
        match r {
            SchemaRef::Name(s) | SchemaRef::Pinned(s) => self.text(s),
        }
    }
    fn term(&mut self, t: &Term, d: usize) -> Result<()> {
        self.node(d)?;
        match t {
            Term::Input => {}
            Term::Select { pred, of } => {
                self.pred(pred, d + 1)?;
                self.term(of, d + 1)?;
            }
            Term::Union { left, right } | Term::Intersect { left, right } => {
                self.term(left, d + 1)?;
                self.term(right, d + 1)?;
            }
            Term::Difference { of, without } => {
                self.term(of, d + 1)?;
                self.term(without, d + 1)?;
            }
            Term::Mask { policy, of } => {
                self.node(d + 1)?;
                if let MaskPolicy::Trust(p) = policy {
                    self.pred(p, d + 2)?;
                }
                self.term(of, d + 1)?;
            }
            Term::Group { key, of } => {
                self.node(d + 1)?;
                if let GroupKey::Const(s) = key {
                    self.text(s)?;
                }
                self.term(of, d + 1)?;
            }
            Term::Prune { keep, of } => {
                if let PruneKeep::Match(s) = keep {
                    self.str_match(s, d + 1)?;
                }
                self.term(of, d + 1)?;
            }
            Term::Expand {
                role,
                schema,
                reading,
                of,
            } => {
                self.str_match(role, d + 1)?;
                self.reference(schema, d + 1)?;
                if let Some(r) = reading {
                    self.reference(r, d + 1)?;
                }
                self.term(of, d + 1)?;
            }
            Term::Fix {
                schema,
                entity,
                bindings,
            } => {
                self.text(entity)?;
                if let Some(bs) = bindings {
                    for (k, v) in bs {
                        self.text(k)?;
                        self.primitive(v)?;
                    }
                }
                self.reference(schema, d + 1)?;
            }
            Term::Resolve { schema, of } => {
                self.schema(schema, d + 1)?;
                self.term(of, d + 1)?;
            }
        }
        Ok(())
    }
}
