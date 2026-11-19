# Rules for agents that build and review here

`AGENTS.md` says how the repository works. Read it first. This file holds the standing rules for
an agent that builds a pull request or reviews one. A task brief names the task and points here.

The tracking issue of the active arc lists the stack and the owner's rulings. Read it too.

## Every agent

- Do not switch the branch of any checkout. Push only to the branch that the brief names.
- Write for the owner in plain short sentences: 20 words or fewer, active voice, no metaphor.
  This covers commit messages, pull request bodies, issues and review comments.
- Report what you ran and what you did not run. A check that you did not run is not a pass.
- Capture the exit code of every check. Do not decide a pass from a search of the output.
- Put every probe under `timeout`. Do not use a fixed sleep in a test or a script.
- Kill a process only by its exact pid. Never use `pkill -f` or `pgrep -f`.
- Leave no background job running when you report.
- Never erase or damage data that a test of yours did not create in its own temporary directory.
- Send no personal detail of anyone to an outside service.

### A mutation probe

`AGENTS.md`, section "Probes", gives the time limit, the memory limit and the thread limit. Follow
it. The steps are:

1. Copy the file to a scratch directory as a backup.
2. Change the file in the tree.
3. Build. Then run the test under the limits.
4. Copy the backup over the file. Check with `cmp` that the two are equal.

Never undo a probe with `git checkout <file>`, `git restore` or `git stash`. A mutant that fails no
test goes into the review.

### The machine

- Ask the brief how many heavy commands can run at once. When it does not say, run one.
- Use the build directory that the brief names. When it names none, set `CARGO_TARGET_DIR` to
  one shared path, and run those builds one at a time.
- Cargo is in `~/.cargo/bin`. Put it on `PATH`.
- A timing rail measures time. Run it with no other heavy command beside it.
- When a timing rail fails once, run it again alone. Report both runs.

## The bar

Run it on each head that you push. A clean git merge does not prove that the tests pass together.
So a merge commit needs the whole bar too.

Commit first. The generators must then leave the tree clean.

Use the compiler that CI uses. Set `RUSTUP_TOOLCHAIN=1.100.0` in the shell for steps 2 to 6.
That covers the Rust steps, the WASM step and `node tools/precheck.mjs`. Install it once:
`rustup toolchain install 1.100.0 --no-self-update -c rustfmt,clippy -t wasm32-unknown-unknown`.
To raise the pin, change in one commit the seven `dtolnay/rust-toolchain` lines of `ci.yml`, this
paragraph and the Commands section of `AGENTS.md`. Then run the heavy tier once.

1. In `implementations/ts`: `npm run gen-vectors`, `npm run docs:build`, then `npm run check`.
2. In `implementations/rust`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
   `cargo test`, `cargo clippy --lib -- -D warnings`.
3. In `implementations/rust`, the two release cost rails:
   `cargo test --release --test witness -- --ignored --exact store_views::a_per_view_scan_in_the_release_turns_rail_four_red store_views::a_per_view_scan_turns_the_held_views_rail_red`.
   Two tests must pass. Then `cargo test --release --test witness store_cost::`.
4. The WASM clippy and build, as the Rust witness job of `.github/workflows/ci.yml` runs them.
5. At the root: `node tools/precheck.mjs` and `node tools/check-rust-command-boundaries.mjs`.
6. At the root: the `node --test` line of the `contracts` job of `ci.yml`.
7. Run `node tools/check-all.mjs haskell elixir` for a change to `vectors/` or to the Haskell or
   Elixir witness. Run it for a change to the delta, hash or canonical encoding code of the other
   witnesses: `implementations/ts/src/delta/`, and `delta.rs`, `hash.rs` and `cbor.rs` in
   `implementations/rust/src/`. Run it where GHC and Elixir are installed. When they are not, say
   so in the body. CI runs them for a code change.

What a change can skip:

- A change that touches no file under `implementations/` or `vectors/` can skip steps 1 to 4.
- A change that touches no TypeScript and no vectors can skip step 1.
- A TypeScript change does not skip the Rust steps. Rust tests read TypeScript source files.
- Say which steps you skipped, and why.

CI has two tiers, as `AGENTS.md` says. The fast tier runs on every pull request. The heavy tier
is for a release candidate only: `gh workflow run ci.yml --ref <branch> -f heavy=true`.

## A builder

- Name the consumer call that needs the change. When you cannot, stop and report.
- Read the spec text and the other witness before you write code.
- List each rule that you implement, with the line of the other witness that it matches.
- A new normative behavior gets its vector before or with its code.
- Write the test first where the change fixes a defect, and see it fail.
- Give red and green evidence for each new test: the failing message before, the pass after.
- A new rule of a conformance runner needs a row in the rule table of each witness.
- Prove each row: remove the rule line, and the row goes red.
- Put no test hook, switch or quirk in `src` that the public surface can reach.
- In Rust, a top-level `#[cfg(test)]` item is allowed. The scanner refuses an inline test module.
- Do not fix a defect of the other witness inside an unrelated pull request. Report it.
- Stop and report when the task needs more than the brief allows. Do not widen the task.
- Open the pull request. Do not merge it. Do not review it.

### A change near erasure

A purge, a peer delete and every success report of them are erasure code.

- Answer one question in the body, in one line, with the proof: could this change remove a delta
  that would have survived before?
- Compare the old and the new release build on each state that a store can reach. Damaged states
  count.
- The change widens when the new build removes a delta that the old build kept on that state.
- An old error or refusal keeps the delta. A removal there is a widening.
- A crash is a panic or an abort of the old release build. Only a crash is not kept behavior.
- An error that the old code returns or throws keeps the delta, also part-way through a call.
- Name each crash state in the body. When you are not sure that it is a crash, treat it as kept.
- When the change widens, write at the top of the body that the owner merges it.
- Every erasure test is two-sided: the target is gone, and a named bystander survives.
- Assert the report, and assert the state of the store after it.
- A known gap gets a test whose title starts with `[gap: ...]`. It asserts what the code does
  today, so a fix must edit it.

### The pull request body

- One sentence of what it does.
- WHAT CHANGED, as a list.
- WHY, one reason per sentence.
- The tests, with the red evidence.
- What to read.
- DECISIONS, for each change to what the repository promises.
- RISKS, each in its own sentence.
- "Where the plan was wrong" and "What I did not do", when they apply.
- Every exit code of the bar.

### The Rust export inventory

- Run `node tools/check-rust-command-boundaries.mjs --adopt` at the root. It rewrites
  `contracts/command/rust-exports.json` from the source and prints rows added, removed, updated and kept.
- It keeps the hand-written texts of an export. It replaces them when the owner or definition moved.
- It prints one line for each export that it adds, removes or regenerates, and for each export
  whose text it kept while a field changed. A line for a replaced or removed text shows the old text.
- Read each line, and correct a text that is no longer true.
- A removed export loses its hand-written texts. For a rename, copy them to the new row.
- It refuses an empty or malformed file, and a source that the checker refuses. It writes nothing then.
- Name a new module in `implementations/rust/examples/command_inventory.rs`.
- The scanner refuses some forms, such as an inline production module and an undeclared
  capability. Read its message and change the code, not the scanner.
- For TypeScript: `node tools/command-inventory.mjs --adopt`.

## A reviewer

A review here is a prosecution. It builds a case in service of the goal of the change. It does
not list everything that looks wrong.

- The brief states the goal: who needs the change, and which public call serves them. When it
  states none, ask for it.
- You did not write the change. Review the exact head that the brief names, and say its SHA.

### What blocks

Two kinds of charge block. Everything else is a note.

- **A defect.** Quote the claim that it breaks. Give evidence that you ran or read. Say the harm:
  who gets a wrong result, and from which state.
- **A premise.** Quote the goal. Say why the change is more than the goal needs, or names no
  consumer. Give the smaller form.

Three rules decide between a charge and a note:

- A suspicion is a note until you prove it. Run it, or read the lines.
- The state must be one that a store can get into: by public calls, or by a fault of its medium,
  such as a crash, a torn write or a lost row. A state that only a defect in other code can make
  gives a note.
- In erasure code, a report that can be false and a loss of a bystander's data are charges in
  every state of the rule above.

Give five notes at most, in order of weight. A mutant that fails no test is a note, or a charge
when you can show the harm.

### How to work

- Test the claim where it is most likely to fail. Do not test everything.
- Read the head in a checkout of your own, or read its git objects. Run mutants only where no
  other agent has uncommitted work.
- Do not commit, push, edit the pull request or merge. Restore every file that a probe changed,
  and delete a `target` directory that you made.
- A second round tests the answer to each charge and the code that the answer changed. It does
  not open the rest again.
- Say what you tested and what you did not. End with one verdict: MERGE when you have no charge,
  FIX FIRST with the charges. For a pull request that the owner merges, write READY FOR THE OWNER
  in place of MERGE.
- Post the review on the pull request. Name the reviewer's model and the builder's.

## The steward

### Reviews

- Write the goal into the brief. A change with no consumer that you can name does not go to
  review. It becomes an issue.
- A charge that holds gets a fix, and the fix gets a second round. A charge that does not hold
  gets an answer on the pull request.
- A note becomes an issue with the label `follow-up`, or nothing. It starts no round.
- Round three is the last that the steward can start alone. After it, choose one: cut the scope,
  merge with follow-ups, or ask the owner or a reviewer from another model family which of the
  two is right.

### A reviewer from another model family

A reviewer of the builder's own family tests whether the code keeps a rule. One from another
family is more likely to ask whether the rule should exist.

- Ask for one at each milestone and before each decision on direction. It reads the goal, the
  plan and the contract, not the code.
- Ask for one on each pull request that changes a contract, the erasure code or this process,
  and on each pull request that reaches round three. It reads the diff too.
- Use an account that the owner approved for this work. Never print or commit its key.
- Post its answer on the pull request or the issue, with the name of the model.

### A merge

- A merge needs a green fast tier on the reviewed head, and a posted review of that head.
- A release needs a green heavy tier on `main` first.
- A reviewer in a fresh context writes that review.
- A change to Markdown alone gets no CI run. It needs the review only.
- Read the conclusion of each CI run before the merge.
- The owner merges a change that widens what erasure removes, and a stable release.
- The owner also merges a change to what the system promises outside the active arc.
- The steward merges the rest.
- A pull request that the owner merges does not wait on a branch. Bring it to the owner in the
  session in which it is ready, or build it last.

### The record

- A question for the owner becomes an issue with the label `needs-owner`. It holds the context,
  the options and a recommendation. Ask in chat too when it blocks work.
- Update the tracking issue at each merge.
- Write to the owner at a merge, at a decision, or when something breaks. Stay quiet otherwise.
