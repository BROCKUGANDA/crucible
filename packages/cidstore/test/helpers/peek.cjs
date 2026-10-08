/**
 * Reads the store directory the way another process would: no imports from the package,
 * only the filesystem and node's crypto. Prints NAME<TAB>SHA256_OF_BYTES<TAB>SIZE per
 * file, so a test can assert that the name a publisher chose is the digest an unrelated
 * reader computes from the content it found.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error(`no such directory: ${String(dir)}`);
  process.exit(2);
}

const lines = fs
  .readdirSync(dir)
  .filter((name) => /^[0-9a-f]{64}$/.test(name))
  .sort()
  .map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    return `${name}\t${digest}\t${bytes.length}`;
  });

process.stdout.write(`${lines.join("\n")}\n`);
