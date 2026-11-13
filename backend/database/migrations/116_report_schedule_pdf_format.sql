-- PDF as a scheduled report format.
--
-- 114 constrained `format` to CSV/JSON/HTML because those were the only
-- renderers that existed. The export route offered `format=pdf` and quietly
-- returned CSV; there is now a real tabular PDF renderer
-- (services/pdf/pdfService.generateTabularPdf), so the constraint is widened to
-- match what the code can actually produce.
--
-- Widened rather than dropped: the format is read by the scheduler to decide
-- how to render and attach, and an unrecognised value there means a schedule
-- that fails silently every interval, to recipients who are simply not told.

-- Dropped by definition rather than by name: 114 declared the check inline on
-- the column, so its name is whatever Postgres generated. Guessing that name
-- and being wrong leaves the old constraint in place and this migration
-- reporting success while PDF schedules keep being rejected.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'report_schedules'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%format%'
  LOOP
    EXECUTE format('ALTER TABLE report_schedules DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_format_check
CHECK (format IN ('CSV', 'JSON', 'HTML', 'PDF'));

COMMENT ON COLUMN report_schedules.format IS
  'CSV | JSON | HTML | PDF — HTML is sent as the mail body, the rest as attachments';
