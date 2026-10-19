import { unreadQueue } from '~/queues/queue'

async function main() {
  // Push 1 job test
  const job = await unreadQueue.add('test', {
    events: [
      {
        channelId: 10,
        workspaceId: 1,
        senderId: 15,
        messageId: 1001,
        createdAt: new Date().toISOString()
      }
    ]
  })
  console.log('Pushed job:', job.id)

  // Đợi worker xử lý
  await new Promise((r) => setTimeout(r, 2000))

  await unreadQueue.close()
  process.exit(0)
}

main().catch(console.error)
