# Plain language for vNext

Use these words in new Rhizomatic specs, vectors, comments, and documentation. The terms in the
left column are Loam's older vocabulary; they are listed here only to prevent their spread.
Choose the right-hand word from what the operation actually does.

| Older word | Use in new text |
| --- | --- |
| door | endpoint for a network boundary; write path or read path inside code |
| ground | delta set, including the store's, a peer's, or an as-of delta set |
| law, constitution | rules |
| reading | schema |
| pen | renderer key |
| slate | erasure request |
| cut | erasure run |
| graveyard | erasure record |
| condemned | marked for erasure |
| forgiven | lifted |
| leeway | permissions |
| envelope | resource limits |
| blessing, curse | approval, rejection |
| mint | create or issue |
| seam | interface |
| stock shelf | built-in schemas |
| voice | say who signed the delta, for example “signed by the operator” |
| stranded | orphaned |
| pulse | periodic check |

Keep **lens**, **home**, **custody**, and **hazard** where they are precise. Do not apply the table
to unrelated uses such as a storage pack's envelope metadata, a mathematical law, or cutting a
release. Existing format and API names are stable: `expand.reading` is a term JSON key, and
`resolveReading` is an exported API. Describe those as a resolution Schema in new prose while
spelling the actual keys and APIs exactly when needed. A rename of a canonical field needs its
own spec rule, vectors, and compatibility plan.
