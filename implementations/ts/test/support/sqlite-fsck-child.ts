// A child of the fsck rails (sqlite-store-fsck.test.ts). It appends to and purges from one peer
// of the SQLite store at a path, again and again, until the file `<path>.stop` exists. Each
// append adds two deltas built by `admissionOf`: a fact at a new entity, and a negation of the
// fact before it, so that each commit writes `target` and `reference` rows. Every second append
// is followed by a purge of the two oldest deltas the child added. A `conflict` reads again.
// Arguments: the path and the peer id. It prints `started 1` after its first commit and
// `done {appends, purges}` at its end.

import { existsSync, writeSync } from "node:fs";
import { makeDelta } from "../../src/delta/set.js";
import type { Delta } from "../../src/delta/types.js";
import { admissionOf } from "../../src/storage/admission.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";

const [path, peerId] = process.argv.slice(2) as [string, string];
const print = (word: string, value: unknown): void => {
  writeSync(1, `${word} ${JSON.stringify(value)}\n`);
};

const AUTHOR = `ed25519:${"0f".repeat(32)}`;
const fact = (n: number): Delta =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: `churn:${n}` } } }],
  });
const negation = (n: number, of: Delta): Delta =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "negates", target: { kind: "delta", deltaRef: { delta: of.id } } }],
  });

const store = await openSqliteStore(path);
let appends = 0;
let purges = 0;
try {
  const peer = await store.peer(peerId);
  const mine: string[] = [];
  let before = fact(0);
  for (let n = 1; !existsSync(`${path}.stop`); n++) {
    const now = await peer.read();
    const made = fact(n);
    const deltas = [made, negation(n, before)];
    const result = await peer.append(
      admissionOf(now, deltas, { at: n, sender: "churn", nextHead: `churn-${process.pid}-${n}` }),
    );
    now.release();
    if (result.status !== "committed") continue;
    before = made;
    mine.push(...deltas.map((d) => d.id));
    if (++appends === 1) print("started", 1);
    if (appends % 2 === 0) {
      await peer.purge(mine.splice(0, 2));
      purges++;
    }
  }
} finally {
  await store.close();
}
print("done", { appends, purges });
