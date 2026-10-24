import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("expire leases", { minutes: 1 }, internal.leases.expire, {});
crons.interval("stop idle sessions", { minutes: 5 }, internal.sessions.stopIdle, {});

export default crons;
