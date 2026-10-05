use rhizomatic::hview::{HVEntry, HView};
use rhizomatic::hview_envelope::HViewEnvelopeLimits;
use rhizomatic::json_profile::{claims_to_json, parse_delta};
use rhizomatic::term_io::schema_to_json;
use rhizomatic::term_json::parse_schema;
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub fn fixture_view(v: &Value) -> Result<HView, String> {
    let mut props = BTreeMap::new();
    for (k, es) in v["props"].as_object().ok_or("fixture props")? {
        let mut entries = Vec::new();
        for e in es.as_array().ok_or("fixture entries")? {
            let expanded = e["expanded"]
                .as_array()
                .ok_or("fixture expansion")?
                .iter()
                .map(|p| Ok((p[0].as_u64().ok_or("slot")? as usize, fixture_view(&p[1])?)))
                .collect::<Result<_, String>>()?;
            let readings = e["readings"]
                .as_array()
                .ok_or("fixture readings")?
                .iter()
                .map(|p| Ok((p[0].as_u64().ok_or("slot")? as usize, parse_schema(&p[1])?)))
                .collect::<Result<_, String>>()?;
            entries.push(HVEntry {
                delta: parse_delta(&e["delta"])?,
                negated: e["negated"].as_bool().ok_or("bool")?,
                expanded,
                readings,
            });
        }
        props.insert(k.clone(), entries);
    }
    Ok(HView {
        id: v["id"].as_str().ok_or("id")?.into(),
        props,
    })
}
pub fn inspect_view(v: &HView) -> Value {
    let props=v.props.iter().map(|(k,es)|(k.clone(),Value::Array(es.iter().map(|e|{
  let mut delta=json!({"id":e.delta.id,"claims":claims_to_json(&e.delta.claims)});
  if let Some(sig)=&e.delta.sig {delta["sig"]=json!(sig);}
  json!({"delta":delta,"negated":e.negated,"expanded":e.expanded.iter().map(|(i,c)|json!([i,inspect_view(c)])).collect::<Vec<_>>(),"readings":e.readings.iter().map(|(i,r)|json!([i,schema_to_json(r)])).collect::<Vec<_>>()})
 }).collect()))).collect::<serde_json::Map<_,_>>();
    json!({"id":v.id,"props":props})
}
pub fn limits(v: &Value) -> HViewEnvelopeLimits {
    let mut l = HViewEnvelopeLimits::default();
    for (k, dst) in [
        ("artifactBytes", &mut l.artifact_bytes),
        ("syntaxDepth", &mut l.syntax_depth),
        ("syntaxNodes", &mut l.syntax_nodes),
        ("appearances", &mut l.appearances),
        ("entries", &mut l.entries),
        ("nodes", &mut l.nodes),
        ("depth", &mut l.depth),
        ("pointers", &mut l.pointers),
        ("buckets", &mut l.buckets),
        ("readings", &mut l.readings),
    ] {
        if let Some(n) = v[k].as_u64() {
            *dst = n as usize;
        }
    }
    l
}
