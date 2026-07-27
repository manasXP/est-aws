-- STR-075: GSTIN-driven receipt format switching. GST registration is
-- optional per-society configuration (Finance & Compliance): unset gstin ->
-- plain receipt, set gstin -> GST-compliant format. NULL is a legitimate
-- steady state (not GST-registered), not a misconfiguration -- unlike
-- receipt_prefix (024_society_settings.sql), which throws on its
-- not-yet-configured placeholder, so no NOT NULL/default here.
ALTER TABLE society_settings ADD COLUMN gstin TEXT;
