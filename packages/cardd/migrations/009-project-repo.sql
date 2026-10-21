-- The GitHub repository of a project, as owner/name. cardd finds a ship card's PR by the
-- card's branch in this repository (spec section 13.1). NULL until it is known: cardd reads it
-- from the origin remote of a clone on its own host, or `cardd project add --repo` sets it.
ALTER TABLE projects ADD COLUMN repo TEXT;
