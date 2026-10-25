-- The timed check reads only open cards. A card is closed once it has a cleanup entry, so this index finds them without a scan of every entry.
CREATE INDEX entries_cleanup ON entries (card) WHERE kind = 'cleanup';
-- The bundle reminder looks up its last entry by condition and recipient, so it does not scan the history of check entries.
CREATE INDEX entries_check_bundle ON entries (json_extract(fields, '$.condition'), json_extract(fields, '$.to')) WHERE author = 'check';
