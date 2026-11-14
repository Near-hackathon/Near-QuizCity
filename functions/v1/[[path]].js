import { proxyApiRequest } from "../_api-proxy.js";

export const onRequest = ({ request, env }) => proxyApiRequest(request, env);
