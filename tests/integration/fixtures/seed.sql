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
