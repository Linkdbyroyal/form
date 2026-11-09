import { runMigrations } from "../migrate";
import { urlFor } from "./_env";

const url = urlFor(process.argv);
const applied = await runMigrations(url, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
