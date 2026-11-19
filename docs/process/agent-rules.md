# Rules for agents that build and review here

`AGENTS.md` says how the repository works. This file holds the standing rules for an agent that
builds a pull request or reviews one. A task brief names the task and points here. It does not
repeat these rules.

The tracking issue of the active arc lists the stack and the owner's rulings. Read it first.

## Every agent

- Work in the one checkout that the brief names. Do not change another branch.
- Write for the owner in plain short sentences: 20 words or fewer, active voice, simple tenses,
  no metaphor. This covers commit messages, pull request bodies, issues and review comments.
- Report what you ran and what you did not run. A check that you did not run is not a pass.
- Capture the exit code of every check. Do not decide a pass from a search of the output.
- Put every probe under `timeout`. Do not use a fixed sleep in a test or a script.
- Kill a process only by its exact pid. Never use `pkill -f` or `pgrep -f`.
- Leave no background job running when you report.
- Never erase or damage data that a test of yours did not create in its own temporary directory.
- Send no personal detail of anyone to an outside service.

### A mutation probe

- Copy the file to a scratch directory. Change the copy's source. Run the test. Copy the file
  back. Compare with `cmp`.
- Never undo a probe with `git checkout <file>`, `git restore` or `git stash`.
- A mutant that does not fail a test is a finding.

### The machine

- Ask the brief how many heavy commands can run at once. When it does not say, run one.
- Use `RUST_TEST_THREADS=4`. Reuse `implementations/rust/target`. Cargo is in `~/.cargo/bin`.
- A timing rail measures time. Run it with no other heavy command beside it. When it fails once,
  run it again alone before you call it a failure, and report both runs.

## The bar

Run all of it on each head that you push. A clean git merge does not prove that the tests of the
two sides pass together, so a merge commit needs the whole bar too.

1. In `implementations/ts`: `npm run gen-vectors`, then `npm run docs:build`. The tree must be
   clean after them. Then `npm run check`.
2. In `implementations/rust`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
   `cargo test`, `cargo clippy --lib -- -D warnings`.
3. The release cost step exactly as `.github/workflows/ci.yml` runs it, and
   `cargo test --release --test witness store_cost::`.
4. The WASM clippy and build, as the workflow runs them.
5. At the root: `node tools/precheck.mjs` and `node tools/check-rust-command-boundaries.mjs`.

A change that touches no TypeScript and no vectors can skip step 1. A change that touches no Rust
can skip steps 2 to 4. Say which steps you skipped and why.

After a push, start the heavy CI tier:
`gh workflow run ci.yml --ref <branch> -f heavy=true`.

## A builder

- Read the spec text and the other witness before you write code. List each rule that you
  implement, with the line of the other witness that it matches.
- Write the test first where the change fixes a defect, and see it fail.
- Give red and green evidence for each new test: the failing message before, the pass after.
- A new rule of a conformance runner needs a wrong-store row or a document row in the rule table
  of each witness. Prove each row: remove the rule line, and the row goes red.
- Put no test hook, switch or quirk in `src` that the public surface can reach. In Rust, a
  top-level `#[cfg(test)]` item is allowed. The inventory scanner refuses an inline test module.
- Do not fix a defect of the other witness inside an unrelated pull request. Report it.
- Stop and report when the task needs more than the brief allows. Do not widen the task.
- Open the pull request. Do not merge it. Do not review it.

### A change near erasure

- A purge, a peer delete and every success report of them are erasure code.
- Answer one question in the body, in one line, with the proof: could this change remove a delta
  that would have survived before?
- The test is what a release build does on a state that a store can reach, damaged states
  included. A state that exists only because the old code crashed is not kept behaviour.
- When the answer is yes, write at the top of the body that the owner merges it.
- Every erasure test is two-sided: the target is gone, and a named bystander survives. Assert the
  report and the state of the store after it.
- A known gap gets a test whose title starts with `[gap: ...]`. It asserts what the code does
  today, so a fix must edit it.

### The pull request body

One sentence of what it does. WHAT CHANGED as a list. WHY, one reason per sentence. The tests,
with the red evidence. What to read. DECISIONS, for each change to what the repository promises.
RISKS, each in its own sentence. "Where the plan was wrong" and "What I did not do", when they
apply. Every exit code of the bar.

### The Rust export inventory

- `contracts/command/rust-exports.json` must match the source. `precheck` says when it is stale.
- The checker compares the dependency rows as a sorted list. Keep a repeated row repeated.
- Update a row whose owner or target moved. Keep the hand-written `classification` and
  `semantics` fields of existing rows.
- Name a new module in `implementations/rust/examples/command_inventory.rs`.
- The scanner refuses the path forms `E::from` and `map_err(Into::into)`, and
  `std::sync::atomic`.
- For TypeScript: `node tools/command-inventory.mjs --adopt`.

## A reviewer

- You did not write the change, and you start with no knowledge of the builder's reasoning.
- Review the exact head that the brief names. Say its full SHA in the review.
- Use a neutral question: which inputs or states give a wrong outcome?
- Mark each finding CONFIRMED, when you ran or read the proof, or PLAUSIBLE. Give the file and
  line, a severity, and how to reproduce it. A clean result is a valid result.
- Review the tests too. Could this test pass with the fix reverted? Could it pass with the
  feature deleted? Run mutants of your own, not only the builder's.
- Check the claims of the body against the code. A sentence that states more than the code does
  is a finding.
- For erasure code, judge each report by one question: can this report be false?
- Do not commit, push, edit the pull request or merge. Restore every file that a probe changed.
- Post the review as a comment on the pull request. Name the reviewer's model and the builder's.
- End with one verdict: MERGE, or FIX FIRST with what blocks. For a pull request that the owner
  merges, the verdicts are READY FOR THE OWNER and FIX FIRST.

## The steward

- A merge needs green CI on the reviewed head, both tiers, and a posted review of that head by a
  reviewer in a fresh context. Read the conclusion of each run before the merge.
- Review again after every fix. The fix is where the next defect usually is.
- The owner merges a change that widens what erasure removes, a stable release, and a change to
  what the system promises outside the active arc. The steward merges the rest.
- A review finding that does not block becomes an issue with the label `follow-up`. It does not
  ride in the next pull request.
- A question for the owner becomes an issue with the label `needs-owner`: the context, the
  options and a recommendation. Ask in chat too when it blocks work.
- Update the tracking issue at each merge.
- Write to the owner at a merge, at a decision, or when something breaks. Stay quiet otherwise.
