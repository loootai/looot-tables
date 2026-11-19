-- Deployment caps are independent of spent balances and are never reseeded on redeploy.
CREATE TABLE IF NOT EXISTS enrichable.credit_limits (
  kind text PRIMARY KEY CHECK (kind IN ('openai', 'typesafe', 'enrichment')),
  cap_nano bigint NOT NULL CHECK (cap_nano > 0 AND cap_nano <= 9007199254740991)
);
INSERT INTO enrichable.credit_limits (kind, cap_nano) VALUES
  ('openai', 1000000000000),
  ('enrichment', 1000000000000),
  ('typesafe', 100000000000)
ON CONFLICT (kind) DO NOTHING;
