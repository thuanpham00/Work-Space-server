import jwt from 'jsonwebtoken'
import { TokenPayload } from '~/models/responses/user.responses'

type SignOptions = {
  expiresIn?: string | number
  algorithm?: string
}

export const signToken = ({
  payload,
  privateKey,
  options = {
    algorithm: 'HS256'
  }
}: {
  payload: string | Buffer | object
  privateKey: string
  options?: SignOptions
}) => {
  return new Promise<string>((resolve, reject) => {
    jwt.sign(payload, privateKey, options as jwt.SignOptions, (error, code) => {
      if (error) {
        return reject(error)
      }
      resolve(code as string)
    })
  })
}

export const verifyToken = ({ token, privateKey }: { token: string; privateKey: string }) => {
  return new Promise<TokenPayload>((resolve, reject) => {
    jwt.verify(token, privateKey, (error, decode) => {
      if (error) {
        return reject(error)
      }
      resolve(decode as TokenPayload)
    })
  })
}
