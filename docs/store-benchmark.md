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
- Free on `/mnt/c` at the start: 89 GB.
- Load average at the start: `0.54 1.58 2.23`. At the end: `1.26 1.42 1.74`.
- Other agents shared the machine. No other heavy job of the builder ran beside it.
- The run used the branch merged with `main` at `82ef553` (#137).

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

All numbers come from one run at 1,000,000 deltas, after the merge of #137.

| measure | value |
| --- | --- |
| append wall time, whole build | 424.1 s |
| append time, `append` calls only | 382.3 s |
| append deltas/s, whole run | 2,616 |
| append deltas/s, first 10% | 4,141 |
| append deltas/s, last 10% | 1,917 |
| append ms per batch of 1,000, p50 / p99 / max | 359 / 1,000 / 1,825 |
| db file after close | 1,366,224,896 bytes |
| log (`-wal`) before close | 47,071,032 bytes |
| bytes per delta, after close | 1,366 |
| warm open: open, `peer`, `read`, first `get` | 4.1 ms |
| `read()` of a snapshot | 0.04 ms |
| `scope`, 1 anchor, p50 / p99 | 0.58 / 1.54 ms (18 deltas on average) |
| `scope`, 10 anchors, p50 / p99 | 5.35 / 9.52 ms (180 deltas on average) |
| `get` of 1 id, p50 / p99 | 0.036 / 0.088 ms |
| `digest("")`, the root node | 0.25 ms (1,000,000 ids) |
| `digest` at a 6-digit prefix of a held id (`1e2065`) | 0.10 ms (3,944 ids) |
| `changes` from revision 0, all pages | 142 ms (4 pages, 1,000 records) |
| `changes`, the latest page | 0.44 ms |
| `prove()` on a clean file | 0.49 ms |
| purge of 1 id, posture `unproven`, p50 / max of 100 | 2.6 / 17.0 ms (100 calls) |
| `prove()` on a dirty file, after those purges | 5,964 ms |
| second build, posture `proven`: deltas/s | 2,618 (424.7 s wall) |
| second build: deltas/s, first / last 10% | 4,052 / 2,215 |
| purge of 100 ids in one call, posture `proven` | 6,680 ms, claim `proven`, 100 of 100 `removed` |
| peak RSS of the process | 837 MiB (677 MiB after the first build) |

The reads ran against 1,000 random entities that the peer holds, and 1,000 random held ids.
The p99 of 1,000 samples is a true p99. For 100 samples the table gives the maximum.
The open is warm: the same process closed the file just before, so the OS page cache holds it.
Every one of the 100 `unproven` purges answered `removed`. The `prove()` after them claimed
`proven`.

The digest prefix comes from a held id: its first 4 digits (the multihash prefix `1e20`) and 2 more.
Round 1 of the review found that the first run used the prefix `a7`. No id starts with `a7`, so
that row timed an empty node. This run replaces all numbers of the first run.

## What stands out

- The append rate falls from 4,141 to 1,917 deltas/s, first decile to last decile, in the first build.
- In the second build the same decile falls to 2,215 deltas/s, so the last decile varies by run.
- The p99 batch takes 2.8 times the p50 batch in the first build.
- A purge of 100 ids by a `proven` peer takes 6.7 s, and a dirty `prove()` takes 6.0 s.
- The call is synchronous inside the store's rebuild. The benchmark did not measure what else waits.
- The first run, before the merge of #137, gave 15.4 s for a purge of the same shape. Two runs show no cause.
- Reads stay below 10 ms at p99, and the feed from revision 0 takes 142 ms.

## What was not measured

- The time of the rebuild (`VACUUM`) apart from the rest of a purge. The public surface does not
  separate it, so the purge row is the wall time of the whole call.
- More than one peer. The script takes `--peers`, but this run used one.
- Signed deltas. A signature adds bytes per delta and a cost in the host, not in the store.
- A purge of 1 id by a `proven` peer, and many such purges in a row.
- Concurrent readers or writers in other processes.
- Appends of one delta per call. Each such call makes one revision and one commit. The rate then
  depends on one full sync commit per delta. The retention of 1,024 revisions then covers 1,024
  deltas, not 1,000,000.
- A second run at 1,000,000 on one head. The numbers come from one run each.
- The Rust store. It ships a memory store only.
