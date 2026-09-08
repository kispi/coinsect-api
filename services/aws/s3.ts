import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectTaggingCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import helpers from '../../core/helpers'
import store from '../../store'

const Bucket = 'coinsect-production'

const host = 'https://coinsect-production.s3.ap-northeast-2.amazonaws.com/'

const s3 = new S3Client({
  region: 'ap-northeast-2',
  credentials: {
    accessKeyId: store.state.serverConfig.AWS_ACCESS_KEY_ID,
    secretAccessKey: store.state.serverConfig.AWS_SECRET_ACCESS_KEY,
  },
  // SDK v3 기본값(WHEN_SUPPORTED)은 presigned URL에 빈 body 기준 x-amz-checksum-crc32를 박아버려서
  // 클라이언트가 실제 파일을 PUT하면 BadDigest로 실패한다. v2와 동일하게 체크섬을 붙이지 않는다.
  requestChecksumCalculation: 'WHEN_REQUIRED',
})

const s3Service = {
  getKeyPart: (fullUrl: string) => fullUrl.split(host)[1],
  imageExt: (fileName: string) => {
    if (!fileName || !helpers.isImageUrl(fileName)) return ''

    const splitted = fileName.toLowerCase().split('.')
    return splitted[splitted.length - 1]
  },
  getSignedUrl: async ({ key, tagging, nouuid }) => {
    if (!key) return Promise.reject({ message: 'INVALID_PAYLOAD' })

    const fractions = (key || '').split('/')
    const fileName = fractions[fractions.length - 1]
    const imageExt = s3Service.imageExt(fileName)

    // ADMIN의 경우는 uuid를 생성하지 않고 그냥 어드민에서 입력한 키를 그대로 사용한다.
    const Key = nouuid ?
      key :
      key.split('/').filter(frag => frag).slice(0, -1).join('/') + '/' + helpers.crypto.generateUUID() + '_' + fileName

    try {
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket,
        Key,
        ContentType: 'image/png;image/jpeg;image/jpg;image/gif;image/svg+xml',
        ACL: 'public-read',
        Tagging: tagging || undefined,
      }), { expiresIn: 60 * 1 })
      const resp = { url, headers: {} }
      if (imageExt) resp.headers['Content-Type'] = `image/${imageExt === 'jfif' ? 'jpeg' : imageExt}`
      if (tagging) resp.headers['x-amz-tagging'] = tagging
      return resp
    } catch (e) {
      return Promise.reject(e)
    }
  },
  // 브라우저가 올리는 경로(getSignedUrl)와 달리, 서버가 이미 손에 쥔 바이트를 바로 올린다.
  // 슬랙이 image 블록을 렌더하려면 공개로 읽히는 URL이어야 해서 public-read로 둔다.
  putObject: async ({ key, body, contentType }: { key: string, body: Buffer, contentType: string }) => {
    await s3.send(new PutObjectCommand({
      Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ACL: 'public-read',
    }))
    return host + key
  },
  deleteObject: (Key: string) => s3.send(new DeleteObjectCommand({
    Bucket,
    Key,
  })),
  deleteObjectTagging: (Key: string) => s3.send(new DeleteObjectTaggingCommand({
    Bucket,
    Key,
  })),
}

export default s3Service
