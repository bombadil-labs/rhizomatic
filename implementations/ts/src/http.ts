// The blessed HTTP federation binding (ERRATA-6 F5): POST /rhz/v0/sync over the Peer protocol.
// Transport only — partitioning, the signature boundary, and admission all live in Peer (F3/§5).

import { createServer, type Server } from "node:http";
import { claimsToJson, parseClaims } from "./json-profile.js";
import { Peer } from "./peer.js";
import { manifestMemberIds } from "./reactor.js";
import { makeDelta } from "./set.js";
import { verifyDelta } from "./sign.js";
import type { Delta } from "./types.js";

interface WireDelta {
  claims: unknown;
  sig?: string;
}

interface SyncResponse {
  bundles: Array<{ manifest: WireDelta; members: WireDelta[] }>;
  loose: WireDelta[];
}

function toWire(d: Delta): WireDelta {
  // No id on the wire: the receiver recomputes content addresses (F5; never trust the wire).
  return d.sig === undefined
    ? { claims: claimsToJson(d.claims) }
    : { claims: claimsToJson(d.claims), sig: d.sig };
}

function fromWire(w: WireDelta): Delta {
  return makeDelta(parseClaims(w.claims), w.sig);
}

// Compute the OFFER for a WANT, partitioned per the signature boundary (F3).
export function offerFor(peer: Peer, have: ReadonlySet<string>): SyncResponse {
  const offered = peer.offeredSet().filter((d) => !have.has(d.id));
  const offeredIds = new Set(offered.map((d) => d.id));
  const isSignedManifest = (d: Delta) =>
    d.sig !== undefined && verifyDelta(d) === "verified" && manifestMemberIds(d).length > 0;
  const covered = new Set<string>();
  const bundles: SyncResponse["bundles"] = [];
  for (const m of offered.filter(isSignedManifest)) {
    const members = manifestMemberIds(m)
      .filter((id) => offeredIds.has(id))
      .map((id) => offered.find((d) => d.id === id)!)
      .filter((d) => !isSignedManifest(d));
    bundles.push({ manifest: toWire(m), members: members.map(toWire) });
    for (const mem of members) covered.add(mem.id);
    covered.add(m.id);
  }
  const loose = offered
    .filter((d) => !covered.has(d.id) && d.sig !== undefined && verifyDelta(d) === "verified")
    .map(toWire);
  return { bundles, loose };
}

// Serve a peer's offered lens over HTTP. Returns the server; close it when done.
export function servePeer(peer: Peer, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rhz/v0/sync") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { have?: string[] };
        const have = new Set<string>(Array.isArray(body.have) ? body.have : []);
        const response = offerFor(peer, have);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Pull from a remote peer over HTTP: WANT(my ids) -> verify -> admission -> ingest (§5).
export async function pullFromUrl(
  peer: Peer,
  baseUrl: string,
): Promise<{ accepted: number; rejected: number }> {
  const have = peer.reactor.arrivalLog().map((d) => d.id);
  const res = await fetch(`${baseUrl}/rhz/v0/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ have }),
  });
  if (!res.ok) throw new Error(`sync failed: HTTP ${res.status}`);
  const offer = (await res.json()) as SyncResponse;
  let accepted = 0;
  let rejected = 0;
  // Reuse the local admission machinery by reconstructing deltas and handing them to the
  // same ingest paths pullFrom uses: bundles atomically, loose individually.
  for (const b of offer.bundles) {
    const manifest = fromWire(b.manifest);
    if (verifyDelta(manifest) !== "verified") {
      rejected += 1 + b.members.length;
      continue;
    }
    const members = b.members.map(fromWire);
    if (!peer.admits(manifest) || !members.every((m) => peer.admits(m))) {
      rejected += 1 + members.length;
      continue;
    }
    const result = peer.reactor.ingestBundle(manifest, members);
    if (result.status === "accepted") accepted += 1;
    else if (result.status === "rejected") rejected += 1;
  }
  for (const w of offer.loose) {
    const d = fromWire(w);
    if (verifyDelta(d) !== "verified" || !peer.admits(d)) {
      rejected += 1;
      continue;
    }
    const result = peer.reactor.ingest(d);
    if (result.status === "accepted") accepted += 1;
    else if (result.status === "rejected") rejected += 1;
  }
  return { accepted, rejected };
}
