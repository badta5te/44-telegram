CREATE TABLE seen (
  guid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
