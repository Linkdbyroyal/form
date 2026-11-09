import { seed, seedHandleFromEnv } from "../seed";
import { urlFor } from "./_env";

const handle = seedHandleFromEnv(urlFor(process.argv));
try {
  const result = await seed(handle);
  console.log("seeded tenants:", Object.keys(result.tenantIds).join(", "));
  console.log("seeded users:", Object.keys(result.userIds).join(", "));
} finally {
  await handle.close();
}
