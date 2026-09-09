import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseServiceAccount, resolveServiceAccount, MISSING_CREDENTIAL } from '../services/firebase/messaging'

const sample = {
  type: 'service_account',
  project_id: 'coinsect-test',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  client_email: 'sa@coinsect-test.iam.gserviceaccount.com',
}

test('parseServiceAccount: .env 한 줄에 넣은 JSON의 이스케이프를 실제 개행으로 되살린다', () => {
  const oneLine = JSON.stringify(sample)
  assert.ok(oneLine.includes('\\n'), '한 줄 JSON 안에서는 개행이 이스케이프로 들어 있다')

  const parsed = parseServiceAccount(oneLine)

  assert.equal(parsed.project_id, 'coinsect-test')
  assert.ok(parsed.private_key.includes('\n'), '개행이 이스케이프로 남아 있으면 서명이 깨진다')
  assert.ok(!parsed.private_key.includes('\\n'), '역슬래시 n이 그대로 남으면 안 된다')
})

test('parseServiceAccount: base64로 넣어도 같은 결과가 나온다', () => {
  const encoded = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64')
  assert.deepEqual(parseServiceAccount(encoded), parseServiceAccount(JSON.stringify(sample)))
})

test('parseServiceAccount: 필수 필드가 빠지면 던진다', () => {
  const { private_key, ...withoutKey } = sample
  assert.throws(() => parseServiceAccount(JSON.stringify(withoutKey)), /private_key/)
})

test('resolveServiceAccount: env가 있으면 파일을 보지 않는다', () => {
  let readFile = false
  const result = resolveServiceAccount(JSON.stringify(sample), () => { readFile = true; return null })

  assert.equal(readFile, false)
  assert.equal(result.serviceAccount.project_id, 'coinsect-test')
  assert.equal(result.error, undefined)
})

test('resolveServiceAccount: env가 없으면 fcm_cert 파일로 폴백한다', () => {
  const result = resolveServiceAccount('', () => sample)

  assert.equal(result.serviceAccount, sample)
  assert.equal(result.error, undefined)
})

test('resolveServiceAccount: 둘 다 없으면 원인을 밝힌 에러를 돌려준다', () => {
  const result = resolveServiceAccount('', () => null)

  assert.equal(result.serviceAccount, undefined)
  assert.equal(result.error, MISSING_CREDENTIAL)
  assert.match(result.error, /FIREBASE_SERVICE_ACCOUNT/)
})

test('resolveServiceAccount: env가 깨져 있으면 파일로 조용히 넘어가지 않는다', () => {
  const result = resolveServiceAccount('{"project_id":', () => sample)

  assert.equal(result.serviceAccount, undefined)
  assert.match(result.error, /FIREBASE_SERVICE_ACCOUNT/)
})
