import { createHash } from "crypto"
import { config } from "dotenv"
import { envConfig } from "./config"
config()

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

export function hashPassword(password: string) {
  return sha256(password + envConfig.secret_key_hash_password)
}
