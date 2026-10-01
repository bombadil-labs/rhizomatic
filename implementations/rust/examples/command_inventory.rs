//! Language-aware public symbol and dependency inventory for host and WASM source.
//! This examines every source AST, including cfg-gated nodes. Macro bodies are explicitly
//! recorded as opaque regions; they are not advertised as fully resolved dependency evidence.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{env, fs, path::Path};
use syn::visit::{self, Visit};
use syn::{Item, UseTree, Visibility};

fn uses(tree: &UseTree, prefix: String, out: &mut Vec<(String, String)>) {
    match tree {
        UseTree::Path(p) => uses(&p.tree, format!("{prefix}{}::", p.ident), out),
        UseTree::Name(n) => out.push((n.ident.to_string(), format!("{prefix}{}", n.ident))),
        UseTree::Rename(n) => out.push((n.rename.to_string(), format!("{prefix}{}", n.ident))),
        UseTree::Glob(_) => out.push(("*".into(), format!("{prefix}*"))),
        UseTree::Group(g) => {
            for t in &g.items {
                uses(t, prefix.clone(), out)
            }
        }
    }
}
fn owner(module: &str, symbol: &str) -> &'static str {
    match module {
        "command_data" => "command-data",
        "command" => "command",
        "types" | "cbor" | "delta" | "hash" | "sign" | "json_profile" | "b64u" | "set" => "delta",
        "pred" | "term_io" | "term_json" | "parse_error" | "strict" => "syntax",
        "schema" => "schema",
        "schema_deltas" | "lens_binding" => "schema-load",
        "eval" => {
            if matches!(
                symbol,
                "Term" | "SchemaRef" | "MaskPolicy" | "PruneKeep" | "GroupKey"
            ) {
                "syntax"
            } else {
                "algebra"
            }
        }
        "resolution" => {
            if matches!(symbol, "resolve_view" | "candidate_value" | "render_target") {
                "resolve"
            } else {
                "resolve-kernel"
            }
        }
        "hview" => "algebra",
        "alias" => "delta",
        "reactor" | "materialize" => "reactor",
        "principal" => "principal",
        "pack" => "storage",
        "derivation" => "derivation",
        "arrival"
        | "durable_state"
        | "entry"
        | "erasure_filter"
        | "ordinary_journal"
        | "ordinary_journal_peer"
        | "ordinary_quota"
        | "peer"
        | "peer_identity"
        | "peer_state"
        | "permanent_journal"
        | "preflight"
        | "signed_loose_admission"
        | "single_peer"
        | "http" => "federation",
        "lib" => "delta",
        "wasm" => "federation",
        _ => "unclassified",
    }
}
fn public(v: &Visibility) -> bool {
    matches!(v, Visibility::Public(_))
}
fn cfg(attrs: &[syn::Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("cfg"))
        .map(|a| format!("{:?}", a.meta))
        .collect()
}
struct Paths {
    aliases: BTreeMap<String, String>,
    paths: BTreeSet<String>,
    macros: BTreeSet<String>,
}
impl<'ast> Visit<'ast> for Paths {
    fn visit_path(&mut self, p: &'ast syn::Path) {
        let parts: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
        if let Some(first) = parts.first() {
            let path = if let Some(a) = self.aliases.get(first) {
                format!(
                    "{}{}",
                    a,
                    if parts.len() > 1 {
                        format!("::{}", parts[1..].join("::"))
                    } else {
                        String::new()
                    }
                )
            } else {
                parts.join("::")
            };
            if parts.len() > 1 || self.aliases.contains_key(first) {
                self.paths.insert(path);
            }
        }
        visit::visit_path(self, p);
    }
    fn visit_macro(&mut self, m: &'ast syn::Macro) {
        self.macros.insert(
            m.path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>()
                .join("::"),
        );
        visit::visit_macro(self, m);
    }
}
fn record(
    exports: &mut Vec<Value>,
    module: &str,
    symbol: &str,
    source: &str,
    kind: &str,
    attrs: &[syn::Attribute],
) {
    let o = owner(module, symbol);
    let portable = matches!(module, "command_data" | "command") || symbol == "decode_view";
    exports.push(json!({"id":format!("rust:{module}:{symbol}"),"owner":o,"symbol":symbol,"source":source,"definition":kind,"contract":format!("rhizomatic.{o}/native-api/1"),"classification":if portable{"portable_contract"}else{"native_extension"},"semantics":format!("{o} owns the existing {module}::{symbol} {kind}; native callers supply the declared inputs and policy parameters. No command-profile capability is inferred from this export."),"cfg":cfg(attrs)}));
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::args().nth(1).unwrap_or_else(|| "../..".into());
    let dir = Path::new(&root).join("implementations/rust/src");
    let mut files = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    let mut exports = Vec::new();
    let mut dependencies = Vec::new();
    for file in files {
        if file.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let module = file.file_stem().unwrap().to_str().unwrap();
        let source = format!("implementations/rust/src/{module}.rs");
        let ast = syn::parse_file(&fs::read_to_string(&file)?)?;
        let mut aliases = BTreeMap::new();
        for item in &ast.items {
            if let Item::Use(u) = item {
                let mut paths = Vec::new();
                uses(&u.tree, String::new(), &mut paths);
                for (a, p) in paths {
                    if a == "*" {
                        return Err(format!("unsupported glob import in {source}").into());
                    }
                    aliases.insert(a, p);
                }
            }
        }
        for item in &ast.items {
            match item {
                Item::Fn(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.sig.ident.to_string(),
                    &source,
                    "function",
                    &x.attrs,
                ),
                Item::Struct(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "struct",
                    &x.attrs,
                ),
                Item::Enum(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "enum",
                    &x.attrs,
                ),
                Item::Trait(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "trait",
                    &x.attrs,
                ),
                Item::Const(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "constant",
                    &x.attrs,
                ),
                Item::Type(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "type",
                    &x.attrs,
                ),
                Item::Use(x) if public(&x.vis) => {
                    let mut paths = Vec::new();
                    uses(&x.tree, String::new(), &mut paths);
                    for (a, p) in paths {
                        record(&mut exports, module, &a, &source, "reexport", &x.attrs);
                        if let Some(e) = exports.last_mut() {
                            let parts: Vec<_> = p.split("::").filter(|v| *v != "crate").collect();
                            let target_owner = owner(
                                parts.first().copied().unwrap_or(""),
                                parts.get(1).copied().unwrap_or(""),
                            );
                            e["owner"] = json!(target_owner);
                            e["contract"] =
                                json!(format!("rhizomatic.{target_owner}/native-api/1"));
                            e["target"] = json!(p);
                            e["classification"] = json!("compatibility");
                        }
                    }
                }
                Item::Impl(x) => {
                    let name = match x.self_ty.as_ref() {
                        syn::Type::Path(p) => p
                            .path
                            .segments
                            .last()
                            .map(|s| s.ident.to_string())
                            .unwrap_or_default(),
                        _ => return Err(format!("unsupported impl type in {source}").into()),
                    };
                    for i in &x.items {
                        if let syn::ImplItem::Fn(f) = i {
                            if public(&f.vis) {
                                record(
                                    &mut exports,
                                    module,
                                    &format!("{name}::{}", f.sig.ident),
                                    &source,
                                    "method",
                                    &f.attrs,
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
            let mut visitor = Paths {
                aliases: aliases.clone(),
                paths: BTreeSet::new(),
                macros: BTreeSet::new(),
            };
            visitor.visit_item(item);
            let symbol = match item {
                Item::Fn(x) => x.sig.ident.to_string(),
                Item::Struct(x) => x.ident.to_string(),
                Item::Enum(x) => x.ident.to_string(),
                Item::Impl(x) => match x.self_ty.as_ref() {
                    syn::Type::Path(p) => p.path.segments.last().unwrap().ident.to_string(),
                    _ => String::new(),
                },
                _ => String::new(),
            };
            for path in visitor.paths {
                if path.starts_with("crate::") {
                    let mut parts = path.split("::");
                    parts.next();
                    let m = parts.next().unwrap_or("");
                    let s = parts.next().unwrap_or("");
                    dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,&symbol),"target":path,"targetOwner":owner(m,s),"form":"syn-resolved-path"}));
                }
            }
            if !visitor.macros.is_empty() {
                dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,&symbol),"form":"macro-region","macros":visitor.macros,"status":"explicitly-unexamined-token-bodies"}));
            }
        }
    }
    exports.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"format":"rhizomatic-semantic-api-inventory/1","witness":"rust","analysis":"syn-2 AST; all source cfg regions; crate paths and imported aliases; macro token bodies explicitly enumerated, not claimed as resolved","exports":exports,"dependencies":dependencies})
        )?
    );
    Ok(())
}
