//! The refusal inside a `StoreFailure` (SPEC-18 §4.13 reading 136). A test that expects a
//! refusal fails when the store met an integrity fault instead.

use rhizomatic::store::{StoreError, StoreFailure};

pub fn as_refusal(failure: StoreFailure) -> StoreError {
    match failure {
        StoreFailure::Refused(error) => error,
        StoreFailure::Integrity(fault) => panic!(
            "expected a refusal, the store met the integrity fault {}: {}",
            fault.kind.as_str(),
            fault.detail
        ),
    }
}
