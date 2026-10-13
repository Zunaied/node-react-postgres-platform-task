import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
});

redis.on("error", (err) => {
  console.error("redis connection error:", err.message);
});

export default redis;
