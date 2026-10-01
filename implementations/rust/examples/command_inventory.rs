//! Language-aware public symbol and dependency inventory for host and WASM source.
//! This examines every source AST, including cfg-gated nodes and known macro arguments.
//! Unknown macro/import forms fail closed; this is not compiler trait-resolution evidence.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{env, fs, path::Path};
use syn::parse::{Parse, ParseStream, Parser};
use syn::visit::{self, Visit};
use syn::{Expr, Token};
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
        "pred" | "term_io" | "term_json" => "syntax",
        "parse_error" if symbol.starts_with("diagnose_") => "syntax",
        "parse_error" | "strict" => "delta",
        "schema" => "schema",
        "schema_deltas" if symbol == "VOCAB_PREFIX" => "delta",
        "schema_deltas" | "lens_binding" => "schema-load",
        "eval" => {
            if matches!(
                symbol,
                "Term"
                    | "SchemaRef"
                    | "MaskPolicy"
                    | "PruneKeep"
                    | "GroupKey"
                    | "term_contains_in_view"
            ) {
                "syntax"
            } else {
                "resolve"
            }
        }
        "resolution" => {
            if matches!(symbol, "View" | "MergeFn" | "Order" | "Policy" | "Schema") {
                "syntax"
            } else {
                "resolve-kernel"
            }
        }
        "hview" => "algebra",
        "alias" => "delta",
        "reactor" if matches!(symbol, "manifest_member_ids" | "make_manifest_claims") => "delta",
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
struct JsonMacroExpressions(Vec<Expr>);
impl Parse for JsonMacroExpressions {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        fn value(input: ParseStream<'_>, out: &mut Vec<Expr>) -> syn::Result<()> {
            if input.peek(syn::token::Brace) {
                let inner;
                syn::braced!(inner in input);
                while !inner.is_empty() {
                    out.push(inner.parse::<Expr>()?);
                    inner.parse::<Token![:]>()?;
                    value(&inner, out)?;
                    if inner.is_empty() {
                        break;
                    }
                    inner.parse::<Token![,]>()?;
                }
            } else if input.peek(syn::token::Bracket) {
                let inner;
                syn::bracketed!(inner in input);
                while !inner.is_empty() {
                    value(&inner, out)?;
                    if inner.is_empty() {
                        break;
                    }
                    inner.parse::<Token![,]>()?;
                }
            } else {
                out.push(input.parse::<Expr>()?);
            }
            Ok(())
        }
        let mut out = Vec::new();
        value(input, &mut out)?;
        Ok(Self(out))
    }
}
fn macro_expressions(m: &syn::Macro) -> Result<Vec<Expr>, String> {
    let name = m
        .path
        .segments
        .last()
        .ok_or("empty macro path")?
        .ident
        .to_string();
    let args = m.tokens.to_string();
    match name.as_str() {
        "json" => syn::parse2::<JsonMacroExpressions>(m.tokens.clone())
            .map(|v| v.0)
            .map_err(|e| e.to_string()),
        "vec" => syn::parse_str::<Expr>(&format!("[{args}]"))
            .map(|e| vec![e])
            .map_err(|e| e.to_string()),
        "matches" => {
            // Parse the expression and pattern independently; the guard remains a Rust expression.
            let parser = |input: ParseStream<'_>| -> syn::Result<Vec<Expr>> {
                let expr: Expr = input.parse()?;
                input.parse::<Token![,]>()?;
                let _: syn::Pat = input.call(syn::Pat::parse_multi)?;
                let mut out = vec![expr];
                if input.peek(Token![if]) {
                    input.parse::<Token![if]>()?;
                    out.push(input.parse::<Expr>()?);
                }
                if input.peek(Token![,]) {
                    input.parse::<Token![,]>()?;
                }
                Ok(out)
            };
            parser.parse2(m.tokens.clone()).map_err(|e| e.to_string())
        }
        "format" | "assert" | "assert_eq" | "assert_ne" | "panic" | "unreachable" => {
            syn::punctuated::Punctuated::<Expr, Token![,]>::parse_terminated
                .parse2(m.tokens.clone())
                .map(|v| v.into_iter().collect())
                .map_err(|e| e.to_string())
        }
        _ => Err(format!("unsupported production macro {name}")),
    }
}
struct Paths {
    aliases: BTreeMap<String, String>,
    paths: BTreeSet<String>,
    macros: BTreeSet<String>,
    unsupported: Vec<String>,
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
        match macro_expressions(m) {
            Ok(expressions) => {
                for expr in expressions {
                    self.visit_expr(&expr);
                }
            }
            Err(error) => self.unsupported.push(error),
        }
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
    let root_ast = syn::parse_file(&fs::read_to_string(
        Path::new(&root).join("implementations/rust/src/lib.rs"),
    )?)?;
    let mut aggregate_aliases = BTreeMap::new();
    for item in &root_ast.items {
        if let Item::Use(u) = item {
            if public(&u.vis) {
                let mut names = Vec::new();
                uses(&u.tree, String::new(), &mut names);
                for (name, path) in names {
                    aggregate_aliases.insert(name, path);
                }
            }
        }
    }
    let mut exports = Vec::new();
    let mut dependencies = Vec::new();
    for file in files {
        if file.is_dir() {
            return Err(format!(
                "unsupported nested production module directory {}",
                file.display()
            )
            .into());
        }
        if file.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let module = file.file_stem().unwrap().to_str().unwrap();
        let source = format!("implementations/rust/src/{module}.rs");
        if owner(module, "") == "unclassified" {
            return Err(format!("unclassified production module {source}").into());
        }
        let ast = syn::parse_file(&fs::read_to_string(&file)?)?;
        let mut aliases = BTreeMap::new();
        let mut imports = Vec::new();
        for item in &ast.items {
            let name = match item {
                Item::Fn(i) => Some(i.sig.ident.to_string()),
                Item::Struct(i) => Some(i.ident.to_string()),
                Item::Enum(i) => Some(i.ident.to_string()),
                Item::Trait(i) => Some(i.ident.to_string()),
                Item::Type(i) => Some(i.ident.to_string()),
                Item::Const(i) => Some(i.ident.to_string()),
                _ => None,
            };
            if let Some(name) = name {
                aliases.insert(name.clone(), format!("crate::{module}::{name}"));
            }
        }
        for item in &ast.items {
            if let Item::Use(u) = item {
                let mut paths = Vec::new();
                uses(&u.tree, String::new(), &mut paths);
                for (a, p) in paths {
                    if a == "*" {
                        return Err(format!("unsupported glob import in {source}").into());
                    }
                    imports.push(p.clone());
                    aliases.insert(a, p);
                }
            }
        }
        for path in imports {
            if path.starts_with("crate::") {
                let parts: Vec<_> = path.split("::").skip(1).collect();
                let resolved = parts
                    .first()
                    .and_then(|name| aggregate_aliases.get(*name))
                    .cloned()
                    .unwrap_or_else(|| parts.join("::"));
                let target_parts: Vec<_> = resolved.split("::").collect();
                dependencies.push(json!({"source":source,"symbol":"<import>","owner":owner(module,""),"target":path,"targetOwner":owner(target_parts.first().copied().unwrap_or(""),target_parts.get(1).copied().unwrap_or("")),"form":"syn-import","sourceRegion":if module=="wasm" {"host-adapter"} else if module=="lib" {"compatibility-aggregate"} else {"semantic-owner"}}));
            } else {
                dependencies.push(json!({"source":source,"symbol":"<import>","owner":owner(module,""),"target":path,"form":"syn-external-import","sourceRegion":if module=="wasm" {"host-adapter"} else {"semantic-owner"}}));
            }
        }
        for item in &ast.items {
            match item {
                Item::Mod(x) => {
                    if x.content.is_some() {
                        return Err(
                            format!("unsupported inline production module in {source}").into()
                        );
                    }
                    if public(&x.vis) {
                        record(
                            &mut exports,
                            &x.ident.to_string(),
                            &x.ident.to_string(),
                            &source,
                            "module",
                            &x.attrs,
                        );
                    }
                }
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
                Item::Static(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "static",
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
                unsupported: Vec::new(),
            };
            visitor.visit_item(item);
            if !visitor.unsupported.is_empty() {
                return Err(format!("{source}: {}", visitor.unsupported.join("; ")).into());
            }
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
                    let segments: Vec<_> = path.split("::").skip(1).collect();
                    let resolved = if let Some(target) = segments
                        .first()
                        .and_then(|name| aggregate_aliases.get(*name))
                    {
                        format!(
                            "{}{}",
                            target,
                            if segments.len() > 1 {
                                format!("::{}", segments[1..].join("::"))
                            } else {
                                String::new()
                            }
                        )
                    } else {
                        segments.join("::")
                    };
                    let mut parts = resolved.split("::");
                    let m = parts.next().unwrap_or("");
                    let s = parts.next().unwrap_or("");
                    dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,&symbol),"target":path,"targetOwner":owner(m,s),"form":"syn-resolved-path","sourceRegion":if module=="wasm" {"host-adapter"} else {"semantic-owner"}}));
                }
            }
            if !visitor.macros.is_empty() {
                dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,&symbol),"form":"macro-region","macros":visitor.macros,"status":"parsed-known-macro-arguments"}));
            }
        }
    }
    exports.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"format":"rhizomatic-semantic-api-inventory/1","witness":"rust","analysis":"syn-2 AST; all source cfg regions; crate paths and imported aliases; known macro arguments parsed as Rust/JSON syntax; unknown macro/import forms fail closed; no compiler trait-resolution proof","exports":exports,"dependencies":dependencies})
        )?
    );
    Ok(())
}
