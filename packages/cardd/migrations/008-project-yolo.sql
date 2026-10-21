-- A project's yolo flag replaces grants as the standing merge authority: with it on, a mate merges
-- a green PR of that project without asking. Only the captain sets it, through the cardd command
-- line. No session operation changes it.
ALTER TABLE projects ADD COLUMN yolo INTEGER NOT NULL DEFAULT 0 CHECK (yolo IN (0, 1));

-- A lane grant that covered merging in one project, on any branch, and that is still in force,
-- was that project's yolo flag, so the project keeps it. Every other grant ends: a lane grant
-- without a project never meant every project of every lane, and a card grant was the captain's
-- word for one PR. A card whose grant ended asks the captain again when its PR is done.
UPDATE projects SET yolo = 1 WHERE name IN (
  SELECT scope_project FROM grants
  WHERE lane IS NOT NULL AND merge = 1 AND ended_at IS NULL AND scope_branch IS NULL
    AND (expires IS NULL OR expires > CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- The grant entries on cards stay in the record. Nothing reads the table any more.
DROP TABLE grants;
