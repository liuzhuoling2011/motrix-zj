import bilibili from '@/assets/sites/bilibili.svg'
import youku from '@/assets/sites/youku.svg'
import iqiyi from '@/assets/sites/iqiyi.svg'
import tencent from '@/assets/sites/tencent.svg'
import mgtv from '@/assets/sites/mgtv.svg'
import youtube from '@/assets/sites/youtube.svg'

export interface Site {
  id: string
  name: string
  url: string
  icon: string
}

export const SITES: Site[] = [
  { id: 'bilibili', name: 'Bilibili', url: 'https://www.bilibili.com', icon: bilibili },
  { id: 'youku', name: '优酷', url: 'https://www.youku.com', icon: youku },
  { id: 'iqiyi', name: '爱奇艺', url: 'https://www.iqiyi.com', icon: iqiyi },
  { id: 'tencent', name: '腾讯视频', url: 'https://v.qq.com', icon: tencent },
  { id: 'mgtv', name: '芒果TV', url: 'https://www.mgtv.com', icon: mgtv },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', icon: youtube },
]
