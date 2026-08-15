import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { v4 as uuidv4 } from 'uuid'
import { envConfig } from '~/utils/config'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { Media } from '~/models/responses/media.response'

class R2Service {
  private client: S3Client
  private bucketName: string
  private publicLink: string

  constructor() {
    this.client = new S3Client({
      region: 'auto',
      endpoint: envConfig.r2_endpoint,
      credentials: {
        accessKeyId: envConfig.r2_access_key_id,
        secretAccessKey: envConfig.r2_secret_access_key
      }
    })
    this.bucketName = envConfig.r2_bucket_name
    this.publicLink = envConfig.r2_link_public
  }

  async uploadImage(buffer: Buffer, link: string): Promise<Media> {
    const meta = await sharp(buffer).metadata()
    const allowedFormats = ['jpeg', 'png', 'webp', 'gif', 'avif']
    if (!meta.format || !allowedFormats.includes(meta.format)) {
      throw new ErrorWithStatus({
        message: 'Định dạng ảnh không hợp lệ (chỉ chấp nhận jpeg, png, webp, gif, avif)',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format
    const fileName = `${uuidv4()}.${ext}`
    const key = link + `/${fileName}`

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: `image/${meta.format}`,
        CacheControl: 'public, max-age=31536000'
      })
    )

    const baseLink = this.publicLink.startsWith('http') ? this.publicLink : `https://${this.publicLink}`

    return {
      id: uuidv4(),
      url: `${baseLink}/${key}`,
      key,
      name: fileName,
      width: meta.width || 0,
      height: meta.height || 0,
      size: buffer.length,
      type: 'image/' + meta.format
    }
  }
}

export default new R2Service()
