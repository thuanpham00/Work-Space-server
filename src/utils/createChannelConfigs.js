require('dotenv/config')
const { PrismaPg } = require('@prisma/adapter-pg')
const { PrismaClient } = require('../generated/prisma/client')
const { Pool } = require('pg')

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  const channels = await prisma.channel.findMany();

  console.log(`Found ${channels.length} channels`);

  for (const channel of channels) {
    await prisma.channelConfig.upsert({
      where: { channelId: channel.id },
      update: {
        backgroundUrl: '#18181b',
        accent: '#ef4815',
      },
      create: {
        channelId: channel.id,
        backgroundUrl: '#18181b',
        accent: '#ef4815',
      },
    });
    console.log(`Created/Updated ChannelConfig for channel ID: ${channel.id}`);
  }

  console.log('Done!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
