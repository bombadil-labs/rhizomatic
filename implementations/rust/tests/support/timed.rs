//! The timed cost rails share one process with the whole suite. Each holds `exclusive()` while it
//! measures, so no two timed rails measure at the same time. A rail measures again when its ratio
//! reaches the bound, and fails only when all `ATTEMPTS` measurements reach it: a quadratic
//! build reaches it every time, and a stall on a busy host rarely does three times in a row.
use std::sync::{Mutex, MutexGuard, PoisonError};

pub const ATTEMPTS: usize = 3;

static TIMED: Mutex<()> = Mutex::new(());

/// The process-wide timing lock. A rail that failed while holding it does not poison the others.
pub fn exclusive() -> MutexGuard<'static, ()> {
    TIMED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `measure` up to `ATTEMPTS` times. It answers `None` at the first measurement under the
/// bound, or the last failure when every measurement reached it.
pub fn remeasured<T>(mut measure: impl FnMut() -> Option<T>) -> Option<T> {
    let mut slow = None;
    for _ in 0..ATTEMPTS {
        slow = Some(measure()?);
    }
    slow
}
