import { config } from 'dotenv'

const envFileName = `.env`
console.log(envFileName)

config({
  path: envFileName
})

export const envConfig = {
  port: process.env.PORT as string,
  secret_key_access_token: process.env.SECRET_KEY_ACCESS_TOKEN as string,
  secret_key_refresh_token: process.env.SECRET_KEY_REFRESH_TOKEN as string,
  secret_key_hash_password: process.env.SECRET_KEY_HASH_PASSWORD as string,

  expire_in_access_token: process.env.EXPIRE_IN_ACCESS_TOKEN as string,
  expire_in_refresh_token: process.env.EXPIRE_IN_REFRESH_TOKEN as string,

  r2_access_key_id: process.env.R2_ACCESS_KEY_ID as string,
  r2_secret_access_key: process.env.R2_SECRET_ACCESS_KEY as string,
  r2_account_id: process.env.R2_ACCOUNT_ID as string,
  r2_bucket_name: process.env.R2_BUCKET_NAME as string,
  r2_endpoint: process.env.R2_ENDPOINT as string,
  r2_link_public: process.env.R2_LINK_PUBLIC as string
}
