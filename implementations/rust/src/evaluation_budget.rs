//! Invocation-local operational limits. Buckets are per node; occurrences are never deduplicated.
use std::collections::BTreeMap;
#[derive(Debug, Clone, Copy)]
pub struct MaterializationEvaluationLimits {
    pub nodes: usize,
    pub entries: usize,
    pub buckets: usize,
    pub depth: usize,
}
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Summary {
    pub nodes: usize,
    pub entries: usize,
    pub max_buckets: usize,
    pub depth: usize,
}
#[derive(Debug, Clone, Default)]
pub(crate) struct LogicalTree {
    pub own_entries: usize,
    pub own_buckets: usize,
    pub children: BTreeMap<(String, usize, usize), Summary>,
}
impl LogicalTree {
    pub fn summary(&self) -> Summary {
        let mut s = Summary {
            nodes: 1,
            entries: self.own_entries,
            max_buckets: self.own_buckets,
            depth: 1,
        };
        for c in self.children.values() {
            s.nodes += c.nodes;
            s.entries += c.entries;
            s.max_buckets = s.max_buckets.max(c.max_buckets);
            s.depth = s.depth.max(c.depth + 1);
        }
        s
    }
}
#[derive(Clone)]
pub(crate) struct EvalScope {
    pub limits: Option<MaterializationEvaluationLimits>,
    pub path_depth: usize,
    pub bind_readings: bool,
    #[cfg(test)]
    pub visits: std::rc::Rc<std::cell::RefCell<Vec<(usize, &'static str)>>>,
}
impl EvalScope {
    pub fn native(bind_readings: bool) -> Self {
        Self {
            limits: None,
            path_depth: 1,
            bind_readings,
            #[cfg(test)]
            visits: Default::default(),
        }
    }
    pub fn bounded(limits: MaterializationEvaluationLimits) -> Result<Self, String> {
        for (n, max) in [
            (limits.nodes, 4096),
            (limits.entries, 16384),
            (limits.buckets, 256),
            (limits.depth, 32),
        ] {
            if n == 0 || n > max {
                return Err("invalid materialization evaluation limits".into());
            }
        }
        Ok(Self {
            limits: Some(limits),
            ..Self::native(true)
        })
    }
    pub fn check(&self, s: Summary) -> Result<(), String> {
        if self.limits.is_some_and(|l| {
            s.nodes > l.nodes
                || s.entries > l.entries
                || s.max_buckets > l.buckets
                || self.path_depth + s.depth - 1 > l.depth
        }) {
            return Err("resource-limit".into());
        }
        Ok(())
    }
    pub fn descend(&self) -> Result<Self, String> {
        self.visit("descent");
        let next = Self {
            path_depth: self.path_depth + 1,
            ..self.clone()
        };
        next.check(Summary {
            nodes: 1,
            depth: 1,
            ..Default::default()
        })?;
        Ok(next)
    }
    pub fn visit(&self, _event: &'static str) {
        #[cfg(test)]
        self.visits.borrow_mut().push((self.path_depth, _event));
    }
}
