import helpers from '../core/helpers'

// channelUrl은 방송을 껐다 켜도 변하지 않는 값이라 라이브 화면 자동 캡처의 기준으로 쓴다.
// link는 화면 표시/이동용이라 watch URL이 들어올 수 있다.
export default [{
  'image': helpers.useCdn('images/influencers/hodu_park.jpg'),
  'name': '박호두(852hodoo)',
  'link': 'https://www.youtube.com/@852hodoo',
  'channelUrl': 'https://www.youtube.com/@852hodoo',
}, {
  'image': 'https://stimg.afreecatv.com/LOGO/cy/cyzhgw/cyzhgw.jpg',
  'name': '금융인 짭구',
  'link': 'https://www.youtube.com/@zzap9',
  'channelUrl': 'https://www.youtube.com/@zzap9',
}, {
  'image': helpers.useCdn('images/influencers/saddo.png'),
  'name': '스트리머 사또 live-streamer satto',
  'link': 'https://www.youtube.com/@live-streamersatto',
  'channelUrl': 'https://www.youtube.com/@live-streamersatto',
}, {
  'image': 'https://yt3.googleusercontent.com/ytc/AGIKgqPM3UH1lvXdN5Pxns3lBcNX1l3WhXJNZH-ncETfQA=s176-c-k-c0x00ffffff-no-rj',
  'name': '주식왕용느 (YONGTUBE)',
  'link': 'https://www.youtube.com/@stockking_YN',
  'channelUrl': 'https://www.youtube.com/@stockking_YN',
}, {
  'image': 'https://yt3.googleusercontent.com/HDg4jeTmw2gLIGbJ_kLk2ArDYP97H2gnDe3XrGeAyawGViuF-plxwR6TuuEMm6giWlJYCkB_nQ=s176-c-k-c0x00ffffff-no-rj',
  'name': '웨돔',
  'link': 'https://www.youtube.com/@wedombtc',
  'channelUrl': 'https://www.youtube.com/@wedombtc',
}, {
  'image': 'https://yt3.googleusercontent.com/Jl5NuijG16L862WpdZBRzHI9k_YpV0zkkiqAcGgJEfbna7wHYmkR2dzTDkgN9ymi2hHOiBN6-w=s176-c-k-c0x00ffffff-no-rj',
  // 서버 validate가 이름을 20자 미만으로 제한한다. 채널명은 '자두두 Jadoodoo'다.
  'name': '자두두',
  'link': 'https://www.youtube.com/@jadoodoo',
  'channelUrl': 'https://www.youtube.com/@jadoodoo',
}]
