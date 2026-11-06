// Guard for local test scripts: refuses anything but a throwaway MongoDB on this
// machine (mongodb://localhost, 127.0.0.1 or ::1). Atlas (mongodb+srv://,
// *.mongodb.net), any other host, a production-looking database name and
// NODE_ENV=production are all refused. Never prints the connection string.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertLocalMongo(uri, dbName = "") {
  const refuse = (why) => {
    throw new Error(`Refusing to run: ${why}. These scripts only use a throwaway local MongoDB.`);
  };
  if (process.env.NODE_ENV === "production") refuse("NODE_ENV is production");
  if (typeof uri !== "string" || !uri) refuse("no MongoDB connection string");
  if (!uri.startsWith("mongodb://")) refuse("only mongodb:// on this machine is allowed (mongodb+srv / Atlas is not)");
  if (/mongodb\.net|atlas/i.test(uri)) refuse("the connection string points at MongoDB Atlas");
  const hostPart = uri.slice("mongodb://".length).split("/")[0].split("@").pop();
  const hosts = hostPart.split(",").map((h) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]).toLowerCase());
  if (!hosts.length || !hosts.every((h) => LOCAL_HOSTS.has(h))) refuse("the database host is not this machine");
  if (/prod|live|main/i.test(dbName)) refuse(`the database name "${dbName}" looks like a real environment`);
}
