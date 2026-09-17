/** Layout-owned Desktop update copy; common words still use the shared dictionary. */
export const zh = {
  'desktopUpdate.available': '新版本可用',
  'desktopUpdate.review': '查看更新',
  'desktopUpdate.reviewing': '正在打开…',
  'desktopUpdate.safe': '不会自动安装或重启',
  'desktopUpdate.installing': '正在准备更新…',
  'desktopUpdate.ready': '更新已准备就绪',
  'desktopUpdate.failed': '更新暂未完成，请重试',
  'desktopUpdate.reviewFailed': '无法打开更新确认，请从应用菜单检查更新。',
} as const

/** Layout locale keys shared by the renderer and locale registration. */
export type LayoutKey = keyof typeof zh

/** English Desktop update copy, checked against the Chinese key set. */
export const en = {
  'desktopUpdate.available': 'Update available',
  'desktopUpdate.review': 'Review update',
  'desktopUpdate.reviewing': 'Opening…',
  'desktopUpdate.safe': 'No automatic installation or restart',
  'desktopUpdate.installing': 'Preparing update…',
  'desktopUpdate.ready': 'Update ready',
  'desktopUpdate.failed': 'Update incomplete. Try again.',
  'desktopUpdate.reviewFailed': 'Could not open update confirmation. Check for updates in the application menu.',
} satisfies Record<LayoutKey, string>
