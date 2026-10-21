-- A Lavish review wait is a job whose result is the captain's feedback on the page. It answers
-- the decision key that the worker's review round opened, so the card's hold ends when the
-- captain answers on the page. Null for every other job.
ALTER TABLE jobs ADD COLUMN resolves TEXT;
