//! Opening a store by URL scheme (SPEC-18 proposal §4.10). A connection string can carry
//! credentials, so nothing here logs or echoes the URL. An error names a scheme only when that
//! scheme is registered; a missing or unregistered scheme gets one fixed message.
//! The registry is a value the host owns. There is no process-wide scheme table.

use std::collections::BTreeMap;
use std::error::Error;

use crate::memory_store::MemoryStore;
use crate::store::{missing_requirements, Store, StoreError, StoreErrorCode, StoreRequirement};

/// The scheme of the memory reference store. It is built in and cannot be replaced.
pub const MEMORY_SCHEME: &str = "memory";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OpenOptions {
    /// Capabilities the host needs. Open refuses `capability-absent` and names each missing one.
    pub requires: Vec<StoreRequirement>,
}

/// Opens one store from a URL of its scheme. A [`StoreError`] it returns is passed on; any other
/// error is replaced by `open-failed` with the scheme name, because a driver's message may
/// quote the URL.
pub type StoreFactory = Box<dyn Fn(&str, &OpenOptions) -> Result<Box<dyn Store>, Box<dyn Error>>>;

/// The URL schemes a host can open.
#[derive(Default)]
pub struct StoreSchemes {
    registered: BTreeMap<String, StoreFactory>,
}

/// The one message for a URL with no scheme or an unregistered one. It echoes nothing: the text
/// before the first colon of a malformed connection string can be a credential.
pub const UNKNOWN_SCHEME_MESSAGE: &str =
    "the store URL has no scheme, or no store is registered for its scheme";

/// The lowercase scheme of a URL, or `None` when the text has no well-formed scheme.
fn scheme_of(url: &str) -> Option<(String, &str)> {
    let (scheme, rest) = url.split_once(':')?;
    valid_scheme(scheme).then(|| (scheme.to_ascii_lowercase(), rest))
}

fn valid_scheme(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

impl StoreSchemes {
    /// A registry that opens the built-in schemes only.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a consumer's own store. Refuses `scheme-exists` for a taken or built-in scheme and
    /// `invalid-url` for text that cannot be a scheme.
    pub fn register(&mut self, scheme: &str, factory: StoreFactory) -> Result<(), StoreError> {
        if !valid_scheme(scheme) {
            return Err(StoreError::new(
                StoreErrorCode::InvalidUrl,
                "a scheme is a letter followed by letters, digits, '+', '-' or '.'",
            ));
        }
        let scheme = scheme.to_ascii_lowercase();
        if scheme == MEMORY_SCHEME || self.registered.contains_key(&scheme) {
            return Err(StoreError::new(
                StoreErrorCode::SchemeExists,
                format!("the scheme {scheme} is taken"),
            ));
        }
        self.registered.insert(scheme, factory);
        Ok(())
    }

    /// Removes a registered scheme. A built-in scheme stays. Answers whether one was removed.
    pub fn unregister(&mut self, scheme: &str) -> bool {
        self.registered
            .remove(&scheme.to_ascii_lowercase())
            .is_some()
    }

    /// Opens the store the URL's scheme names, then checks the host's requirements against its
    /// profile. A store that misses one is closed before the refusal.
    pub fn open(&self, url: &str, options: &OpenOptions) -> Result<Box<dyn Store>, StoreError> {
        let unknown = || StoreError::new(StoreErrorCode::UnknownScheme, UNKNOWN_SCHEME_MESSAGE);
        let Some((scheme, address)) = scheme_of(url) else {
            return Err(unknown());
        };
        let store: Box<dyn Store> = if scheme == MEMORY_SCHEME {
            if !address.is_empty() {
                return Err(StoreError::new(
                    StoreErrorCode::InvalidUrl,
                    "memory: takes no address; each open is a new empty store",
                ));
            }
            Box::new(MemoryStore::new())
        } else {
            let Some(factory) = self.registered.get(&scheme) else {
                return Err(unknown());
            };
            factory(url, options).map_err(|failure| match failure.downcast::<StoreError>() {
                Ok(refusal) => *refusal,
                Err(_) => StoreError::new(
                    StoreErrorCode::OpenFailed,
                    format!("the {scheme} store failed to open"),
                ),
            })?
        };
        let missing = missing_requirements(store.profile(), &options.requires);
        if !missing.is_empty() {
            store.close();
            let names: Vec<&str> = missing.iter().map(|r| r.as_str()).collect();
            return Err(StoreError::new(
                StoreErrorCode::CapabilityAbsent,
                format!("the {scheme} store lacks: {}", names.join(", ")),
            ));
        }
        Ok(store)
    }
}

/// Opens a store of a built-in scheme (`memory:`). A host with its own stores keeps a
/// [`StoreSchemes`] and opens through it.
pub fn open_store(url: &str, options: &OpenOptions) -> Result<Box<dyn Store>, StoreError> {
    StoreSchemes::new().open(url, options)
}
