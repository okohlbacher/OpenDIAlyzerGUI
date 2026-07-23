# Research corpus

Scrapers and raw exports behind `docs/COMPETITIVE.md`. Kept so every claim in
that document is re-derivable rather than taken on trust — the same standard the
engine project applies to its benchmarks.

| File | What |
|---|---|
| `harvest.py` | Scrapes skyline.ms support threads (LabKey full-text search + thread pages) |
| `mine.py` | Clusters and counts the harvested corpus by theme |
| `issues.tsv` | Full public export of Skyline's own LabKey issue tracker — 1,039 closed issues, all fields |

`issues.tsv` came from an endpoint that is easy to lose track of, so it is worth
keeping:

```
https://skyline.ms/query/home/issues/exportRowsTsv.view?schemaName=issues&query.queryName=Issues&query.maxRows=-1
```

No authentication required. Only closed issues are public; open ones are not
exposed.

The DIA-NN corpus (1,290 issues, 4,946 comments, 622 discussions) came from the
GitHub API against `vdemichev/DiaNN` and is trivially re-fetchable, so it is not
vendored here.

**Not vendored:** the ~64 MB of cached HTML and JSON responses. Re-run the
scrapers if you need them.
