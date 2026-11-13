-- ---------------------------------------------------------------------------
-- The AI layer is called Simeli, not QIRA.
--
-- `modules.nav_section` is not a label — it is the join key between a module
-- row and the sidebar entry it gates: Layout.jsx matches a disabled module's
-- `nav_section` (and its `name`) against the navigation tree's own item names,
-- and hides the entry when they match. The tree now names that entry
-- "Simeli AI", so a row still saying "QIRA AI" points at a section that no
-- longer exists and could never gate anything.
--
-- Today this is latent rather than broken: `ai_assistant` is a core module, and
-- the gate only ever considers non-core rows. It stops being latent the moment
-- anyone makes it optional, which is exactly the kind of change nobody thinks
-- to trace back to a string in a seed file — so the key is corrected now.
--
-- Idempotent, and scoped to the one row: a WHERE on the old value means
-- re-running this after the rename is a no-op rather than a second rewrite.
-- ---------------------------------------------------------------------------

UPDATE modules
   SET nav_section = 'Simeli AI'
 WHERE key = 'ai_assistant'
   AND nav_section = 'QIRA AI';
