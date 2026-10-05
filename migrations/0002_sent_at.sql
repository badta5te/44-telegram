-- NULL means claimed by a poll but the alert is not confirmed sent yet.
ALTER TABLE seen ADD COLUMN sent_at TEXT;
UPDATE seen SET sent_at = first_seen_at;
