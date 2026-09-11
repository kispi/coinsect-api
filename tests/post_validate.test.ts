import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Post } from '../entities/post'
import store from '../store'

const maxlength = store.state.globalVariables.maxlength

const payload = (over: Partial<Post> = {}) => ({
  title: '제목',
  content: '본문',
  nickname: '닉네임',
  ...over,
}) as Post

test('본문 길이 상한이 정의되어 있다', () => {
  // 상한이 없으면 익명 글쓰기가 그대로 임베딩 비용 주입 통로가 된다.
  assert.ok(maxlength.postContent > 0)
})

test('상한 안쪽 본문은 통과한다', async () => {
  await Post.validate(payload({ content: '가'.repeat(maxlength.postContent) }))
})

test('상한을 넘는 본문은 거절한다', async () => {
  await assert.rejects(
    Post.validate(payload({ content: '가'.repeat(maxlength.postContent + 1) })),
    (e: { message: string }) => e.message === 'CONTENT_TOO_LONG',
  )
})

test('1MB 본문은 통과하지 못한다', async () => {
  // 1MB면 약 1,250청크 · 약 83만 토큰 · 글 하나에 약 $0.12이고, 수정할 때마다 다시 든다.
  await assert.rejects(
    Post.validate(payload({ content: '가'.repeat(1024 * 1024) })),
    (e: { message: string }) => e.message === 'CONTENT_TOO_LONG',
  )
})

test('이미 쓰인 길이의 글은 막지 않는다', async () => {
  // 자유게시판 평균 약 2,200자, 블로그 평균 약 5,700자다(2026-09-11 코퍼스 실측).
  // 상한이 이것들을 걸러 기존 글의 수정이 막히면 안 된다.
  await Post.validate(payload({ content: '가'.repeat(2200) }))
  await Post.validate(payload({ content: '가'.repeat(5700) }))
})

test('제목 상한은 그대로다', async () => {
  await assert.rejects(
    Post.validate(payload({ title: '가'.repeat(maxlength.postTitle + 1) })),
    (e: { message: string }) => e.message === 'TITLE_TOO_LONG',
  )
})
