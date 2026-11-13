-- R3-01: bind the stored nonce to the exact signed payload.

alter table auth_nonces
  add column if not exists message_hash text;

alter table auth_nonces
  add constraint auth_nonces_message_hash_check check (
    message_hash is null or (message_hash <> '' and length(message_hash) = 64)
  );
