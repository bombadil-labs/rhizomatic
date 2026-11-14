//! What a holder of views answers (SPEC-18 proposal §4.6, "Held views"; §4.13 readings 75 to
//! 90). The holder itself, `crate::store_views::StoreViews`, reads through the store-backed read;
//! these answer types sit with the store so that the conformance runner can judge any holder.

use crate::store_follow::Position;
use crate::store_fresh::Capture;

/// One view: a program held at a root. Ordered by program name, then root, each by UTF-8 bytes
/// (a Rust `String` orders by its bytes), as `reread` and `changed` are (§4.13 reading 85).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ViewKey {
    pub name: String,
    pub root: String,
}

impl ViewKey {
    pub fn new(name: &str, root: &str) -> Self {
        Self {
            name: name.to_string(),
            root: root.to_string(),
        }
    }
}

/// Where the bytes of a `hold` answer came from (SPEC-18 §4.6; §4.13 reading 91).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewFrom {
    /// The view was held and the pass kept its bytes.
    Held,
    /// The view was held and the pass read it again.
    Read,
    /// The view was not held when the call began: its first hold, or a hold after a `drop` or an
    /// eviction. The answer is its baseline, and a host copies it (the host rule).
    New,
}

impl ViewFrom {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Read => "read",
            Self::New => "new",
        }
    }
}

/// The answer of a `hold`.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewRead {
    pub name: String,
    pub root: String,
    /// The canonical encoding of the read's result, HView or View, as lowercase hex.
    pub bytes: String,
    /// The pass's position: where every held view stands.
    pub position: Position,
    pub expires_at: Option<f64>,
    pub from: ViewFrom,
    /// The view's capture at `position` (§4.13 reading 77). `check_fresh` answers `current` for
    /// it while nothing touches the view.
    pub capture: Capture,
}

/// A view whose bytes differ from its baseline, or whose baseline was released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewChange {
    pub name: String,
    pub root: String,
    /// The baseline's bytes, or `None` when the holder released it (a purge read by a pass, or a
    /// resync): the holder keeps no byte of a released baseline (§4.13 readings 88 and 90).
    pub before: Option<String>,
    pub after: String,
}

/// The answer of a `refresh`.
#[derive(Debug, Clone, PartialEq)]
pub struct Refresh {
    pub position: Position,
    /// Ordered as `reread`.
    pub changed: Vec<ViewChange>,
    /// The views this pass read again, ascending by program name, then root.
    pub reread: Vec<ViewKey>,
    /// Every view an eviction forgot since the previous refresh that succeeded, and that no
    /// `hold` and no `drop` named after its last eviction, ascending (§4.13 reading 92). A host
    /// that follows the host rule stops maintaining these views.
    pub evicted: Vec<ViewKey>,
    /// The pass could not take the views from the processed position: every held view was read
    /// again and every baseline released.
    pub resynced: bool,
}
