# Model-facing contracts

`src/tool-descriptions.json` contains only the native description claims.
Native tools import this small file. Shared rules and reviewed behavioral evidence
lives in `test/contracts/claims.json`; the production Gradle runtime includes
`src/**` and does not include `test/**` or the refresh script.

Run `npm run contracts:refresh` from `coordinator` after merging or editing a
model-facing contract. It refreshes informational file/line locations without
invalidating reviewed evidence. Paragraphs use topic/content identities, so an
inserted paragraph does not renumber the existing paragraphs. Description
sentences and API paragraphs also use content identities. Schema paths, enum
members and named capabilities keep their structural identities.

Refresh lists only actual changed, added and removed contracts. It preserves
unchanged predicates and witnesses. New or changed entries remain
`review-required`, including after another refresh; the command exits with code
1 while review is outstanding. Removed entries are retained as explicit review
items. A text change with a content identity appears as its old removal and new
addition, without invalidating nearby text. Locations are not contract snapshots
and never participate in the guard comparison.

For each listed entry, inspect the real implementation and verify its behavior.
Update its predicate and executable checks, then replace `review-required` with
`checked`, `partial`, `advisory` or `out-of-scope` as justified. Give incomplete or
contextual claims a precise reason. Delete reviewed removed entries and any
retired atomic predicates attached to them. Do not approve changes by copying old
checks without assessing the changed meaning. This explicit evidence edit is the
review step; refresh cannot perform it. Run `npm run test:contracts` and the
relevant runtime/Java checks after review. CI rejects stale snapshots, retired
entries, missing witnesses and outstanding review.

Discovery reads the exported tools, schemas, API, action fields, limits,
conditions, control and strategy references, skill and always-sent agent config.
Each description sentence, schema node, enum, parameter, default, reference
paragraph, example and documented result code has a contract entry. Syntax
examples prove admission only unless another witness proves their physical effect.
Java witnesses must be reachable from `VerificationMain`.

`checked` means the predicate is witnessed through a production runtime, Java
verification or headless live bridge. `partial` identifies residual contextual
clauses or an incomplete factual predicate. `advisory` identifies model choices;
contextual vanilla knowledge is distinct from a callable tool guarantee. Finite
fixtures do not certify arbitrary datapacks. Keep research reports, execution
tallies, artifact hashes and session logs outside this evidence file; record the
fixture/test name and factual predicate instead. Live checks use a copied server
template and isolated ports. Never infer an effect from accepted input alone.
