-- Fleet does not track a worker's no-mistakes runs: a worker owns its own. This drops what 016 created.
DROP INDEX one_revalidation;
DROP INDEX validations_card;
DROP TABLE validations;
