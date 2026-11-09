import { operatorContext, type DbHandle } from "@sbos/db";
import { readPlatformBudget } from "@sbos/core";

export const OPERATOR = operatorContext({ actorType: "system", actorId: "worker", roles: ["agency_operator"] });

export async function platformBudget(handle: DbHandle) {
  return handle.withContext(OPERATOR, (tx) => readPlatformBudget(tx));
}
