import type { Sql, TransactionSql } from "postgres";
import { config } from "./runtime-config.js";
import { AppError } from "./errors.js";

export type TransactionContext = {
  networkId?: string;
  contractId?: string;
  txHash: string;
  commandType: string;
  entityType: string;
  entityId: string;
  signerId: string;
  receiptId: string;
  eventIndex: number;
};

export type ConsumptionResult = {
  replay: boolean;
};

type StoredConsumption = {
  command_type: string;
  entity_type: string;
  entity_id: string;
  signer_id: string;
  receipt_id: string;
  event_index: number;
};

/**
 * Records the first use of a verified transaction inside the same database
 * transaction as the ledger/read-model writes. A repeat for the same
 * command/entity/signer is an idempotent replay; any other reuse is rejected.
 */
export async function consumeTransaction(
  transaction: Sql | TransactionSql,
  context: TransactionContext,
): Promise<ConsumptionResult> {
  const networkId = context.networkId ?? config.networkId;
  const contractId = context.contractId ?? config.contractId;

  const [inserted] = await transaction<{ tx_hash: string }[]>`
    insert into transaction_consumptions (
      network_id, contract_id, tx_hash, command_type, entity_type, entity_id,
      signer_id, receipt_id, event_index
    ) values (
      ${networkId}, ${contractId}, ${context.txHash}, ${context.commandType},
      ${context.entityType}, ${context.entityId}, ${context.signerId},
      ${context.receiptId}, ${context.eventIndex}
    )
    on conflict (network_id, contract_id, tx_hash) do nothing
    returning tx_hash
  `;
  if (inserted) return { replay: false };

  const [existing] = await transaction<StoredConsumption[]>`
    select command_type, entity_type, entity_id, signer_id, receipt_id, event_index
    from transaction_consumptions
    where network_id = ${networkId}
      and contract_id = ${contractId}
      and tx_hash = ${context.txHash}
    for update
  `;
  if (!existing) {
    throw new AppError("TX_ALREADY_CONSUMED", "transaction consumption disappeared", 409);
  }
  const matches =
    existing.command_type === context.commandType &&
    existing.entity_type === context.entityType &&
    existing.entity_id === context.entityId &&
    existing.signer_id === context.signerId &&
    existing.receipt_id === context.receiptId &&
    Number(existing.event_index) === context.eventIndex;
  if (!matches) {
    throw new AppError(
      "TX_ALREADY_CONSUMED",
      "transaction was already used for a different command or entity",
      409,
    );
  }
  return { replay: true };
}
