//! Federation (SPEC-6, ERRATA-6). Mirrors ../ts/src/peer.ts.
//! Merge is union; this layer is selection and trust. Coordination without conscription.

use std::collections::BTreeSet;

use crate::eval::{eval_term, EvalResult, Term};
use crate::pred::{eval_pred, Pred};
use crate::reactor::{manifest_member_ids, IngestResult, Reactor};
use crate::sign::{author_for_seed, sign_claims, verify_delta, Verification};
use crate::types::{Claims, Delta};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncReport {
    pub offered: usize,
    pub bundles: usize,
    pub loose: usize,
    /// unsigned, uncovered: they stay local (F3)
    pub withheld: usize,
    pub accepted: usize,
    pub rejected: usize,
}

pub struct Peer {
    pub reactor: Reactor,
    pub author: String,
    seed_hex: String,
    /// What this peer offers to others (F4). None = everything.
    pub offered_lens: Option<Term>,
    /// What this peer accepts (SPEC-6 §5 step 3). None = everything that verifies.
    pub admission: Option<Pred>,
}

impl Peer {
    pub fn new(seed_hex: &str) -> Self {
        Self {
            reactor: Reactor::new(),
            author: author_for_seed(seed_hex).expect("valid seed"),
            seed_hex: seed_hex.to_string(),
            offered_lens: None,
            admission: None,
        }
    }

    /// Author a claim as this peer: sign and ingest (read-your-writes).
    pub fn author_claims(&mut self, timestamp: f64, pointers: Vec<crate::types::Pointer>) -> Delta {
        let claims = Claims {
            timestamp,
            author: self.author.clone(),
            pointers,
        };
        let signed = sign_claims(&claims, &self.seed_hex).expect("own claims sign");
        match self.reactor.ingest(signed.clone()) {
            IngestResult::Rejected(e) => panic!("own claim rejected: {e}"),
            _ => signed,
        }
    }

    /// The offered set: eval(lens, log) — lens fidelity is a tested invariant (F4).
    pub fn offered_set(&self) -> Vec<Delta> {
        let lens = self.offered_lens.clone().unwrap_or(Term::Input);
        match eval_term(&lens, &self.reactor.snapshot(), None, None).expect("lens evaluates") {
            EvalResult::DSet { set, .. } => set.iter().cloned().collect(),
            _ => panic!("a lens must be a DSet-sort term (F4)"),
        }
    }

    /// Pull from another peer: WANT(my ids) -> OFFER/BUNDLE -> verify -> admission -> ingest (§5).
    pub fn pull_from(&mut self, other: &Peer) -> SyncReport {
        let have: BTreeSet<String> = self
            .reactor
            .arrival_log()
            .iter()
            .map(|d| d.id.clone())
            .collect();
        let offered: Vec<Delta> = other
            .offered_set()
            .into_iter()
            .filter(|d| !have.contains(&d.id))
            .collect();
        let offered_ids: BTreeSet<&str> = offered.iter().map(|d| d.id.as_str()).collect();

        let is_signed_manifest = |d: &Delta| {
            d.sig.is_some()
                && verify_delta(d) == Verification::Verified
                && !manifest_member_ids(d).is_empty()
        };

        // Partition per the signature boundary (F3).
        let mut bundles: Vec<(Delta, Vec<Delta>)> = Vec::new();
        let mut covered: BTreeSet<String> = BTreeSet::new();
        for m in offered.iter().filter(|d| is_signed_manifest(d)) {
            let members: Vec<Delta> = manifest_member_ids(m)
                .iter()
                .filter(|id| offered_ids.contains(id.as_str()))
                .filter_map(|id| offered.iter().find(|d| &d.id == id))
                .filter(|d| !is_signed_manifest(d))
                .cloned()
                .collect();
            for mem in &members {
                covered.insert(mem.id.clone());
            }
            covered.insert(m.id.clone());
            bundles.push((m.clone(), members));
        }
        let loose: Vec<Delta> = offered
            .iter()
            .filter(|d| {
                !covered.contains(&d.id)
                    && d.sig.is_some()
                    && verify_delta(d) == Verification::Verified
            })
            .cloned()
            .collect();
        let withheld = offered.len() - covered.len() - loose.len();

        let mut report = SyncReport {
            offered: offered.len(),
            bundles: bundles.len(),
            loose: loose.len(),
            withheld,
            ..Default::default()
        };
        let admit = |adm: &Option<Pred>, d: &Delta| match adm {
            None => true,
            Some(p) => eval_pred(p, d, None),
        };

        for (manifest, members) in bundles {
            // Admission applies to the act: if the manifest or any member fails, decline.
            let all_admitted = admit(&self.admission, &manifest)
                && members.iter().all(|m| admit(&self.admission, m));
            if !all_admitted {
                report.rejected += 1 + members.len();
                continue;
            }
            match self.reactor.ingest_bundle(manifest, &members) {
                IngestResult::Accepted => report.accepted += 1,
                IngestResult::Rejected(_) => report.rejected += 1,
                IngestResult::Duplicate => {}
            }
        }
        for d in loose {
            if !admit(&self.admission, &d) {
                report.rejected += 1;
                continue;
            }
            match self.reactor.ingest(d) {
                IngestResult::Accepted => report.accepted += 1,
                IngestResult::Rejected(_) => report.rejected += 1,
                IngestResult::Duplicate => {}
            }
        }
        report
    }
}

/// Anti-entropy both ways; repeat until quiescent (bounded — union is monotone).
pub fn sync_both(a: &mut Peer, b: &mut Peer) {
    for _ in 0..4 {
        let before = format!("{}{}", a.reactor.digest(), b.reactor.digest());
        a.pull_from(b);
        b.pull_from(a);
        if format!("{}{}", a.reactor.digest(), b.reactor.digest()) == before {
            return;
        }
    }
}
