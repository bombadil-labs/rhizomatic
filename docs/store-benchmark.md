# The SQLite store at 1,000,000 deltas

One by-hand run of the TypeScript SQLite store at real size (issue #140, point 7). It is not a
rail. No test and no CI job runs it.

## The machine

- CPU: 11th Gen Intel Core i7-11700F, 16 logical CPUs.
- RAM: 15 GiB visible to Linux (WSL2 limit 16 GB).
- OS: WSL2, kernel 6.18.58.1-microsoft-standard-WSL2.
- Node: v24.14.0. The package names Node 22; this run used 24.
- SQLite: 3.53.2, the engine in `better-sqlite3` 12.
- Temp dir: `/tmp` on ext4 (`/dev/sdd`, the WSL virtual disk), 861 GB free at the start.
- Load average at the start: `1.66 2.11 1.90`. At the end: `1.42 1.38 1.55`.
- Other agents shared the machine. No other heavy job of the builder ran beside it.

## The command

From `implementations/ts`:

```
npm run bench:store -- --json <file>
```

The defaults: `--deltas 1000000 --peers 1 --batch 1000`, a fresh `mkdtempSync` dir, removed at the
end.

## The data

- The script `tools/bench-store.ts` imports only the sources of the public entries `.` and
  `./store/sqlite`.
- A seeded PRNG makes every delta. The run is the same each time.
- 100,000 entities. Each delta has a `subject` entity and 1 to 3 more pointers.
- The other pointers use six roles. 40% point at an entity, the rest hold small primitives.
- About 2% of the deltas negate an earlier delta.
- 8 authors. The deltas are unsigned: `append` takes a delta without `sig`.
- `admissionOf` builds each admission. One batch of 1,000 deltas is one `append`.
- Default store options: change retention of 1,024 revisions, pages of 256 records.

## The results

| measure | value |
| --- | --- |
| append wall time, whole build | 431.7 s |
| append time, `append` calls only | 399.8 s |
| append deltas/s, whole run | 2,501 |
| append deltas/s, first 10% | 4,354 |
| append deltas/s, last 10% | 1,419 |
| append ms per batch of 1,000, p50 / p99 / max | 364 / 2,044 / 2,751 |
| db file after close | 1,366,224,896 bytes |
| log (`-wal`) before close | 47,071,032 bytes |
| bytes per delta, after close | 1,366 |
| open, `peer`, `read`, first `get` | 3.8 ms |
| `read()` of a snapshot | 0.04 ms |
| `scope`, 1 anchor, p50 / p99 | 0.57 / 2.07 ms (18 deltas on average) |
| `scope`, 10 anchors, p50 / p99 | 5.17 / 9.29 ms (180 deltas on average) |
| `get` of 1 id, p50 / p99 | 0.037 / 0.246 ms |
| `digest("")`, the root node | 0.30 ms |
| `digest` at a 2-digit prefix | 0.16 ms |
| `changes` from revision 0, all pages | 124 ms (4 pages, 1,000 records) |
| `changes`, the latest page | 0.47 ms |
| `prove()` on a clean file | 0.45 ms |
| purge of 1 id, posture `unproven`, p50 / p99 | 2.7 / 11.3 ms (100 calls) |
| `prove()` on a dirty file, after those purges | 6,751 ms |
| second build, posture `proven`: deltas/s | 2,604 (417.1 s wall) |
| second build: deltas/s, first / last 10% | 4,243 / 2,093 |
| purge of 100 ids in one call, posture `proven` | 15,372 ms, claim `proven` |
| peak RSS of the process | 846 MiB (541 MiB after the first build) |

The reads ran against 1,000 random entities that the peer holds, and 1,000 random held ids.
Every one of the 100 `unproven` purges answered `removed`. The `prove()` after them claimed
`proven`.

## What stands out

- The append rate falls from 4,354 to 1,419 deltas/s, first decile to last decile, in the first build.
- In the second build the same decile falls to 2,093 deltas/s, so the last decile varies by run.
- The p99 batch takes 5.6 times the p50 batch in the first build.
- A purge of 100 ids by a `proven` peer blocks for 15.4 s, and a dirty `prove()` for 6.8 s.
- Reads stay below 10 ms at p99, and the feed from revision 0 takes 124 ms.

## What was not measured

- The time of the rebuild (`VACUUM`) apart from the rest of a purge. The public surface does not
  separate it, so the purge row is the wall time of the whole call.
- More than one peer. The script takes `--peers`, but this run used one.
- Signed deltas. A signature adds bytes per delta and a cost in the host, not in the store.
- A purge of 1 id by a `proven` peer, and many such purges in a row.
- Concurrent readers or writers in other processes.
- A second run at 1,000,000. The numbers come from one run each.
- The Rust store. It ships a memory store only.
