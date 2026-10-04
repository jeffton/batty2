import { spawn } from "node:child_process";
import fs from "node:fs/promises";

/** flock arbitrates atomically; the kernel releases it when the owner exits. */
export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const holder = spawn(
    "flock",
    ["--exclusive", "--nonblock", lockPath, "sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let acquired = false;
  let releasing = false;
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    holder.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.includes("locked\n") && !acquired) {
        acquired = true;
        resolve();
      }
    });
    holder.stderr.on("data", (data: Buffer) => {
      errorOutput += data.toString();
    });
    holder.once("error", reject);
    holder.once("exit", (code) => {
      if (!acquired)
        reject(
          new Error(
            code === 1
              ? `Another Batty2 process owns ${lockPath}`
              : `Storage lock failed: ${errorOutput.trim()}`,
          ),
        );
      else if (!releasing) {
        console.error("Storage lock lost", lockPath);
        process.exit(1);
      }
    });
  });
  await fs.chmod(lockPath, 0o600);
  return async () => {
    releasing = true;
    holder.stdin.end();
    await exited;
  };
}
