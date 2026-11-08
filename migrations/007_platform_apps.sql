CREATE TABLE IF NOT EXISTS seller.platform_oauth_apps (
  provider text PRIMARY KEY
    CHECK (provider IN ('nuvemshop','meta','shopify','mercado_livre','shopee')),
  app_id text NOT NULL CHECK (char_length(trim(app_id)) > 0),
  client_secret_cipher bytea NOT NULL,
  client_secret_iv bytea NOT NULL,
  client_secret_tag bytea NOT NULL,
  key_version text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES seller.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE seller.platform_oauth_apps IS
  'Credenciais dos aplicativos OAuth da plataforma, configuradas no painel administrativo.';

ALTER TABLE seller.oauth_states DROP CONSTRAINT IF EXISTS oauth_states_provider_check;
ALTER TABLE seller.oauth_states
  ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('nuvemshop','meta','shopify','mercado_livre','shopee'));
