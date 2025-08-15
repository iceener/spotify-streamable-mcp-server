import type { z } from "zod";
import { config } from "../config/env.ts";

export function validateDev<T>(schema: z.ZodType<T>, value: unknown): T {
  if (config.NODE_ENV === "development") {
    return schema.parse(value);
  }
  return value as T;
}
