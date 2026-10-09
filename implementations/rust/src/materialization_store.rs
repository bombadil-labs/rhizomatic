//! SPEC-16 MR-15: the atomic complete-image control store seam. Initialize, read and
//! compare-and-set over opaque canonical bytes. No semantic installation, source authority or
//! second journal lives here; adapters report exactly the four CAS outcomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationControlInitialize {
    Initialized { bytes: Vec<u8> },
    Existing { bytes: Vec<u8>, revision: String },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationControlRead {
    Image { bytes: Vec<u8>, revision: String },
    Unavailable { fault: String },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationControlWrite {
    Durable { revision: String },
    Conflict,
    Rejected { reason: String },
    CommittedUnconfirmed { fault: String },
}
/// One complete metadata image per (receiver, configuration). `revision` is the external name
/// the host assigns to stored bytes; the empty generation-0 image is named by the empty text.
/// An adapter MUST store the whole image atomically or report `CommittedUnconfirmed`.
pub trait MaterializationControlStore {
    /// Returns the existing exact image, or durably stores `empty_bytes` when nothing exists.
    fn initialize(
        &mut self,
        receiver: &str,
        configuration: &str,
        empty_bytes: &[u8],
    ) -> Result<MaterializationControlInitialize, String>;
    /// One consistent complete image with its revision, or unavailable.
    fn read(
        &mut self,
        receiver: &str,
        configuration: &str,
    ) -> Result<MaterializationControlRead, String>;
    /// Atomically replaces the image iff the stored revision equals `expected_revision`.
    fn compare_and_set(
        &mut self,
        receiver: &str,
        configuration: &str,
        expected_revision: &str,
        bytes: &[u8],
        revision: &str,
    ) -> Result<MaterializationControlWrite, String>;
}
