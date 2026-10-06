//! Semantic JSON-profile positions, before allocating native ASTs.
use crate::cbor::CborValue;
use crate::evidence_codec::{limit, ReadingAppearanceLimits, Result};
#[derive(Clone, Copy)]
enum Family {
    Schema,
    Policy,
    Order,
    Pred,
    PPred,
    Str,
    Val,
    Entity,
    Hole,
    Mask,
    Group,
    Ref,
    Extract,
    Principal,
    Term,
}
fn field<'a>(v: &'a CborValue, k: &str) -> Option<&'a CborValue> {
    if let CborValue::Map(fs) = v {
        fs.iter().find(|(key, _)| key == k).map(|(_, v)| v)
    } else {
        None
    }
}
pub(crate) fn check(root: &CborValue, limits: ReadingAppearanceLimits) -> Result<()> {
    check_program(&[(root, true)], limits)
}
pub(crate) fn check_program(
    definitions: &[(&CborValue, bool)],
    limits: ReadingAppearanceLimits,
) -> Result<()> {
    let mut counter = Counter { count: 0, limits };
    for (body, reading) in definitions {
        counter.visit(
            Some(body),
            if *reading {
                Family::Schema
            } else {
                Family::Term
            },
            1,
        )?;
    }
    Ok(())
}
struct Counter {
    count: usize,
    limits: ReadingAppearanceLimits,
}
impl Counter {
    fn child(&mut self, v: &CborValue, k: &str, f: Family, d: usize) -> Result<()> {
        self.visit(field(v, k), f, d + 1)
    }
    fn inner(&mut self, v: &CborValue, k: &str, key: &str, f: Family, d: usize) -> Result<()> {
        self.visit(field(v, k).and_then(|v| field(v, key)), f, d + 1)
    }
    fn many(&mut self, v: Option<&CborValue>, f: Family, d: usize) -> Result<()> {
        if let Some(CborValue::Array(vs)) = v {
            for v in vs {
                self.visit(Some(v), f, d + 1)?;
            }
        }
        Ok(())
    }
    fn hole(&mut self, v: Option<&CborValue>, d: usize) -> Result<()> {
        if v.is_some_and(|v| field(v, "hole").is_some()) {
            self.visit(v, Family::Hole, d + 1)?;
        }
        Ok(())
    }
    fn visit(&mut self, value: Option<&CborValue>, family: Family, d: usize) -> Result<()> {
        let Some(v) = value else {
            return Ok(());
        };
        self.count += 1;
        limit(self.count, self.limits.syntax_nodes)?;
        limit(d, self.limits.syntax_depth)?;
        use Family::{
            Entity, Extract, Group, Hole, Mask, Order, PPred, Policy, Pred, Principal, Ref, Schema,
            Str, Term, Val,
        };
        match family {
            Schema => {
                self.child(v, "default", Policy, d)?;
                if let Some(CborValue::Map(fs)) = field(v, "props") {
                    for (_, p) in fs {
                        self.visit(Some(p), Policy, d + 1)?;
                    }
                }
            }
            Policy => {
                for k in ["pick", "all", "conflicts"] {
                    self.inner(v, k, "order", Order, d)?;
                }
                self.inner(v, "absentAs", "then", Policy, d)?;
            }
            Order => {
                self.inner(v, "byPred", "pred", Pred, d)?;
                self.inner(v, "byPred", "then", Order, d)?;
                self.many(field(v, "chain"), Order, d)?;
            }
            Pred => {
                self.hole(field(v, "match").and_then(|v| field(v, "const")), d)?;
                self.child(v, "hasPointer", PPred, d)?;
                self.many(field(v, "and"), Pred, d)?;
                self.many(field(v, "or"), Pred, d)?;
                self.child(v, "not", Pred, d)?;
                self.inner(v, "actsFor", "policy", Principal, d)?;
                self.inner(v, "inView", "term", Term, d)?;
                self.inner(v, "inView", "extract", Extract, d)?;
            }
            PPred => {
                self.child(v, "role", Str, d)?;
                self.child(v, "context", Str, d)?;
                self.child(v, "targetEntity", Entity, d)?;
                self.child(v, "targetValue", Val, d)?;
            }
            Str => self.inner(v, "aliased", "trust", Pred, d)?,
            Val => self.hole(field(v, "vcmp").and_then(|v| field(v, "value")), d)?,
            Mask => self.child(v, "trust", Pred, d)?,
            Term => {
                let op = match field(v, "op") {
                    Some(CborValue::Tstr(s)) => s.as_str(),
                    _ => "",
                };
                match op {
                    "select" => {
                        self.child(v, "pred", Pred, d)?;
                        self.child(v, "in", Term, d)?;
                    }
                    "union" | "intersect" => {
                        self.child(v, "left", Term, d)?;
                        self.child(v, "right", Term, d)?;
                    }
                    "difference" => {
                        self.child(v, "of", Term, d)?;
                        self.child(v, "without", Term, d)?;
                    }
                    "mask" => {
                        self.child(v, "policy", Mask, d)?;
                        self.child(v, "in", Term, d)?;
                    }
                    "group" => {
                        self.child(v, "key", Group, d)?;
                        self.child(v, "in", Term, d)?;
                    }
                    "prune" => {
                        if !matches!(field(v,"keep"),Some(CborValue::Tstr(s)) if s=="all") {
                            self.child(v, "keep", Str, d)?;
                        }
                        self.child(v, "in", Term, d)?;
                    }
                    "expand" => {
                        self.child(v, "role", Str, d)?;
                        self.child(v, "schema", Ref, d)?;
                        self.child(v, "reading", Ref, d)?;
                        self.child(v, "in", Term, d)?;
                    }
                    "fix" => self.child(v, "schema", Ref, d)?,
                    "resolve" => {
                        self.child(v, "schema", Schema, d)?;
                        self.child(v, "in", Term, d)?;
                    }
                    _ => {}
                }
            }
            Entity | Hole | Group | Ref | Extract | Principal => {}
        }
        Ok(())
    }
}
