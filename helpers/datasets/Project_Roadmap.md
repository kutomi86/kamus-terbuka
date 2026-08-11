# Project Roadmap & Execution Blueprint: `kamus-terbuka`

`kamus-terbuka` is an open-source, offline-first Indonesian dictionary and slang engine for Node.js. It merges an existing 190k+ KBBI dataset with modern, internet-grounded slang generated via Gemini API, backed by an indexed SQLite database.

---

## Phase 1: CSV to SQLite Conversion

**Status:** ✅ Completed

Convert the raw KBBI CSV source data into a SQLite database.

---

## Phase 2: Entry Enrichment

**Status:** ✅ Completed

Enrich every entry using AI: fill in a lot of previously `null` fields like `lema` and `pelafalan`, and add new fields `jenis_entri` and `tags_sumber`. Every property should be filled in unless it's unreasonable to do so for that particular entry.

---

## Phase 3: Relationship & Slang Marking

Two parallel efforts:

- **Relationship Builder** — Status: ✅ Completed
> Add `terkait` and `peribahasa_terkait`, and improve the existing `turunan` and `gabungan_kata` fields on every entry based on `jenis_entri`, so relationships between entries stay meaningful without becoming unnecessarily bloated.

- **Abbreviation Expansion Cleanup** — Status: ✅ Completed
> Some entries still contain unexpanded abbreviations left over from earlier relationship building. Add a focused cleanup pass that scans `makna`, `contoh`, `peribahasa`, `terkait` (excluding anything already covered by `turunan`/`gabungan_kata`), `peribahasa`, `peribahasa_terkait`, and `kata` itself (for entries with the `jenis_entri` of `peribahasa`) to find and expand abbreviations, using an external, reusable abbreviation map that also tracks how many times each abbreviation was found and expanded.

- **Slang Marker** — Status: ✅ Completed
> Add a new `bahasa_gaul` boolean property (`0` or `1`) to every entry, using AI to identify which entries are slang.

---

## Phase 4: Slang Builder

**Status:** ⬜ Not Yet

Discover new and modern slang (e.g. brainrot terms, recent TikTok slang) and add them as new entries, but only if they don't already exist in the database. New entries are marked with `tags_sumber = 'indo-slang'` and `bahasa_gaul` defaulting to `1`.

Note: still need to clarify how the filtering will actually be done — the old plan risks not working effectively.

---

## Phase 5: Library Interface

**Status:** ⬜ Not Yet

Build a simple library of functions to query and interact with the database.