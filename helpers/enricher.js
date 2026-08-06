/**
 * enricher.js
 * node helpers/enricher.js       - default; run the enricher to enrich the database
 * node helpers/enricher.js merge - truncate db-shm and db-wal and merge to .db
 */

/**

    The goal is to enrich each entry in the database to encourage the replacement of `null` values as many as possible. The usage of `null` is only acceptable when an property truly has no sense in being the property of the entry.

    The implementation strategy itself has changed; instead of using a single model to work on a batch of 30, run multiple instances at once instead where each instance works on a single entry. This is to avoid the situation where a single entry with a large amount of text can cause the model to exceed the token limit, which would result in an error and halt the entire batch.

    This is painfully slower, however, this could push the AI to it's maximum potential in enriching the database, particularly in not forgetting the encouragement to replace `null` values with meaningful content.

    The real question is how many instances could be run at once without exceeding the token limit. The answer is not known, but it is expected to be around 10-20 instances at once. And whether or not multiple terminal execution is possible, as it surely will boost the progress, though at the same time would not be different with running multiple instances in a higher number inside one single terminal execution.

    Maybe, the best approach is to run multiple instances in a single terminal execution, but with a limit of 10-20 instances at once. This would allow for better control and monitoring of the process, while still maximizing the potential of the AI to enrich the database. But that would also mean I would need to consider gathering more apikeys. Though, for now, having in total 17 apikeys, with, say, 15 instances running at once, would be a good start, and would also provide me with 2 extra apikeys in case some aren't working; though it's also possible that ONLY around three apikeys would work at a time, and the rest would be already hit 429.

    We could immediately pair the going-to-be-made engine with the existing `ai-provider.js` to make the engine work with the existing logic of apikeys rotation. Following the existing logic, all `enricher.js` really need to do is simply grab 15 entries from the database that doesn't have or have but null or in value of 0 "enriched" property in the database. And then simply loop through the 15, where for each entry, the engine simply calls `ai-provider.js` with one single row (expected to be JSON object as the function parameter) instead of batch. And once an enrichement process (still talking per-entry) is done, mark the entry with "enriched" being true; the engine would then update the database with the enriched entry. Do a checkpoint by merging the `db-shm` and `db-wal` to the main .db file, and then continue to the next batch of 15 entries. And so on, until all entries in the database are enriched.

 */