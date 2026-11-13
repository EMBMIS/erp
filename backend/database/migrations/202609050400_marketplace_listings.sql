-- The marketplace: an application one company built, offered to the rest.
--
-- ===========================================================================
-- WHY THIS IS A THIN TABLE
-- ===========================================================================
-- Nearly all of it already exists. An application is GLOBAL — one definition,
-- installed per company, with each company's data in its own tables. That is
-- the shape a marketplace needs, and it has been the shape since the registry
-- was written. Listing an application is therefore not a new kind of object;
-- it is a few facts about an existing one: who is offering it, how they
-- describe it to strangers, which version they stand behind, and what they
-- want for it.
--
-- `applications.visibility` stays the load-bearing column. Listing sets it to
-- 'global', withdrawing sets it back, and every read path already honours it —
-- so a withdrawn application stops being offered everywhere at once rather
-- than in the places somebody remembered to check.
--
-- ===========================================================================
-- PRICE IS RECORDED, NOT CHARGED
-- ===========================================================================
-- `price_cents` exists so a publisher can say what they want and a buyer can
-- see it before they care. Nothing here moves money, and the install path
-- refuses a paid listing outright rather than installing it and hoping
-- somebody settles up later.
--
-- That is deliberate. Charging needs answers this schema cannot invent: who
-- receives the money, what the platform's share is, what happens to an
-- installed application when a payment fails, how refunds interact with data
-- the buyer has since created, and which jurisdiction's tax applies to a
-- company in one country buying from a company in another. A half-built
-- payment flow is worse than none: it takes money and leaves the questions.

CREATE TABLE IF NOT EXISTS app_marketplace_listings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- One listing per application. The application is global; the listing is
  -- the offer, and an application cannot be offered twice.
  application_id        UUID NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,

  -- Who is offering it. Not company-scoped: the whole point is that other
  -- companies can see this row.
  publisher_company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  published_by          UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The version a buyer gets. Pinned rather than "latest", because the
  -- publisher's next Studio iteration must not silently become what strangers
  -- install — they stand behind a specific design.
  version_id            UUID NOT NULL REFERENCES application_versions(id) ON DELETE RESTRICT,

  -- How it is described to people who have never seen it. Separate from the
  -- application's own description, which was written for its author.
  summary               TEXT NOT NULL,
  category              TEXT,

  price_cents           INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'USD',

  status                TEXT NOT NULL DEFAULT 'listed',
  listed_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_marketplace_status   CHECK (status IN ('listed', 'withdrawn')),
  CONSTRAINT chk_marketplace_price    CHECK (price_cents >= 0),
  CONSTRAINT chk_marketplace_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_marketplace_summary  CHECK (length(btrim(summary)) BETWEEN 10 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listed
  ON app_marketplace_listings (status, listed_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_publisher
  ON app_marketplace_listings (publisher_company_id);

COMMENT ON TABLE app_marketplace_listings IS
  'An application offered to other companies. Deliberately NOT company-scoped: every company must be able to read it. price_cents is recorded and displayed; nothing here charges anybody.';
COMMENT ON COLUMN app_marketplace_listings.version_id IS
  'The version strangers install. Pinned, so the publisher''s next iteration does not silently become what others receive.';
