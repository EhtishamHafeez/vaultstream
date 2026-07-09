CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer REFERENCES customers(id),
  total_cents integer NOT NULL
);

CREATE TABLE notes (
  id serial PRIMARY KEY,
  body text
);

INSERT INTO customers (name, email) VALUES
  ('Ada Lovelace', 'ada@example.com'),
  ('Grace Hopper', 'grace@example.com'),
  ('Alan Turing', 'alan@example.com');

INSERT INTO orders (customer_id, total_cents) VALUES
  (1, 1999),
  (1, 4599),
  (2, 999),
  (3, 12599);

INSERT INTO notes (body) VALUES
  ('first note'),
  ('second note'),
  ('third note'),
  ('fourth note'),
  ('fifth note');

-- Stand-ins for Supabase's "auth" and "storage" schemas — dumped by default
-- alongside "public".
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id serial PRIMARY KEY,
  email text NOT NULL
);
INSERT INTO auth.users (email) VALUES
  ('ada@example.com'),
  ('grace@example.com');

CREATE SCHEMA storage;
CREATE TABLE storage.objects (
  id serial PRIMARY KEY,
  bucket text NOT NULL,
  name text NOT NULL
);
INSERT INTO storage.objects (bucket, name) VALUES
  ('avatars', 'ada.png'),
  ('avatars', 'grace.png'),
  ('uploads', 'invoice.pdf');

-- Stand-in for Supabase's internal "realtime" schema — this is exactly what
-- produced "permission denied for schema realtime" when pg_dump wasn't
-- scoped to explicit schemas. The restricted role below is deliberately NOT
-- granted anything here, so an unscoped/misconfigured dump fails the same
-- way it would against a real Supabase project.
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (
  id serial PRIMARY KEY,
  payload text
);
INSERT INTO realtime.messages (payload) VALUES ('msg1'), ('msg2');

-- The restricted role vaultstream_backup would actually use in production —
-- granted only on public/auth/storage, mirroring the README's role SQL.
CREATE ROLE vaultstream_backup_test WITH LOGIN PASSWORD 'test_password_only';

GRANT USAGE ON SCHEMA public TO vaultstream_backup_test;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vaultstream_backup_test;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO vaultstream_backup_test;

GRANT USAGE ON SCHEMA auth TO vaultstream_backup_test;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO vaultstream_backup_test;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA auth TO vaultstream_backup_test;

GRANT USAGE ON SCHEMA storage TO vaultstream_backup_test;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO vaultstream_backup_test;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA storage TO vaultstream_backup_test;

-- Deliberately no grant on "realtime".
