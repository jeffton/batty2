import path from "node:path";
import { loadConfig } from "../src/server/config";
import { stateDirPath } from "../src/server/options";
import { acquireLock } from "../src/server/lock";
import { Runtime } from "../src/server/runtime";

const config = await loadConfig(process.argv[2] ?? "/var/lib/batty2");
const release = await acquireLock(path.join(stateDirPath(config.battyDir), "runtime.lock"));
const runtime = await Runtime.open(config, { resume: false });
const timer = setInterval(() => console.log(JSON.stringify(runtime.memory.status())), 5000);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await runtime.close();
  await release();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
console.log("Memory preparation started", runtime.memory.status());
