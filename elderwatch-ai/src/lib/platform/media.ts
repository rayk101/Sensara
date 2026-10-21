import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getS3Bucket } from "../s3";
import { ApiError } from "./auth";
const run = promisify(execFile);
export async function verifyUploadedMedia(key: string): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "sensara-clip-"));
  try {
    const object = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!object.Body || !object.ContentLength || object.ContentLength > 50 * 1024 * 1024) throw new Error("Invalid size");
    const file = join(directory, "recording");
    await writeFile(file, await object.Body.transformToByteArray(), { mode: 0o600 });
    // Decode the complete video track. No remote URL or credentials enter process arguments.
    const { stdout } = await run(process.env.FFMPEG_PATH || ffmpeg || "ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", file, "-map", "0:v:0", "-progress", "pipe:1", "-f", "null", "-"], { timeout: 45000, maxBuffer: 1000000 });
    const times = [...stdout.matchAll(/out_time_us=(\d+)/g)];
    const duration = Number(times.at(-1)?.[1]) / 1_000_000;
    if (!Number.isFinite(duration) || duration < 14 || duration > 20) throw new Error("Incomplete video");
    return duration;
  } catch { throw new ApiError(422, "Video could not be decoded as a complete 15-second clip"); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
