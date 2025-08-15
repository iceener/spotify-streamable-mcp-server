import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { oauthRoutes } from "./auth/oauth.ts";

export function buildAuthApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route("/", oauthRoutes());
  return app;
}
