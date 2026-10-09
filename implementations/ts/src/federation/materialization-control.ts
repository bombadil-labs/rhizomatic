// SPEC-16 MR-22: the thin federation facade over the reactor's normalized control codecs and
// planner and the storage CAS seam. Command reaches both through this existing edge; no second
// state machine is introduced here.
export {
  MATERIALIZATION_CONTROL_FORMAT,
  MATERIALIZATION_CONTROL_EMPTY_REVISION,
  MaterializationControlError,
  materializationAppearanceKey,
  emptyMaterializationControl,
  materializationControlImage,
  encodeMaterializationControl,
  decodeMaterializationControl,
  materializationControlRevision,
  planMaterializationControl,
  type MaterializationControlLimits,
  type MaterializationControlStatus,
  type MaterializationControlEntry,
  type MaterializationControlImage,
  type MaterializationControlSelection,
  type MaterializationControlActive,
  type MaterializationControlTransition,
  type MaterializationControlPlan,
} from "../reactor/materialization-control.js";
export type {
  MaterializationControlStore,
  MaterializationControlInitialize,
  MaterializationControlRead,
  MaterializationControlWrite,
} from "../storage/materialization-store.js";
