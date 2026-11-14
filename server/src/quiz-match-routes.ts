import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type, type Static } from "@sinclair/typebox";
import {
  MatchId,
  SearchMatch,
  JoinPublicMatch,
  PublicMatchQuery,
  PublicMatchesResponse,
  CreateMatch,
  JoinMatch,
  SubmitMatch,
  MatchResponse,
  MatchesResponse,
  CityProof,
} from "@quiz-city/protocol";
import { ErrorResponses } from "./schemas/index.js";
import { requireAuth } from "./auth/plugin.js";
import { AppError } from "./errors.js";
import {
  createQuizMatch,
  listPublicQuizRooms,
  findQuizOpponent,
  joinQuizMatch,
  getQuizMatch,
  submitQuizMatch,
  cancelQuizMatch,
} from "./quiz-matches.js";
import { confirmCityOperation, type CityDeps } from "./city-economy-routes.js";
import { MATCH_VENUE_WALLET } from "./quiz-match-policy.js";
export function registerQuizMatchRoutes(app: FastifyInstance, sql: Sql, overrides: Partial<CityDeps> = {}) {
  const now = overrides.now ?? (() => new Date());
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).accountId;
  const response = { 200: MatchResponse, ...ErrorResponses };
  async function ready() {
    const rows =
      await sql`select wallet_id from wallets where active=true and wallet_id=${MATCH_VENUE_WALLET}`;
    if (rows.length !== 1)
      throw new AppError(
        "CHAIN_UNAVAILABLE",
        "Quiz matches are being prepared. No payment has been requested. Try again shortly.",
        503,
      );
  }
  app.get<{ Querystring: Static<typeof PublicMatchQuery> }>(
    "/quiz-matches/public",
    {
      schema: { querystring: PublicMatchQuery, response: { 200: PublicMatchesResponse, ...ErrorResponses } },
    },
    async (req) => ({ rooms: await listPublicQuizRooms(sql, actor(req), req.query, now()) }),
  );
  app.post<{ Body: Static<typeof SearchMatch> }>(
    "/quiz-matches/search",
    { schema: { body: SearchMatch, response } },
    async (req) => {
      await ready();
      return { match: await findQuizOpponent(sql, actor(req), req.body, now()) };
    },
  );
  app.post<{ Params: { id: string }; Body: Static<typeof JoinPublicMatch> }>(
    "/quiz-matches/public/:id/join",
    { schema: { params: MatchId, body: JoinPublicMatch, response } },
    async (req) => {
      await ready();
      return {
        match: await joinQuizMatch(
          sql,
          actor(req),
          { requestId: req.body.requestId, publicId: req.params.id },
          now(),
        ),
      };
    },
  );
  app.get(
    "/quiz-matches",
    { schema: { response: { 200: MatchesResponse, ...ErrorResponses } } },
    async (req) => {
      const account = actor(req),
        rows =
          await sql`select p.match_id from quiz_match_players p join quiz_matches m on m.id=p.match_id where p.account_id=${account} order by (m.state in ('waiting','countdown','playing','settling')) desc,p.created_at desc,p.id desc limit 20`;
      return { matches: await Promise.all(rows.map((r) => getQuizMatch(sql, account, r.match_id, now()))) };
    },
  );
  app.post<{ Body: Static<typeof CreateMatch> }>(
    "/quiz-matches",
    { schema: { body: CreateMatch, response } },
    async (req) => {
      await ready();
      return { match: await createQuizMatch(sql, actor(req), req.body, now()) };
    },
  );
  app.post<{ Body: Static<typeof JoinMatch> }>(
    "/quiz-matches/join",
    { schema: { body: JoinMatch, response } },
    async (req) => {
      await ready();
      return { match: await joinQuizMatch(sql, actor(req), req.body, now()) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/quiz-matches/:id",
    { schema: { params: MatchId, response } },
    async (req) => ({ match: await getQuizMatch(sql, actor(req), req.params.id, now()) }),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof SubmitMatch> }>(
    "/quiz-matches/:id/submit",
    { schema: { params: MatchId, body: SubmitMatch, response } },
    async (req) => ({
      match: await submitQuizMatch(sql, actor(req), req.params.id, req.body.answers, now()),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/quiz-matches/:id/cancel",
    { schema: { params: MatchId, body: Type.Object({}, { additionalProperties: false }), response } },
    async (req) => ({ match: await cancelQuizMatch(sql, actor(req), req.params.id) }),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof CityProof> }>(
    "/quiz-matches/:id/confirm",
    { schema: { params: MatchId, body: CityProof, response } },
    async (req) => {
      const account = actor(req),
        match = await getQuizMatch(sql, account, req.params.id, now());
      // The participant can confirm only their own frozen escrow intent, never a payout.
      await confirmCityOperation(sql, account, match.operation.id, req.body.txHash, overrides);
      return { match: await getQuizMatch(sql, account, req.params.id, now()) };
    },
  );
}
