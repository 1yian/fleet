-- A lane card holds the plan of its mate: the goal, the time zone, and the scheduled wakes.
-- plan_next is what the captain set. plan is what the mate loaded when it last started, with the
-- time it took effect, so a changed plan applies after the mate restarts and never fires for a
-- time that passed before.
ALTER TABLE cards ADD COLUMN plan TEXT CHECK (json_valid(plan));
ALTER TABLE cards ADD COLUMN plan_next TEXT CHECK (json_valid(plan_next));
