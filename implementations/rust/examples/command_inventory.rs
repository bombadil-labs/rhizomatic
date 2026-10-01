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
        UseTree::Name(n) if n.ident == "self" => {
            let path = prefix.trim_end_matches("::");
            out.push((
                path.rsplit("::").next().unwrap_or("self").to_string(),
                path.to_string(),
            ));
        }
        UseTree::Name(n) => out.push((n.ident.to_string(), format!("{prefix}{}", n.ident))),
        UseTree::Rename(n) => out.push((
            n.rename.to_string(),
            if n.ident == "self" {
                prefix.trim_end_matches("::").to_string()
            } else {
                format!("{prefix}{}", n.ident)
            },
        )),
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
fn module_path_attribute(attrs: &[syn::Attribute]) -> bool {
    fn path(meta: &syn::Meta) -> bool {
        if meta.path().is_ident("path") {
            return true;
        }
        if let syn::Meta::List(list) = meta {
            if list.path.is_ident("cfg_attr") {
                return syn::punctuated::Punctuated::<syn::Meta, Token![,]>::parse_terminated
                    .parse2(list.tokens.clone())
                    .map(|items| items.iter().any(path))
                    .unwrap_or(true);
            }
        }
        false
    }
    attrs.iter().any(|a| path(&a.meta))
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
                let pattern: syn::Pat = input.call(syn::Pat::parse_multi)?;
                let mut node: syn::ExprMatch = match syn::parse_str::<Expr>("match () { _ => () }")?
                {
                    Expr::Match(m) => m,
                    _ => unreachable!(),
                };
                node.expr = Box::new(expr);
                node.arms[0].pat = pattern;
                if input.peek(Token![if]) {
                    input.parse::<Token![if]>()?;
                    node.arms[0].guard =
                        Some((Default::default(), Box::new(input.parse::<Expr>()?)));
                }
                if input.peek(Token![,]) {
                    input.parse::<Token![,]>()?;
                }
                Ok(vec![Expr::Match(node)])
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
    module: String,
    modules: BTreeSet<String>,
    symbol: String,
    impl_name: Option<String>,
    paths: BTreeSet<(String, String)>,
    imports: BTreeSet<(String, String)>,
    macros: BTreeSet<(String, String)>,
    unsupported: Vec<String>,
}
fn module_path(path: &str, module: &str, modules: &BTreeSet<String>) -> Result<String, String> {
    let parts: Vec<_> = path.split("::").collect();
    match parts.first().copied().unwrap_or("") {
        "self" => Ok(format!("crate::{module}::{}", parts[1..].join("::"))),
        "super" if parts.get(1) == Some(&"super") => {
            Err(format!("unsupported relative path {path}"))
        }
        "super" => Ok(format!("crate::{}", parts[1..].join("::"))),
        first if modules.contains(first) => Ok(format!("crate::{path}")),
        first => {
            let prelude = match first {
                "Vec" => Some("std::vec::Vec"),
                "Box" => Some("std::boxed::Box"),
                "String" => Some("std::string::String"),
                "Default" => Some("std::default::Default"),
                "Option" => Some("std::option::Option"),
                "Result" => Some("std::result::Result"),
                "str" | "bool" | "char" | "u8" | "u16" | "u32" | "u64" | "u128" | "usize"
                | "i8" | "i16" | "i32" | "i64" | "i128" | "isize" | "f32" | "f64" => {
                    return Ok(format!("core::primitive::{path}"));
                }
                _ => None,
            };
            Ok(prelude
                .map(|p| {
                    format!(
                        "{p}{}",
                        if parts.len() > 1 {
                            format!("::{}", parts[1..].join("::"))
                        } else {
                            String::new()
                        }
                    )
                })
                .unwrap_or_else(|| path.to_string()))
        }
    }
}
impl Paths {
    fn extern_crate(&mut self, x: &syn::ItemExternCrate) {
        if public(&x.vis) {
            self.unsupported
                .push("unsupported public extern crate reexport".into());
        }
        let target = x.ident.to_string();
        let alias = x
            .rename
            .as_ref()
            .map(|(_, n)| n.to_string())
            .unwrap_or_else(|| target.clone());
        self.imports.insert((self.symbol.clone(), target.clone()));
        self.aliases.insert(alias, target);
    }
    fn import(&mut self, u: &syn::ItemUse) {
        let mut imports = Vec::new();
        uses(&u.tree, String::new(), &mut imports);
        for (alias, path) in imports {
            if alias == "*" {
                self.unsupported.push("unsupported glob import".into());
                continue;
            }
            let mut segments = path.split("::");
            let first = segments.next().unwrap_or("");
            let tail = segments.collect::<Vec<_>>().join("::");
            let path = if let Some(target) = self.aliases.get(first) {
                if tail.is_empty() {
                    target.clone()
                } else {
                    format!("{target}::{tail}")
                }
            } else {
                path
            };
            match module_path(&path, &self.module, &self.modules) {
                Ok(path) => {
                    self.imports.insert((self.symbol.clone(), path.clone()));
                    self.aliases.insert(alias, path);
                }
                Err(e) => self.unsupported.push(e),
            }
        }
    }
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
                match module_path(&path, &self.module, &self.modules) {
                    Ok(path) => {
                        self.paths.insert((self.symbol.clone(), path));
                    }
                    Err(e) => self.unsupported.push(e),
                }
            }
        }
        visit::visit_path(self, p);
    }
    fn visit_macro(&mut self, m: &'ast syn::Macro) {
        self.macros.insert((
            self.symbol.clone(),
            m.path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>()
                .join("::"),
        ));
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
    fn visit_item_extern_crate(&mut self, x: &'ast syn::ItemExternCrate) {
        self.extern_crate(x);
    }
    fn visit_item_foreign_mod(&mut self, _: &'ast syn::ItemForeignMod) {
        self.unsupported
            .push("unsupported foreign production interface".into());
    }
    fn visit_item_use(&mut self, u: &'ast syn::ItemUse) {
        self.import(u);
        visit::visit_item_use(self, u);
    }
    fn visit_block(&mut self, b: &'ast syn::Block) {
        let saved = self.aliases.clone();
        // Rust block items, including use declarations, are in scope throughout the block.
        for statement in &b.stmts {
            if let syn::Stmt::Item(item) = statement {
                if let Item::Use(u) = item {
                    self.import(u);
                }
                if let Item::ExternCrate(x) = item {
                    self.extern_crate(x);
                }
                let name = match item {
                    Item::Fn(i) => Some(i.sig.ident.to_string()),
                    Item::Struct(i) => Some(i.ident.to_string()),
                    Item::Enum(i) => Some(i.ident.to_string()),
                    Item::Union(i) => Some(i.ident.to_string()),
                    Item::Type(i) => Some(i.ident.to_string()),
                    _ => None,
                };
                if let Some(name) = name {
                    self.aliases
                        .insert(name.clone(), format!("crate::{}::{name}", self.module));
                }
            }
        }
        visit::visit_block(self, b);
        self.aliases = saved;
    }
    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        let saved = std::mem::replace(&mut self.symbol, f.sig.ident.to_string());
        visit::visit_item_fn(self, f);
        self.symbol = saved;
    }
    fn visit_item_impl(&mut self, i: &'ast syn::ItemImpl) {
        let saved = self.impl_name.clone();
        let aliases = self.aliases.clone();
        if let syn::Type::Path(p) = i.self_ty.as_ref() {
            if let Some(name) = p.path.segments.last() {
                self.impl_name = Some(name.ident.to_string());
                self.aliases.insert(
                    "Self".into(),
                    format!("crate::{}::{}", self.module, name.ident),
                );
            }
        }
        visit::visit_item_impl(self, i);
        self.impl_name = saved;
        self.aliases = aliases;
    }
    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        let name = self.impl_name.as_deref().unwrap_or("<impl>");
        let saved = std::mem::replace(&mut self.symbol, format!("{name}::{}", f.sig.ident));
        visit::visit_impl_item_fn(self, f);
        self.symbol = saved;
    }
    fn visit_impl_item_const(&mut self, c: &'ast syn::ImplItemConst) {
        let name = self.impl_name.as_deref().unwrap_or("<impl>");
        let saved = std::mem::replace(&mut self.symbol, format!("{name}::{}", c.ident));
        visit::visit_impl_item_const(self, c);
        self.symbol = saved;
    }
    fn visit_item_trait(&mut self, t: &'ast syn::ItemTrait) {
        let saved = self.impl_name.replace(t.ident.to_string());
        visit::visit_item_trait(self, t);
        self.impl_name = saved;
    }
    fn visit_trait_item_fn(&mut self, f: &'ast syn::TraitItemFn) {
        let name = self.impl_name.as_deref().unwrap_or("<trait>");
        let saved = std::mem::replace(&mut self.symbol, format!("{name}::{}", f.sig.ident));
        visit::visit_trait_item_fn(self, f);
        self.symbol = saved;
    }
    fn visit_item_mod(&mut self, m: &'ast syn::ItemMod) {
        if module_path_attribute(&m.attrs) {
            self.unsupported
                .push("unsupported production module path attribute".into());
        }
        if m.content.is_some() {
            self.unsupported
                .push("unsupported inline production module".into());
        }
        visit::visit_item_mod(self, m);
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
fn dependency_record(
    dependencies: &mut Vec<Value>,
    position: (&str, &str, &str),
    path: &str,
    import: bool,
    aggregate: &BTreeMap<String, String>,
    external: &BTreeSet<String>,
) -> Result<(), String> {
    let (source, module, symbol) = position;
    let region = if module == "wasm" {
        "host-adapter"
    } else if module == "lib" {
        "compatibility-aggregate"
    } else {
        "semantic-owner"
    };
    if let Some(path_tail) = path.strip_prefix("crate::") {
        let parts: Vec<_> = path_tail.split("::").collect();
        let resolved = if let Some(target) = parts.first().and_then(|first| aggregate.get(*first)) {
            format!(
                "{}{}",
                target,
                if parts.len() > 1 {
                    format!("::{}", parts[1..].join("::"))
                } else {
                    String::new()
                }
            )
        } else {
            path_tail.to_string()
        };
        let parts: Vec<_> = resolved.trim_start_matches("crate::").split("::").collect();
        let target_owner = owner(
            parts.first().copied().unwrap_or(""),
            parts.get(1).copied().unwrap_or(""),
        );
        if target_owner == "unclassified" {
            return Err(format!(
                "unclassified internal dependency {source}: {symbol} -> {path}"
            ));
        }
        dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,symbol),"target":format!("crate::{resolved}"),"rawTarget":path,"resolvedTarget":format!("crate::{resolved}"),"targetOwner":target_owner,"form":if import {"syn-import"}else{"syn-resolved-path"},"sourceRegion":region}));
    } else if path
        .split("::")
        .next()
        .is_some_and(|prefix| external.contains(prefix))
    {
        dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,symbol),"target":path,"form":if import {"syn-external-import"}else{"syn-external-path"},"sourceRegion":region}));
    } else if import {
        return Err(format!(
            "unsupported unresolved import {source}: {symbol} -> {path}"
        ));
    } else {
        return Err(format!(
            "unsupported unresolved qualified path {source}: {symbol} -> {path}"
        ));
    }
    Ok(())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::args().nth(1).unwrap_or_else(|| "../..".into());
    let metadata = std::process::Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
        ])
        .arg(Path::new(&root).join("implementations/rust/Cargo.toml"))
        .output()?;
    if !metadata.status.success() {
        return Err("Cargo dependency metadata failed".into());
    }
    let metadata: Value = serde_json::from_slice(&metadata.stdout)?;
    let package = metadata["packages"]
        .as_array()
        .ok_or("Cargo packages missing")?
        .iter()
        .find(|p| p["name"] == "rhizomatic")
        .ok_or("Rust witness Cargo package missing")?;
    let mut external_crates: BTreeSet<String> = ["std", "core", "alloc"]
        .into_iter()
        .map(str::to_string)
        .collect();
    for dependency in package["dependencies"]
        .as_array()
        .ok_or("Cargo dependencies missing")?
    {
        let name = dependency["rename"]
            .as_str()
            .or_else(|| dependency["name"].as_str())
            .ok_or("Cargo dependency name missing")?;
        external_crates.insert(name.replace('-', "_"));
    }
    let dir = Path::new(&root).join("implementations/rust/src");
    let mut files = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    let root_ast = syn::parse_file(&fs::read_to_string(
        Path::new(&root).join("implementations/rust/src/lib.rs"),
    )?)?;
    let modules: BTreeSet<String> = root_ast
        .items
        .iter()
        .filter_map(|i| {
            if let Item::Mod(m) = i {
                Some(m.ident.to_string())
            } else {
                None
            }
        })
        .collect();
    let mut aggregate_aliases = BTreeMap::new();
    for item in &root_ast.items {
        if let Item::Use(u) = item {
            if public(&u.vis) {
                let mut names = Vec::new();
                uses(&u.tree, String::new(), &mut names);
                for (name, path) in names {
                    aggregate_aliases.insert(
                        name,
                        module_path(&path, "lib", &modules)?
                            .trim_start_matches("crate::")
                            .to_string(),
                    );
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
            if let Item::ExternCrate(x) = item {
                let target = x.ident.to_string();
                let alias = x
                    .rename
                    .as_ref()
                    .map(|(_, n)| n.to_string())
                    .unwrap_or_else(|| target.clone());
                aliases.insert(alias, target);
            }
            if let Item::Use(u) = item {
                let mut paths = Vec::new();
                uses(&u.tree, String::new(), &mut paths);
                for (a, p) in paths {
                    if a == "*" {
                        return Err(format!("unsupported glob import in {source}").into());
                    }
                    aliases.insert(a, module_path(&p, module, &modules)?);
                }
            }
        }
        for item in &ast.items {
            match item {
                Item::Mod(x) => {
                    if module_path_attribute(&x.attrs) {
                        return Err(format!(
                            "unsupported production module path attribute in {source}"
                        )
                        .into());
                    }
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
                Item::Union(x) if public(&x.vis) => record(
                    &mut exports,
                    module,
                    &x.ident.to_string(),
                    &source,
                    "union",
                    &x.attrs,
                ),
                Item::Trait(x) if public(&x.vis) => {
                    record(
                        &mut exports,
                        module,
                        &x.ident.to_string(),
                        &source,
                        "trait",
                        &x.attrs,
                    );
                    for item in &x.items {
                        let (name, kind, attrs) = match item {
                            syn::TraitItem::Fn(f) => {
                                (f.sig.ident.to_string(), "trait-method", &f.attrs)
                            }
                            syn::TraitItem::Type(t) => {
                                (t.ident.to_string(), "trait-type", &t.attrs)
                            }
                            syn::TraitItem::Const(c) => {
                                (c.ident.to_string(), "trait-constant", &c.attrs)
                            }
                            _ => continue,
                        };
                        record(
                            &mut exports,
                            module,
                            &format!("{}::{name}", x.ident),
                            &source,
                            kind,
                            attrs,
                        );
                    }
                }
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
                            let p = module_path(&p, module, &modules)?;
                            let parts: Vec<_> = p.split("::").filter(|v| *v != "crate").collect();
                            let target_owner = owner(
                                parts.first().copied().unwrap_or(""),
                                parts.get(1).copied().unwrap_or(""),
                            );
                            e["owner"] = json!(target_owner);
                            e["contract"] =
                                json!(format!("rhizomatic.{target_owner}/native-api/1"));
                            e["target"] = json!(p);
                            e["classification"] = json!("compatibility_reexport");
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
                        let (member, kind, attrs, vis) = match i {
                            syn::ImplItem::Fn(f) => {
                                (f.sig.ident.to_string(), "method", &f.attrs, &f.vis)
                            }
                            syn::ImplItem::Const(c) => {
                                (c.ident.to_string(), "associated-constant", &c.attrs, &c.vis)
                            }
                            syn::ImplItem::Type(t) => {
                                (t.ident.to_string(), "associated-type", &t.attrs, &t.vis)
                            }
                            _ => continue,
                        };
                        if public(vis) {
                            record(
                                &mut exports,
                                module,
                                &format!("{name}::{member}"),
                                &source,
                                kind,
                                attrs,
                            );
                        }
                    }
                }
                _ => {}
            }
            let symbol = match item {
                Item::Fn(x) => x.sig.ident.to_string(),
                Item::Struct(x) => x.ident.to_string(),
                Item::Enum(x) => x.ident.to_string(),
                Item::Union(x) => x.ident.to_string(),
                Item::Const(x) => x.ident.to_string(),
                Item::Static(x) => x.ident.to_string(),
                Item::Type(x) => x.ident.to_string(),
                Item::Impl(x) => match x.self_ty.as_ref() {
                    syn::Type::Path(p) => p.path.segments.last().unwrap().ident.to_string(),
                    _ => String::new(),
                },
                Item::Use(_) => "<import>".into(),
                _ => String::new(),
            };
            let mut visitor = Paths {
                aliases: aliases.clone(),
                module: module.into(),
                modules: modules.clone(),
                symbol,
                impl_name: None,
                paths: BTreeSet::new(),
                imports: BTreeSet::new(),
                macros: BTreeSet::new(),
                unsupported: Vec::new(),
            };
            visitor.visit_item(item);
            if !visitor.unsupported.is_empty() {
                return Err(format!("{source}: {}", visitor.unsupported.join("; ")).into());
            }
            for (symbol, path) in visitor.imports {
                dependency_record(
                    &mut dependencies,
                    (&source, module, &symbol),
                    &path,
                    true,
                    &aggregate_aliases,
                    &external_crates,
                )?;
            }
            for (symbol, path) in visitor.paths {
                dependency_record(
                    &mut dependencies,
                    (&source, module, &symbol),
                    &path,
                    false,
                    &aggregate_aliases,
                    &external_crates,
                )?;
            }
            for (symbol, name) in visitor.macros {
                dependencies.push(json!({"source":source,"symbol":symbol,"owner":owner(module,&symbol),"form":"macro-region","macros":[name],"status":"parsed-known-macro-arguments"}));
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
