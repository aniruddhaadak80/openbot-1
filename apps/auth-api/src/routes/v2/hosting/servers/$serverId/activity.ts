import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  bearerToken,
  hostedServerErrorResponse,
  requestHostedServerService,
} from "../../../../../server/request-auth";

/** A hosted server reports that it is in use, with the session from its claim. */
export const Route = createFileRoute("/v2/hosting/servers/$serverId/activity")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          await requestHostedServerService().reportActivity(token, params.serverId);
          return new Response(null, { status: 204 });
        } catch (error) {
          return hostedServerErrorResponse(error);
        }
      },
    },
  },
});
