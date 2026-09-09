import helpers from '../core/helpers'

// channelUrl 하나가 유일한 출처다. 캡처 대상을 정하는 기준이자, 카드에서 '보러 가기'를
// 만드는 근거이기도 하다(핸들 + /live). 방송 URL을 따로 두지 않는 이유는 방송을 껐다 켤
// 때마다 바뀌어서 갱신을 쫓아다녀야 했기 때문이다.
export default [{
  'image': helpers.useCdn('images/influencers/hodu_park.jpg'),
  'name': '박호두(852hodoo)',
  'channelUrl': 'https://www.youtube.com/@852hodoo',
}, {
  'image': 'https://stimg.afreecatv.com/LOGO/cy/cyzhgw/cyzhgw.jpg',
  'name': '금융인 짭구',
  'channelUrl': 'https://www.youtube.com/@zzap9',
}, {
  'image': helpers.useCdn('images/influencers/saddo.png'),
  'name': '스트리머 사또 live-streamer satto',
  'channelUrl': 'https://www.youtube.com/@live-streamersatto',
}, {
  'image': 'https://yt3.googleusercontent.com/ytc/AGIKgqPM3UH1lvXdN5Pxns3lBcNX1l3WhXJNZH-ncETfQA=s176-c-k-c0x00ffffff-no-rj',
  'name': '주식왕용느 (YONGTUBE)',
  'channelUrl': 'https://www.youtube.com/@stockking_YN',
}, {
  'image': 'https://yt3.googleusercontent.com/HDg4jeTmw2gLIGbJ_kLk2ArDYP97H2gnDe3XrGeAyawGViuF-plxwR6TuuEMm6giWlJYCkB_nQ=s176-c-k-c0x00ffffff-no-rj',
  'name': '웨돔',
  'channelUrl': 'https://www.youtube.com/@wedombtc',
}, {
  'image': 'https://yt3.googleusercontent.com/Jl5NuijG16L862WpdZBRzHI9k_YpV0zkkiqAcGgJEfbna7wHYmkR2dzTDkgN9ymi2hHOiBN6-w=s176-c-k-c0x00ffffff-no-rj',
  // 서버 validate가 이름을 20자 미만으로 제한한다. 채널명은 '자두두 Jadoodoo'다.
  'name': '자두두',
  'channelUrl': 'https://www.youtube.com/@jadoodoo',
}]
