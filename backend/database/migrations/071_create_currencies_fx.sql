-- Multi-currency support: currency master + dated exchange rates.
-- Amounts elsewhere in the ERP already store a currency code; this provides the
-- authoritative currency list and the rates used to convert to the base
-- currency for reporting and FX conversion.

CREATE TABLE IF NOT EXISTS currencies (
    code VARCHAR(3) PRIMARY KEY,            -- ISO 4217, e.g. USD, EUR
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(8),
    is_base BOOLEAN NOT NULL DEFAULT false, -- exactly one base currency
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exchange_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
    to_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
    rate DECIMAL(18,8) NOT NULL,            -- 1 from_currency = rate to_currency
    rate_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_exchange_rate UNIQUE (from_currency, to_currency, rate_date),
    CONSTRAINT chk_rate_positive CHECK (rate > 0)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair ON exchange_rates(from_currency, to_currency, rate_date DESC);

-- Seed a base currency (USD) if the table is empty.
INSERT INTO currencies (code, name, symbol, is_base, is_active)
SELECT 'USD', 'US Dollar', '$', true, true
WHERE NOT EXISTS (SELECT 1 FROM currencies);

-- A few common currencies (only if absent)
INSERT INTO currencies (code, name, symbol, is_active)
SELECT * FROM (VALUES
    ('EUR', 'Euro', '€', true),
    ('GBP', 'British Pound', '£', true),
    ('AED', 'UAE Dirham', 'د.إ', true),
    ('AZN', 'Azerbaijani Manat', '₼', true)
) AS v(code, name, symbol, is_active)
WHERE NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v.code);

COMMENT ON TABLE currencies IS 'Currency master with a single base currency';
COMMENT ON TABLE exchange_rates IS 'Dated exchange rates (1 from = rate to)';
