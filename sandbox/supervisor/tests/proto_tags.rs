//! Drift guard for `proto/zs_warm.proto` (brief §3.2a): every field tag the warm-up client's
//! minimal schema copies from Zed's `crates/proto/proto/*.proto` must still match the checkout
//! under `../../zed`. Prost decodes by tag number, so a renumbered `Envelope` variant would make
//! the warm-up silently see `payload: None` and never warm anything.
//!
//! Skips (with a message) when the Zed checkout is absent, which is the case for a plain CI
//! checkout of this repository; CI's `agent-tests` job checks the fork's `crates/proto/proto`
//! out sparsely so the guard runs there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;

/// Our copy of the schema.
const OURS: &str = include_str!("../proto/zs_warm.proto");

/// `(message name, field name) → tag` extracted from a `.proto` text: top-level messages, their
/// plain fields, nested `oneof` members (attributed to the enclosing message).
fn field_tags(text: &str) -> BTreeMap<(String, String), u32> {
    let message_start = Regex::new(r"^\s*message\s+([A-Za-z0-9_]+)\s*\{").unwrap();
    let scope_start = Regex::new(r"^\s*(?:oneof|enum)\s+[A-Za-z0-9_]+\s*\{").unwrap();
    let field = Regex::new(
        r"^\s*(?:optional\s+|repeated\s+)?[A-Za-z0-9_.]+\s+([A-Za-z0-9_]+)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;",
    )
    .unwrap();
    let mut tags = BTreeMap::new();
    // Scope stack: message names, or an empty string for a oneof/enum (whose fields belong to the
    // enclosing message; enum values never match the field regex because they have no type).
    let mut stack: Vec<String> = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.split("//").next().unwrap_or_default();
        // One line may open a scope, declare a field and close the scope (`message B { x = 1; }`).
        loop {
            let trimmed = rest.trim_start();
            if trimmed.is_empty() {
                break;
            }
            if let Some(captures) = message_start.captures(trimmed) {
                stack.push(captures[1].to_string());
                rest = &trimmed[captures.get(0).unwrap().end()..];
                continue;
            }
            if let Some(captures) = scope_start.captures(trimmed) {
                stack.push(String::new());
                rest = &trimmed[captures.get(0).unwrap().end()..];
                continue;
            }
            if let Some(captures) = field.captures(trimmed) {
                let owner = stack
                    .iter()
                    .rev()
                    .find(|name| !name.is_empty())
                    .cloned()
                    .unwrap_or_default();
                if !owner.is_empty() {
                    tags.insert(
                        (owner, captures[1].to_string()),
                        captures[2].parse().unwrap(),
                    );
                }
                rest = &trimmed[captures.get(0).unwrap().end()..];
                continue;
            }
            if let Some(stripped) = trimmed.strip_prefix('}') {
                stack.pop();
                rest = stripped;
                continue;
            }
            // Anything else on this line (syntax/package/import lines, enum values, options).
            break;
        }
    }
    tags
}

fn zed_proto_dir() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../zed/crates/proto/proto");
    dir.is_dir().then_some(dir)
}

#[test]
fn warm_proto_tags_match_the_zed_checkout() {
    let Some(dir) = zed_proto_dir() else {
        eprintln!("proto_tags: no zed/ checkout beside this repository; skipping");
        return;
    };
    let mut upstream = BTreeMap::new();
    for entry in std::fs::read_dir(&dir).expect("read crates/proto/proto") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("proto") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read proto");
        upstream.extend(field_tags(&text));
    }
    assert!(
        upstream.contains_key(&("Envelope".to_string(), "id".to_string())),
        "the upstream Envelope was not parsed"
    );

    let ours = field_tags(OURS);
    assert!(
        ours.len() > 20,
        "our schema parsed into {} fields",
        ours.len()
    );
    let mut drift = Vec::new();
    for ((message, field), tag) in &ours {
        match upstream.get(&(message.clone(), field.clone())) {
            Some(theirs) if theirs == tag => {}
            Some(theirs) => drift.push(format!(
                "{message}.{field}: ours = {tag}, zed = {theirs} (renumbered upstream)"
            )),
            None => drift.push(format!(
                "{message}.{field} (tag {tag}) no longer exists upstream"
            )),
        }
    }
    assert!(
        drift.is_empty(),
        "proto/zs_warm.proto drifted from zed:\n{}",
        drift.join("\n")
    );
}

#[test]
fn tag_extraction_understands_oneofs() {
    let tags = field_tags(
        "message A {\n  uint32 id = 1;\n  optional B b = 2; // comment\n  oneof payload {\n    C c = 5;\n    D d = 6;\n  }\n}\nmessage B { string x = 1 [deprecated = true]; }\n",
    );
    assert_eq!(tags[&("A".to_string(), "id".to_string())], 1);
    assert_eq!(tags[&("A".to_string(), "b".to_string())], 2);
    assert_eq!(tags[&("A".to_string(), "c".to_string())], 5);
    assert_eq!(tags[&("A".to_string(), "d".to_string())], 6);
    assert_eq!(tags[&("B".to_string(), "x".to_string())], 1);
}
