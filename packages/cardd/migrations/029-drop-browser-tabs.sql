-- The fleet has no browser any more, so which card held which tab is no longer kept.
-- Nothing references browser_tabs, and its index goes with it.
DROP TABLE browser_tabs;
