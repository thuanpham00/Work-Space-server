export type UpdateChannelConfigBody = {
  backgroundColor: string
  backgroundUrl: string
  accent: string
}

export type UpdateChannelNicknameBody = {
  nicknames: ChannelNicknameBody[]
}

export type ChannelNicknameBody = {
  userId: string
  nickname: string
}
