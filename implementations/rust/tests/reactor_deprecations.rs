//! The whole-set `Reactor` methods are deprecated (SPEC-18 slice 2 plan §2(b), O1), and nothing
//! in `src/` calls them.
//!
//! The rail is the compiler: `src/lib.rs` carries `#![forbid(deprecated)]`, so any use of a
//! deprecated item in the crate fails the build, and no inner `#[allow]` can lift it. That covers
//! every way a call can be written: a method call, a UFCS call (`Reactor::snapshot(&r)`), a
//! function pointer (`let f = Reactor::snapshot;`), a call inside a closure or a macro argument.
//! `Reactor` implements no trait that exposes these methods (only `DeltaSource`). This file holds
//! the two facts the compiler rail stands on: the crate attribute is there, and each of the four
//! methods carries `#[deprecated]` naming its replacement. The legacy memory `Peer` reads through
//! `pub(crate)` accessors, which nothing outside the crate can reach.

use std::fs;

fn source(file: &str) -> String {
    let path = format!("{}/src/{file}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn the_crate_forbids_every_use_of_a_deprecated_item() {
    let lib = source("lib.rs");
    assert!(
        lib.lines().any(|l| l.trim() == "#![forbid(deprecated)]"),
        "src/lib.rs must carry #![forbid(deprecated)]"
    );
    for entry in fs::read_dir(format!("{}/src", env!("CARGO_MANIFEST_DIR"))).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        for lift in ["allow(deprecated", "warn(deprecated", "expect(deprecated"] {
            assert!(!text.contains(lift), "{}: {lift}", path.display());
        }
    }
}

#[test]
fn each_whole_set_method_is_deprecated_and_names_its_replacement() {
    let reactor = source("reactor.rs");
    for (method, replacement) in [
        ("snapshot", "read_anchored"),
        ("arrival_log", "Snapshot::arrivals"),
        ("digest", "collect_delta_set"),
        ("eval", "read_full_surface"),
    ] {
        let signature = format!("    pub fn {method}(");
        let at = reactor
            .find(&signature)
            .unwrap_or_else(|| panic!("Reactor::{method} is gone"));
        let attribute = reactor[..at]
            .rfind("#[deprecated(")
            .unwrap_or_else(|| panic!("Reactor::{method} is not deprecated"));
        let between = &reactor[attribute..at];
        assert!(
            !between.contains("fn "),
            "Reactor::{method}: the nearest #[deprecated] belongs to another item"
        );
        assert!(
            between.contains(replacement),
            "Reactor::{method}: the note names {replacement}"
        );
    }
}

/// The deprecated methods still answer for a consumer that has not moved. This test calls them on
/// purpose, so it allows the lint for itself alone.
#[test]
#[allow(deprecated)]
fn the_deprecated_methods_still_answer() {
    use rhizomatic::eval::{EvalResult, Term};
    use rhizomatic::reactor::{IngestResult, Reactor};
    use rhizomatic::set::make_delta;
    use rhizomatic::types::{Claims, EntityRef, Pointer, Target};
    let mut reactor = Reactor::new();
    let delta = make_delta(
        Claims {
            timestamp: 1.0,
            valid_from: 1.0,
            valid_until: None,
            author: "did:key:zA".into(),
            pointers: vec![Pointer {
                role: "subject".into(),
                target: Target::Entity(EntityRef {
                    id: "e".into(),
                    context: Some("name".into()),
                }),
            }],
        },
        None,
    )
    .unwrap();
    assert_eq!(reactor.ingest(delta.clone()), IngestResult::Accepted);
    assert_eq!(reactor.snapshot().ids(), vec![delta.id.as_str()]);
    assert_eq!(reactor.arrival_log(), std::slice::from_ref(&delta));
    assert_eq!(reactor.digest(), reactor.snapshot().digest());
    let EvalResult::DSet { set, .. } = reactor.eval(&Term::Input, None, None).unwrap() else {
        panic!("input is a DSet");
    };
    assert_eq!(set.digest(), reactor.digest());
}
