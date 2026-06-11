//! Cross-implementation interop probe: pull everything from a remote peer (e.g. the TypeScript
//! server) into a fresh Rust peer and print the resulting set digest + count.
//!
//!   cargo run --example http_sync -- http://127.0.0.1:PORT
//!
//! If the printed digest equals the server's own digest, the two implementations agree on every
//! canonical byte that crossed the wire — content addresses, signatures, set digest construction.

use rhizomatic::http::pull_from_url;
use rhizomatic::peer::Peer;

fn main() {
    let url = std::env::args()
        .nth(1)
        .expect("usage: http_sync <base-url>");
    let mut peer = Peer::new("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    let (accepted, rejected) = pull_from_url(&mut peer, &url).expect("sync");
    println!("accepted={accepted} rejected={rejected}");
    println!("count={}", peer.reactor.len());
    println!("digest={}", peer.reactor.digest());
}
