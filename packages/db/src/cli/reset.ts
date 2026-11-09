import { resetDatabase } from "../migrate";
import { urlFor } from "./_env";

if (process.env.NODE_ENV === "production") throw new Error("refusing to reset a production database");
const url = urlFor(process.argv);
await resetDatabase(url);
console.log("schema public dropped and recreated");
