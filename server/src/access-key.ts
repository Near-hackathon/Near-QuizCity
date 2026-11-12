export type FunctionCallPermission = {
  allowance: string | null;
  receiver_id: string;
  method_names: string[];
};

export type AccessKeyPermission = "FullAccess" | { FunctionCall: FunctionCallPermission };

export type AccessKeyView = {
  permission: AccessKeyPermission;
};

export type PayoutKeyPolicy = {
  receiverId: string;
  methods: readonly string[];
  requireAllowance?: boolean;
};

export class AccessKeyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessKeyPolicyError";
  }
}

function functionCallPermission(permission: AccessKeyPermission): FunctionCallPermission {
  if (permission === "FullAccess") {
    throw new AccessKeyPolicyError("key is FullAccess; the server must use a payout-only function-call key");
  }
  if (typeof permission !== "object" || permission === null || !("FunctionCall" in permission)) {
    throw new AccessKeyPolicyError("key permission is not a function-call permission");
  }
  return permission.FunctionCall;
}

export function assertRestrictedPayoutKey(
  permission: AccessKeyPermission,
  policy: PayoutKeyPolicy,
): FunctionCallPermission {
  const functionCall = functionCallPermission(permission);
  if (functionCall.receiver_id !== policy.receiverId) {
    throw new AccessKeyPolicyError(
      `key receiver is ${functionCall.receiver_id}; expected the configured contract ${policy.receiverId}`,
    );
  }

  const methods = functionCall.method_names;
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new AccessKeyPolicyError(
      "key allows every method on the receiver; restrict it to the payout methods",
    );
  }
  const allowed = [...policy.methods].sort();
  const actual = [...methods].sort();
  if (actual.length !== allowed.length || actual.some((method, index) => method !== allowed[index])) {
    throw new AccessKeyPolicyError(
      `key methods are [${actual.join(", ")}]; expected exactly [${allowed.join(", ")}]`,
    );
  }

  if (policy.requireAllowance !== false) {
    if (functionCall.allowance === null) {
      throw new AccessKeyPolicyError("key has no allowance; a finite allowance is required for payout keys");
    }
    let allowance: bigint;
    try {
      allowance = BigInt(functionCall.allowance);
    } catch {
      throw new AccessKeyPolicyError(
        `key allowance is not a valid integer: ${String(functionCall.allowance)}`,
      );
    }
    if (allowance <= 0n) {
      throw new AccessKeyPolicyError("key allowance must be greater than zero");
    }
  }

  return functionCall;
}
