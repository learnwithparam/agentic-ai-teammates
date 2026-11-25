-- The stories the news teammate may choose from, per company and day. The gateway writes them
-- when it collects, and reads only these back: a model can name a story by its id, never ask
-- the gateway to fetch a link of its own.
CREATE TABLE news_candidates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  day date NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  published_at timestamptz NOT NULL,
  snippet text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company, day, url)
);
