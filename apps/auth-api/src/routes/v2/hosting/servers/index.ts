import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  hostedServerErrorResponse,
  json,
  requestHostedServerService,
  requestUser,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v2/hosting/servers/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json(await requestHostedServerService().list(user));
        } catch (error) {
          return hostedServerErrorResponse(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          return json(
            await requestHostedServerService().create(
              user,
              { name: body.name, size: body.size },
              request.headers.get("Idempotency-Key"),
            ),
            201,
          );
        } catch (error) {
          return hostedServerErrorResponse(error);
        }
      },
    },
  },
});
