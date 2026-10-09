//! Full original program closure and compact attributed source commitments.
use crate::cbor::CborValue;
use crate::evidence_codec::ReadingAppearanceLimits;
use crate::materialization_data::{
    materialization_bytes, materialization_number, materialization_ref, materialization_text,
    MaterializationFields, MaterializationLimits,
};
use crate::materialization_source::{
    decode_materialization_appearance, encode_materialization_appearance,
    materialization_component_commitments, MaterializationSourceSnapshot,
};
use crate::materialization_values::{
    bytes, field, id, limit, list, map, number, object, ordered, peer, require, s, same,
    source_limits, text, Result,
};
use crate::pred::Bindings;
use crate::schema::{
    select_materialization_program, ProgramSelection, ProgramSelectionError, SelectedProgram,
};
use crate::schema_deltas::{read_materialization_definitions, ExactDefinition};
use crate::set::DeltaSet;
use crate::types::Delta;
use std::collections::BTreeMap;
pub(crate) const BASIS_FIELDS: &[&str] = &[
    "binding",
    "revision",
    "authority",
    "selection",
    "membership",
    "appearanceDigest",
    "components",
    "at",
    "servingAt",
    "bindings",
    "definitionAt",
    "interpretation",
    "hyperschema",
    "hyperschemaPin",
    "schema",
    "schemaPin",
    "definitions",
    "definitionDigest",
];
#[derive(Debug, Clone)]
pub(crate) struct BasisProgram {
    pub deltas: Vec<Delta>,
    pub bindings: Bindings,
    pub selected: SelectedProgram,
}
pub(crate) fn program_error(e: ProgramSelectionError) -> String {
    match e {
        ProgramSelectionError::PinMismatch => "pin-mismatch",
        ProgramSelectionError::AmbiguousDefinition => "ambiguous-definition",
        ProgramSelectionError::DefinitionClosure => "definition-closure",
        ProgramSelectionError::DefinitionCycle => "definition-cycle",
        ProgramSelectionError::InvalidProgram => "invalid-program",
    }
    .into()
}
pub(crate) struct DefinitionProgramInput {
    pub at: f64,
    pub hyper: String,
    pub reading: String,
    pub hyper_pin: String,
    pub reading_pin: String,
    pub bindings: Bindings,
    pub embedded: bool,
}
pub(crate) fn definitions_program(
    deltas: Vec<Delta>,
    input: DefinitionProgramInput,
    limits: &MaterializationLimits,
) -> Result<BasisProgram> {
    let DefinitionProgramInput {
        at,
        hyper,
        reading,
        hyper_pin,
        reading_pin,
        bindings,
        embedded,
    } = input;
    let parsed = read_materialization_definitions(
        &deltas,
        at,
        limits["definitions"],
        limits["pointers"],
        ReadingAppearanceLimits {
            artifact_bytes: limits["artifactBytes"],
            syntax_depth: limits["syntaxDepth"],
            syntax_nodes: limits["syntaxNodes"],
        },
    )?;
    if embedded {
        require(
            deltas.iter().any(|d| d.id == hyper) && deltas.iter().any(|d| d.id == reading),
            "definition-closure",
        )?;
    }
    require(
        parsed
            .iter()
            .any(|(id, d)| id == &hyper && matches!(d, ExactDefinition::Gather(_)))
            && parsed
                .iter()
                .any(|(id, d)| id == &reading && matches!(d, ExactDefinition::Reading(_))),
        "invalid-definition",
    )?;
    let gathers = parsed
        .iter()
        .filter_map(|(id, d)| {
            if let ExactDefinition::Gather(s) = d {
                Some((id.clone(), s.clone()))
            } else {
                None
            }
        })
        .collect();
    let readings = parsed
        .iter()
        .filter_map(|(id, d)| {
            if let ExactDefinition::Reading(s) = d {
                Some((id.clone(), s.clone()))
            } else {
                None
            }
        })
        .collect();
    let selected = select_materialization_program(
        gathers,
        readings,
        ProgramSelection {
            top_gather: &hyper,
            top_reading: &reading,
            gather_pin: &hyper_pin,
            reading_pin: &reading_pin,
            bindings: &bindings,
            allow_principal: false,
        },
    )
    .map_err(program_error)?;
    Ok(BasisProgram {
        deltas,
        bindings,
        selected,
    })
}
/// Stage-4 Basis field grammar: every field except the embedded definition acts (MR-21).
fn basis_grammar(fs: &BTreeMap<&str, &CborValue>) -> Result<Bindings> {
    for k in [
        "binding",
        "revision",
        "authority",
        "selection",
        "membership",
        "appearanceDigest",
        "hyperschema",
        "hyperschemaPin",
        "schema",
        "schemaPin",
        "definitionDigest",
    ] {
        id(field(fs, k)?)?;
    }
    for k in ["at", "servingAt", "definitionAt"] {
        number(field(fs, k)?)?;
    }
    if let Some(cutoff) = fs.get("historicalCutoff") {
        number(cutoff)?;
    }
    require(
        text(field(fs, "interpretation")?)? == "core/1",
        "invalid-evidence",
    )?;
    for c in list(field(fs, "components")?)? {
        let f = object(c, &["peer", "revision", "capturedAt"], &[])?;
        peer(field(&f, "peer")?)?;
        id(field(&f, "revision")?)?;
        number(field(&f, "capturedAt")?)?;
    }
    for d in list(field(fs, "definitions")?)? {
        bytes(d)?;
    }
    crate::command_data::read_bindings(bytes(field(fs, "bindings")?)?)
        .map_err(|_| "invalid-evidence".into())
}
pub(crate) fn basis_program(
    value: &CborValue,
    limits: &MaterializationLimits,
) -> Result<BasisProgram> {
    let fs = object(value, BASIS_FIELDS, &["historicalCutoff"])?;
    let bindings = basis_grammar(&fs)?;
    let defs = list(field(&fs, "definitions")?)?;
    limit(defs.len(), limits["definitions"])?;
    for d in defs {
        limit(bytes(d)?.len(), limits["artifactBytes"])?;
    }
    let deltas = defs
        .iter()
        .map(|v| {
            decode_materialization_appearance(bytes(v)?, source_limits(limits)).map_err(|e| {
                if e.to_string() == "resource-limit" {
                    "resource-limit".into()
                } else {
                    "invalid-definition".into()
                }
            })
        })
        .collect::<Result<Vec<_>>>()?;
    ordered(&deltas.iter().map(|d| d.id.clone()).collect::<Vec<_>>())?;
    definitions_program(
        deltas,
        DefinitionProgramInput {
            at: number(field(&fs, "definitionAt")?)?,
            hyper: id(field(&fs, "hyperschema")?)?,
            reading: id(field(&fs, "schema")?)?,
            hyper_pin: id(field(&fs, "hyperschemaPin")?)?,
            reading_pin: id(field(&fs, "schemaPin")?)?,
            bindings,
            embedded: true,
        },
        limits,
    )
}
pub(crate) fn validate_basis(
    value: &CborValue,
    limits: &MaterializationLimits,
    snapshot: Option<&MaterializationSourceSnapshot>,
) -> Result<()> {
    let fs = object(value, BASIS_FIELDS, &["historicalCutoff"])?;
    basis_grammar(&fs)?;
    if let Some(cutoff) = fs.get("historicalCutoff") {
        require(
            number(cutoff)? == number(field(&fs, "at")?)?,
            "invalid-evidence",
        )?;
    }
    let components = list(field(&fs, "components")?)?;
    limit(components.len(), limits["components"])?;
    require(!components.is_empty(), "invalid-evidence")?;
    let peers = components
        .iter()
        .map(|c| {
            peer(field(
                &object(c, &["peer", "revision", "capturedAt"], &[])?,
                "peer",
            )?)
        })
        .collect::<Result<Vec<_>>>()?;
    ordered(&peers)?;
    let program = basis_program(value, limits)?;
    require(
        DeltaSet::from_deltas(program.deltas)
            .map_err(|_| "invalid-evidence")?
            .digest()
            == id(field(&fs, "definitionDigest")?)?,
        "invalid-evidence",
    )?;
    if let Some(snap) = snapshot {
        for (k, v) in [
            ("binding", &snap.binding),
            ("revision", &snap.revision),
            ("authority", &snap.authority),
            ("selection", &snap.selection),
            ("membership", &snap.membership),
            ("appearanceDigest", &snap.appearance_digest),
        ] {
            require(id(field(&fs, k)?)? == *v, "invalid-evidence")?;
        }
        require(
            same(
                field(&fs, "components")?,
                &materialization_component_commitments(snap).map_err(|_| "invalid-evidence")?,
            ),
            "invalid-evidence",
        )?;
        require(
            fs.get("historicalCutoff").map(|v| number(v)).transpose()? == snap.historical_cutoff,
            "invalid-evidence",
        )?;
    }
    Ok(())
}
pub(crate) fn gather_basis(
    f: &MaterializationFields,
    snap: &MaterializationSourceSnapshot,
    definitions: &[Delta],
    limits: &MaterializationLimits,
) -> Result<CborValue> {
    let mut defs = definitions.to_vec();
    defs.sort_by(|a, b| a.id.cmp(&b.id));
    let mut values = vec![
        ("binding", s(&snap.binding)),
        ("revision", s(&snap.revision)),
        ("authority", s(&snap.authority)),
        ("selection", s(&snap.selection)),
        ("membership", s(&snap.membership)),
        ("appearanceDigest", s(&snap.appearance_digest)),
        (
            "components",
            materialization_component_commitments(snap).map_err(|e| e.to_string())?,
        ),
        ("at", CborValue::Float(materialization_number(f, "at")?)),
        (
            "servingAt",
            CborValue::Float(materialization_number(f, "serving-at")?),
        ),
        (
            "bindings",
            CborValue::Bstr(materialization_bytes(f, "bindings")?),
        ),
        (
            "definitionAt",
            CborValue::Float(materialization_number(f, "definition-at")?),
        ),
        ("interpretation", s("core/1")),
        ("hyperschema", s(&materialization_ref(f, "hyperschema")?)),
        (
            "hyperschemaPin",
            s(&materialization_text(f, "hyperschema-pin")?),
        ),
        ("schema", s(&materialization_ref(f, "schema")?)),
        ("schemaPin", s(&materialization_text(f, "schema-pin")?)),
        (
            "definitions",
            CborValue::Array(
                defs.iter()
                    .map(|d| {
                        encode_materialization_appearance(d, source_limits(limits))
                            .map(CborValue::Bstr)
                            .map_err(|e| e.to_string())
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
        ),
        (
            "definitionDigest",
            s(&DeltaSet::from_deltas(defs)
                .map_err(|_| "invalid-evidence")?
                .digest()),
        ),
    ];
    if f.contains_key("historical-cutoff") {
        values.push((
            "historicalCutoff",
            CborValue::Float(materialization_number(f, "historical-cutoff")?),
        ));
    }
    Ok(map(values))
}
