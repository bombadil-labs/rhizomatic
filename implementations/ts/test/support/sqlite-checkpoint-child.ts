// A connection of its own, in a process of its own, for the rails of a busy checkpoint (§4.13
// reading 143). It opens the file with `better-sqlite3` alone, not through the store.
//
// - `hold`: takes the write lock, prints `held <pid>`, and lets it go at the first line on stdin,
//   or when stdin ends. Then it prints `released <pid>`.
// - `checkpoint <ms>`: sets the busy timeout to `<ms>`, prints `start <pid>`, runs
//   `wal_checkpoint(TRUNCATE)` and prints `done <pid> <row>`. The engine takes the checkpoint lock
//   first and then waits for the write lock under the busy handler, so while another process
//   holds the write lock this process is in a checkpoint for up to `<ms>`.

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";

const [path, mode, wait] = process.argv.slice(2) as [string, string, string | undefined];
const db = new Database(path);
if (mode === "hold") {
  db.exec("BEGIN IMMEDIATE");
  writeSync(1, `held ${process.pid}\n`);
  const input = createInterface({ input: process.stdin });
  await new Promise((done) => {
    input.once("line", done);
    input.once("close", done);
  });
  input.close();
  db.exec("COMMIT");
  writeSync(1, `released ${process.pid}\n`);
} else {
  db.pragma(`busy_timeout = ${Number(wait)}`);
  writeSync(1, `start ${process.pid}\n`);
  const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as unknown[];
  writeSync(1, `done ${process.pid} ${JSON.stringify(row)}\n`);
}
db.close();
