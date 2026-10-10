//! SPEC-16 MR-22: the thin federation facade over the reactor's normalized control codecs and
//! planner and the storage CAS seam. Command reaches both through this existing edge; no second
//! state machine is introduced here.
pub use crate::materialization_control::{
    decode_materialization_control, empty_materialization_control, encode_materialization_control,
    materialization_appearance_key, materialization_control_image,
    materialization_control_revision, plan_materialization_control, MaterializationControlActive,
    MaterializationControlEntry, MaterializationControlError, MaterializationControlImage,
    MaterializationControlLimits, MaterializationControlPlan, MaterializationControlRefusal,
    MaterializationControlSelected, MaterializationControlSelection, MaterializationControlStatus,
    MaterializationControlTransition, MATERIALIZATION_CONTROL_EMPTY_REVISION,
    MATERIALIZATION_CONTROL_FORMAT,
};
pub use crate::materialization_store::{
    MaterializationControlInitialize, MaterializationControlRead, MaterializationControlStore,
    MaterializationControlWrite,
};
