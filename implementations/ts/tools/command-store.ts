// Conformance host adapter: one-writer fsynced journal image; never a production storage claim.
import {
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Delta } from "../src/delta/types.js";
import { parseCommandDelta, serializeCommandDelta } from "../src/command-data/codec.js";
import type {
  DurableOrdinaryJournalStore,
  OrdinaryJournalRead,
  OrdinaryJournalHead,
  ErasureJournalWrite,
} from "../src/federation/ordinary-journal-peer.js";
import type { PeerImageWrite } from "../src/federation/single-peer.js";
export type CommandStoreFault =
  | "conflict"
  | "committed-unconfirmed-persist"
  | "committed-unconfirmed-absent"
  | "throw-after-append"
  | "throw-before-append"
  | "crash-before-append"
  | "crash-after-append"
  | "source-unavailable";
interface Image {
  head: string | null;
  frames: string[];
  rows: unknown[];
  checkpoint?: string;
}
export class CommandFixtureStore implements DurableOrdinaryJournalStore {
  fault: CommandStoreFault | undefined;
  beforeAppend: (() => Promise<void>) | undefined;
  afterReadRows: (() => Promise<void>) | undefined;
  constructor(readonly path: string) {}
  private image(): Image {
    return existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Image)
      : { head: null, frames: [], rows: [] };
  }
  private write(image: Image): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = this.path + ".pending";
    const fd = openSync(temporary, "w");
    try {
      writeFileSync(fd, JSON.stringify(image));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  readJournal(): Promise<OrdinaryJournalRead> {
    if (this.fault === "source-unavailable") throw new Error("injected source unavailable");
    const image = this.image();
    return Promise.resolve(
      image.head === null
        ? image.rows.length
          ? { status: "rows-without-journal" }
          : { status: "empty" }
        : {
            status: "journal",
            head: image.head,
            frames: image.frames.map((h) => Uint8Array.from(Buffer.from(h, "hex"))),
            ...(image.checkpoint === undefined
              ? {}
              : { checkpoint: Uint8Array.from(Buffer.from(image.checkpoint, "hex")) }),
          },
    );
  }
  async readAdmittedRows(_peer: string, ids: readonly string[]): Promise<readonly Delta[]> {
    const rows = this.image()
      .rows.map(parseCommandDelta)
      .filter((d) => ids.includes(d.id));
    await this.afterReadRows?.();
    return rows;
  }
  readHead(): Promise<OrdinaryJournalHead> {
    const image = this.image();
    return Promise.resolve(
      image.head === null ? { status: "missing" } : { status: "head", head: image.head },
    );
  }
  async compareAndAppend(
    _peer: string,
    expected: string | null,
    nextHead: string,
    frame: Uint8Array | null,
    newlyAdmitted: readonly Delta[],
  ): Promise<PeerImageWrite> {
    if (frame !== null) {
      await this.beforeAppend?.();
      if (this.fault === "crash-before-append") process.exit(77);
      if (this.fault === "throw-before-append")
        throw new Error("injected pre-append unknown failure");
      if (this.fault === "committed-unconfirmed-absent")
        return { status: "committed-unconfirmed", fault: "injected unconfirmed absent" };
    }
    const image = this.image();
    if (
      image.head !== expected ||
      (expected === null && image.rows.length) ||
      (frame !== null && this.fault === "conflict")
    )
      return { status: "conflict" };
    const rows = new Map(
      image.rows.map((d) => {
        const delta = parseCommandDelta(d);
        return [delta.id, d] as const;
      }),
    );
    for (const d of newlyAdmitted) rows.set(d.id, serializeCommandDelta(d));
    this.write({
      ...image,
      head: nextHead,
      frames: [...image.frames, ...(frame === null ? [] : [Buffer.from(frame).toString("hex")])],
      rows: [...rows.values()],
    });
    if (frame !== null) {
      if (this.fault === "crash-after-append") process.exit(77);
      if (this.fault === "throw-after-append")
        throw new Error("injected post-append unknown failure");
      if (this.fault === "committed-unconfirmed-persist")
        return { status: "committed-unconfirmed", fault: "injected unconfirmed persisted" };
    }
    return { status: "durable" };
  }
  compareAndAppendErasure(
    peer: string,
    expected: string,
    head: string,
    frame: Uint8Array,
    rows: readonly Delta[],
    absentIds: readonly string[],
  ): Promise<ErasureJournalWrite> {
    const held = new Set(
      this.image()
        .rows.map(parseCommandDelta)
        .map((d) => d.id),
    );
    const refuted = absentIds.find((id) => held.has(id));
    return refuted
      ? Promise.resolve({ status: "absence-refuted", targetId: refuted })
      : this.compareAndAppend(peer, expected, head, frame, rows);
  }
  rawRows(rows: readonly Delta[]): void {
    const image = this.image();
    this.write({ ...image, rows: rows.map(serializeCommandDelta) });
  }
  observed(): { head: string | null; ids: string[]; frames: number } {
    const image = this.image();
    return {
      head: image.head,
      ids: image.rows
        .map(parseCommandDelta)
        .map((d) => d.id)
        .sort(),
      frames: image.frames.length,
    };
  }
}
