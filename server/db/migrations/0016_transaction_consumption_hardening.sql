-- R3-05: bounded transaction-consumption identities and complete proof matching.

alter table transaction_consumptions
  add constraint transaction_consumptions_network_len check (
    length(network_id) between 1 and 32
  ),
  add constraint transaction_consumptions_contract_len check (
    length(contract_id) between 2 and 64
  ),
  add constraint transaction_consumptions_tx_len check (
    length(tx_hash) between 1 and 128
  ),
  add constraint transaction_consumptions_command_len check (
    length(command_type) between 1 and 64
  ),
  add constraint transaction_consumptions_entity_type_len check (
    length(entity_type) between 1 and 64
  ),
  add constraint transaction_consumptions_entity_id_len check (
    length(entity_id) between 1 and 128
  ),
  add constraint transaction_consumptions_signer_len check (
    length(signer_id) between 2 and 64
  ),
  add constraint transaction_consumptions_receipt_len check (
    length(receipt_id) between 1 and 128
  );
