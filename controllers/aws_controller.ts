import { ModerationLabel } from '@aws-sdk/client-rekognition'
import IContext from '../core/interfaces/context'
import useService from '../services'

const service = useService()

const awsController = {
  rekognition: {
    imageModeration: {
      examples: (c: IContext) => c.res.success(service.aws.rekognition.imageModeration.examples()),
      create: async (c: IContext) => {
        const url = c.req.body['url']
        const token = c.req.body['token']
        if (!url || !token) return Promise.reject({ message: 'invalid request' })

        try {
          const user = await service.chat.getUser(token)
          if (!user) return Promise.reject({ message: 'invalid token' })

          const result = await service.aws.rekognition.imageModeration.create(url) as { ModerationLabels: Array<ModerationLabel> }
          if (
            !service.aws.rekognition.imageModeration.examples().includes(url) && // 이미지 검사기 예시 이미지는 제외
            result.ModerationLabels.some(service.aws.rekognition.imageModeration.isGraphicLabel)
          ) {
            service.slack.postMessage({
              text: `
                이미지 검사기가 사용되었습니다.
                유저: *${(user.profile || {}).nickname}* (${c.req.ip} / ${token})
  
                ${url}
              `,
              channel: 'image-moderation',
            })
          }
          c.res.success(result)
        } catch (e) {
          c.res.failed(e)
        }
      },
      all: async (c: IContext) => {
        try {
          const data = await service.aws.rekognition.imageModeration.all()
          c.res.asJSON({
            total: Object.keys(data || {}).length,
            data,
          })
        } catch (e) {
          c.res.failed(e)
        }
      },
      delete: async (c: IContext) => {
        try {
          const data = await service.aws.rekognition.imageModeration.delete(c.req.body['url'])
          c.res.asJSON({
            total: Object.keys(data || {}).length,
            data,
          })
        } catch (e) {
          c.res.failed(e)
        }
      },
      deleteBulk: async (c: IContext) => {
        try {
          const data = await service.aws.rekognition.imageModeration.deleteBulk(c.req.body['deleteAll'])
          c.res.asJSON({
            total: Object.keys(data || {}).length,
            data,
          })
        } catch (e) {
          c.res.failed(e)
        }
      },
    },
  },
  s3: {
    getSignedUrl: async (c: IContext) => {
      try {
        const url = await service.aws.s3.getSignedUrl({
          key: c.req.query['key'] || '',
          tagging: c.req.query['tagging'] || '',
          nouuid: c.req.query['noUuid'],
        })
        c.res.success(url)
      } catch (e) {
        c.res.failed(e)
      }
    },
    deleteObjectTagging: (c: IContext) => service.aws.s3.deleteObjectTagging(c.req.body['key']),
    deleteObject: (c: IContext) => service.aws.s3.deleteObject(c.req.body['key']),
  },
}

export default awsController