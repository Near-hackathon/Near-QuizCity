/** Server-only answer bank. Client responses contain prompts/options, never this module. */
export const NEAR_CURRICULUM_VERSION = "near-foundations-2026-11";
const docs = "https://docs.near.org";
export type NearQuestion = {
  id: string;
  question: string;
  options: string[];
  correct: number;
  category: string;
  source: string;
  explanation: string;
};
const q = (
  id: string,
  question: string,
  options: string[],
  correct: number,
  path: string,
  explanation: string,
): NearQuestion => ({ id, question, options, correct, category: "near", source: docs + path, explanation });
export const nearQuestionBank: NearQuestion[] = [
  q(
    "near-foundation",
    "What is NEAR Protocol?",
    ["A blockchain for applications", "An email service", "A spreadsheet format"],
    0,
    "/getting-started/what-is-near",
    "NEAR provides blockchain infrastructure for applications.",
  ),
  q(
    "near-sharding",
    "What does sharding help a blockchain do?",
    [
      "Store every task in one browser",
      "Process work across parallel parts of the network",
      "Remove all access keys",
    ],
    1,
    "/getting-started/what-is-near",
    "Sharding spreads processing across parts of the network.",
  ),
  q(
    "near-consensus",
    "Which mechanism helps secure NEAR?",
    ["A password shared by every user", "Printing new banknotes", "Proof of stake"],
    2,
    "/getting-started/what-is-near",
    "NEAR uses proof of stake.",
  ),
  q(
    "near-named",
    "Which is an example of a named NEAR account?",
    ["reader.near", "reader@example.com", "https://reader.near/page"],
    0,
    "/protocol/accounts-contracts/account-model",
    "Named accounts have readable addresses, such as reader.near.",
  ),
  q(
    "near-accounts",
    "Can a NEAR account have more than one access key?",
    ["No, never", "Yes, keys can have different permissions", "Only when its balance is zero"],
    1,
    "/protocol/accounts-contracts/account-model",
    "An account can hold multiple keys with distinct permissions.",
  ),
  q(
    "near-account-code",
    "Where can a NEAR smart contract live?",
    ["Inside an account", "Only in a browser tab", "Inside an email address"],
    0,
    "/protocol/accounts-contracts/account-model",
    "Accounts can hold a smart contract as well as assets and keys.",
  ),
  q(
    "near-full-access",
    "What can a full-access key control?",
    ["Only the game camera", "Only reading a quiz", "The account, including keys and contract deployment"],
    2,
    "/protocol/accounts-contracts/access-keys",
    "Full-access keys have broad account permissions and must be protected.",
  ),
  q(
    "near-function-key",
    "What is a function-call access key useful for?",
    [
      "Changing any account on any chain",
      "Allowing limited calls to a chosen contract",
      "Publishing a private key",
    ],
    1,
    "/protocol/accounts-contracts/access-keys",
    "A function-call key can restrict the receiver and allowed methods.",
  ),
  q(
    "near-private",
    "What should you do with your wallet private key?",
    ["Keep it private and back it up safely", "Post it in a public chat", "Use it as your public username"],
    0,
    "/protocol/accounts-contracts/access-keys",
    "A private key grants signing power; protect it.",
  ),
  q(
    "near-testnet",
    "Where should developers test an application before mainnet?",
    ["A public password list", "NEAR testnet or a local sandbox", "A private-key screenshot"],
    1,
    "/protocol/network/networks",
    "Testnet and local development networks support testing before mainnet.",
  ),
  q(
    "near-networks",
    "Do mainnet and testnet share the same account balances?",
    ["Yes, always", "Only on weekends", "No, their state is separate"],
    2,
    "/protocol/network/networks",
    "Each network maintains its own transactions and state.",
  ),
  q(
    "near-gas",
    "What pays normal NEAR transaction execution fees?",
    ["NEAR tokens", "Quiz City QC automatically becomes NEAR", "Answer points"],
    0,
    "/protocol/transactions/gas",
    "Network gas is paid in native NEAR, separately from game credits.",
  ),
  q(
    "near-extra-gas",
    "Does attaching extra gas make a NEAR transaction execute faster?",
    ["Yes, always", "No; extra attached gas does not buy priority", "Only for quizzes"],
    1,
    "/protocol/transactions/gas",
    "Extra attached gas does not make the transaction faster.",
  ),
  q(
    "near-contract",
    "What is a smart contract?",
    ["A browser colour theme", "An executable program stored on-chain", "A paper-only agreement"],
    1,
    "/smart-contracts/what-is",
    "Smart contracts expose code and state that other accounts can interact with.",
  ),
  q(
    "near-wasm",
    "What is Rust contract code compiled into for NEAR?",
    ["A JPEG image", "A PDF document", "WebAssembly"],
    2,
    "/smart-contracts/what-is",
    "NEAR Rust contracts compile to WebAssembly.",
  ),
  q(
    "near-contract-trigger",
    "What normally starts a smart-contract action?",
    [
      "A call from an account",
      "A character animation by itself",
      "The contract reading a clock and waking itself",
    ],
    0,
    "/smart-contracts/what-is",
    "Contracts act when called; a server can schedule those calls.",
  ),
  q(
    "near-storage",
    "Why must a contract account keep NEAR for storage?",
    ["To change its username every day", "To cover the data held on-chain", "To answer questions faster"],
    1,
    "/protocol/storage/storage-staking",
    "Storage staking reserves native NEAR for stored contract data.",
  ),
  q(
    "near-small-state",
    "Which information belongs off-chain in a city game?",
    [
      "A durable escrow balance",
      "Property ownership enforced by the contract",
      "Every walking animation frame",
    ],
    2,
    "/protocol/storage/storage-staking",
    "Frequent display data belongs off-chain; durable economic rules belong in the contract.",
  ),
  {
    id: "near-intents",
    question: "What do NEAR Intents let a user describe?",
    options: ["A desired outcome for execution", "A private key to publish", "Only a screen resolution"],
    correct: 0,
    category: "near",
    source: "https://near.org/chain-abstraction",
    explanation: "Intents focus on desired outcomes and can support activity across chains.",
  },
];
export function isNearLearningSource(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["near.org", "www.near.org", "docs.near.org", "intents.near.org"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
