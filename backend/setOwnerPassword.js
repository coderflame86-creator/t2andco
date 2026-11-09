// Sets the owner dashboard login: npm run set-owner-password
// Asks for a username and password (the password is not shown while typing) and saves
// OWNER_USERNAME and a hash of the password (never the password itself) in .env. Restart the server afterwards.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./ownerAuth.js";

const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const MIN_LENGTH = 12;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const showTyping = rl._writeToOutput.bind(rl);

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl._writeToOutput = showTyping;
      resolve(answer);
    });
    if (hidden) rl._writeToOutput = (text) => text.includes("\n") && showTyping("\n");
  });
}

function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
}

const username = (await ask("Owner username: ")).trim();
const password = await ask(`Password (at least ${MIN_LENGTH} characters): `, true);
const repeat = await ask("Type the password again: ", true);
rl.close();

if (!/^[\w.@-]{3,60}$/.test(username)) {
  console.error("Username must be 3 to 60 letters, numbers, dots, dashes, underscores or @.");
  process.exit(1);
}
if (password.length < MIN_LENGTH) {
  console.error(`Password must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
if (password !== repeat) {
  console.error("The two passwords don't match.");
  process.exit(1);
}

let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
env = setEnvValue(env, "OWNER_USERNAME", username);
env = setEnvValue(env, "OWNER_PASSWORD_HASH", hashPassword(password));
fs.writeFileSync(ENV_FILE, env);
console.log("Owner login saved in .env. Restart the server, then open /owner to log in.");
