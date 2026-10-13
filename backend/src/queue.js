import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const itemQueue = new Queue("item-events", { connection });

export async function enqueueItemCreated(item) {
  await itemQueue.add("item-created", item, {
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
