//! The delta data model (SPEC-1 §2). Mirrors ../ts/src/types.ts.

#[derive(Debug, Clone, PartialEq)]
pub enum Primitive {
    Str(String),
    Num(f64),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityRef {
    pub id: String,
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeltaRef {
    /// content address (multihash hex) of another delta
    pub delta: String,
    pub context: Option<String>,
}

/// A pointer's target is exactly one of these, kept structurally distinct (ERRATA D5).
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Primitive(Primitive),
    Entity(EntityRef),
    Delta(DeltaRef),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pointer {
    pub role: String,
    pub target: Target,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Claims {
    /// ms since Unix epoch; a CLAIM, not an authority (SPEC-1 §6)
    pub timestamp: f64,
    /// public key or fingerprint (SPEC-1 §5)
    pub author: String,
    /// 1 or more (SPEC-1 §2.1)
    pub pointers: Vec<Pointer>,
}
