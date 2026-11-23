# Rhizomatic Engineering

**When bespoke software is cheaper to generate than to buy, the hard problem stops being
writing programs and becomes connecting programs that nobody coordinated. Rhizomatic
Engineering is the practice of building software that exchanges claims in one shared form, so
that a third person can connect two tools after both have shipped, and every reader can check
who connected them and how.**

This page is the argument. The [README](README.md) is the format. The
[overview](spec/00-overview.md) is the design. [SPEC-3](spec/03-schema.md) and
[SPEC-5](spec/05-resolution.md) define the HyperSchema and the Schema.

## The moment

A coding agent can now write a working program for one person and one afternoon. People build
the tool they need instead of buying one or adopting a framework. Some of that software lives
for a week.

Connecting software was always costly. What changed is the other side of the ledger: the
programs themselves are now cheap, numerous and short-lived. Each has its own tables, its own
field names and its own idea of what a "task" or a "person" is. The seam between two of them,
written by different people for different reasons with no meeting in between, is now most of
the work.

## Why pairwise glue fails

The same agent that wrote the program can write an adapter between two of them. So why would
anyone need more than that?

A careful adapter can carry everything that matters across one seam: who said a thing, where
two sources disagree, and when a source takes something back. The cost appears with the third
tool. Its author must negotiate with each of the others again, and so must the fourth. Glue is
written once per pair. Each pair decides for itself how to carry authorship, disagreement and
correction, and no two pairs decide alike.

A shared form for claims changes the count. An adapter is written once per tool, not once per
pair. The author of the third tool reads what the first two already publish and chooses how to
reconcile their accounts, without asking either of them for anything.

## Three products, one thing

Three kinds of system are being built around AI agents, and they are sold as separate things:

| Sold as | What it keeps |
|---|---|
| A memory graph for agents | Statements about things, and how the things relate |
| An append-only ledger for provenance and audit | Who asserted what, when they say they asserted it, and which earlier claim a correction targets |
| A message bus between agents | Statements that travel from one party to another |

Each is a view of the same object: **a growing set of attributed statements about related
things.** Read it by relation and it is a graph. Read it by author and it is a ledger. Move
part of it to someone else and it is a message.

## The atom

Rhizomatic starts from one structure, the **delta**: an immutable claim with one or more
pointers, each labelled with its role. Its id is the hash of its canonical bytes. A delta can
carry a signature, and a delta that crosses to another peer must be signed or be covered by a
signed manifest. Four consequences follow:

- **Merging is set union.** Two collections of claims combine with no migration and no
  write-time conflict. A disagreement survives the merge, for readers to resolve.
- **Nothing is overwritten.** A retraction is a new claim about an old claim.
- **A claim can be about a claim.** Agreement, doubt, evidence and correction use the same form.
- **The carrier does not matter.** A file, a request and a repository carry the same claims,
  and a claim verifies the same way wherever it lands.

## The hyperschema

A set of claims that only grows is not yet something a program can use. The piece that makes it
usable, and that makes the rest of this page work, is the **HyperSchema**.

A HyperSchema is a small, named program. Give it one thing, such as a person or a project, and
it says which claims are relevant to that thing. A typical one selects the claims that point at
the thing, follows declared relationships through child schemas, and accounts for negations.
Any author can negate a claim. The program decides which negations count and whether to hide
or mark a claim while an effective negation stands. Its result is a **HyperView**: the
surviving claims,
filed by property, each still carrying its author. Nothing is decided yet. If two sources
disagree about a name and both claims survive, both names are there.

A second step decides. A **Schema** applies one **Policy** to each property: the latest claim
wins, or a ranked list of authors wins, or every value is kept. Its result is a **View**, the
plain object that a program wants.

```
HyperView = eval(HyperSchema, claims)     which claims matter, with provenance
View      = resolve(Schema, HyperView)    what this reader takes them to mean
```

Relevance and resolution are separate on purpose. Most of what this page promises comes from
that separation:

- **A boundary on an unbounded set.** The engine uses the HyperSchema to narrow down which
  results may need an update when a claim arrives. A program that asks about the whole set can
  need a new evaluation on every arrival.
- **Disagreement with an address.** Two readers can share a HyperSchema and differ only in
  Policy. Their policies can give different answers from the same claims, and they can point at
  the exact claims where they part.
- **One answer everywhere.** Conforming evaluators give identical canonical bytes for the same
  root, claims, read time, parameter bindings and resolved schema definitions. Two people see different truths only
  because they chose different inputs.
- **A way of reading is data.** A HyperSchema is itself stored as claims. You can sign one,
  publish it, fork it and retract it. A tool can ship its HyperSchemas beside its claims. A
  stranger can adopt them, or write a new one over the same claims, including claims written
  long before that HyperSchema existed.
- **Safe to accept from a stranger.** A HyperSchema is a program in a small closed algebra with
  no escape hatch. Reading someone's HyperSchema is not running their code.

So schema stops being a contract that everyone signs before the first write. It becomes
something a reader brings, and something that accumulates, with an author on every part.

**A mapping between two vocabularies is a claim too.** One tool calls a person's employer
`employer`. Another calls it `job`. A third party can publish claims that map both names to the
organization end of an employment relationship. A HyperSchema that asks for `employer` through
those mappings also matches `job` on older claims, and each result keeps its original spelling.
Nobody edits their data. A reader who does not accept that third party's mappings sees what
they saw before.

Computation follows the same rule. A reducer, a model or an agent that adjudicates messy
records is another author: its output enters as ordinary signed claims that a reader can
inspect, trust or ignore.

## Beside the AT Protocol

The nearest neighbour is the AT Protocol. The AT Protocol defines how public records are
structured, hosted and exchanged. Rhizomatic also specifies federation, including HTTP sync.
Its distinctive feature is that readers can publish and reuse rules for interpreting claims.
The two overlap more than a first look suggests:

- **The unit.** An AT record has a repository path and a CID for its contents. A Rhizomatic
  delta hashes its claims and connects one or more targets through named roles.
- **Records about records.** Both have them. A Bluesky like is itself a record whose subject
  pairs another record's AT URI with its CID. When a delta refers to another delta, it
  identifies that delta by hash.
- **Change.** An AT account can replace or delete a record at its path. Delta sets merge by
  union. A correction adds a claim. A negation points to the old claim by hash, and the
  reader's rules determine whether it still counts.
- **Signatures.** An AT repository commit authenticates its records. Independent labelers can
  sign and negate annotations, and readers can choose labelers. Rhizomatic permits unsigned
  local deltas. Federation requires a signature on the delta's hash or a signed manifest
  covering it.
- **Schema.** An AT record declares its type. Readers can resolve its published Lexicon through
  DNS to a schema record in the designated repository. Rhizomatic publishes read programs as
  claims: a HyperSchema selects and groups claims, and a Schema resolves the result.
- **Two vocabularies.** AT applications can share Lexicons and reuse an AppView that joins
  records. In Rhizomatic, a third party can map role or context names to the same end of a
  relation. Readers choose which mappings to trust. The mappings match names without
  transforming record structures.
- **Two authors who disagree.** A Schema assigns policies to properties and supplies a default.
  Given the same HyperView and Schema, conforming evaluators produce identical canonical View
  bytes.

So the difference is not the network. An AT AppView can combine records from many
repositories. In Rhizomatic, a reader can publish, sign and fork a HyperSchema that follows
declared relationships and a Schema that resolves the resulting claims. Given identical inputs,
conforming implementations produce identical canonical View bytes.

The two could work together. A Lexicon could define a record carrying a small delta as bytes
or referencing a larger one as a blob. A PDS could host the record, and a relay could carry its
updates. The DID identifies the AT account. Linking it to the delta's Ed25519 author key would
require a verifiable binding. Hosting deltas in AT repositories is a proposal and is not built.
A separate bridge that reads AT records as claims is in development.

## The practice

Six habits make up Rhizomatic Engineering:

1. **Emit claims, not rows.** Say who asserts what about which things.
2. **Never overwrite.** Correct by adding.
3. **Keep the disagreement.** Resolve it for a reader, not for everyone.
4. **Decide the schema late**, at the edge, for one purpose. Publish it as claims.
5. **Write the last mile, not the stack.** Keep the tool you have. Add the adapter that turns
   what it already knows into claims, and the HyperSchema and Schema that turn other people's
   claims into what it needs. This is work an agent does well.
6. **Assume a third party.** Publish so that someone you never met can build on it.

## What this does not do

- **It does not make statements true.** A signature shows who said a thing.
- **It does not solve meaning.** Two programs must still agree on what a field means. What
  changes is that the agreement is explicit, has an author, and can be revised without a
  rewrite. Mappings today relate the names of roles in a relationship. They do not rewrite one
  data structure into another.
- **It does not un-publish.** A claim that someone copied stays copied. A retraction tells
  readers what you now say. It does not reach into their copies.
- **It is not a blockchain.** There is no consensus and no global order. A timestamp is a claim
  like any other. No peer can compel another: what a peer accepts and what it runs are its own
  decisions.
- **It is not a database.** A database is one machine you can build on it.

The honest risk is adoption. This work draws on RDF, nanopublications, the AT Protocol, patch
theory, CRDTs and lens-based schema translation. Its bet is narrower than theirs: that an agent
can make the first adapter cheap enough to justify writing it before anyone knows who the second
reader will be.

## Where it stands

A specification with shared conformance vectors, and four independent implementations checked
against them. TypeScript and Rust cover conformance levels 0 to 4 and are checked byte for byte
against the same vectors, including federation between them. Elixir and Haskell cover level 0.
The TypeScript package is on npm as
[`@bombadil/rhizomatic`](https://www.npmjs.com/package/@bombadil/rhizomatic). It is pre-1.0,
and the newest work ships as `next` prereleases.

To see it run, clone this repository and run the terminal demo: `cd implementations/ts &&
npm install && npm run demo`. To try the practice, point your agent at this repository and ask
it to turn one thing you already have into claims.
