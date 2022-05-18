import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { encode as encodeToHex } from "https://deno.land/std/encoding/hex.ts";
import * as pathLib from "https://deno.land/std/path/mod.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";
import dir from "https://deno.land/x/dir/mod.ts";

interface RawArchive {
  tarball: string;
  shasum: string;
  size: string;
}

interface Archive {
  version: string;
  platform: string;
  size: number;
  shasum: string;
  url: URL;
  filePath: string;
  dirPath: string;
}

function archiveDir(path: string): string {
  const i = path.lastIndexOf(".tar");
  if (i !== -1) {
    return path.slice(0, i);
  }
  const parts = pathLib.parse(path);
  if (parts.ext === ".zip") {
    return parts.name;
  }
  throw new Error(`unknown archive extension for ${path}`);
}

function archiveFromRaw(
  raw: RawArchive,
  version: string,
  platform: string,
): Archive {
  const { tarball, shasum, size } = raw;
  const url = new URL(tarball);
  const filePath = pathLib.basename(url.pathname);
  const dirPath = archiveDir(filePath);
  return {
    version,
    platform,
    size: Number(size),
    shasum,
    url,
    filePath,
    dirPath,
  };
}

type PlatformName = string;

interface RawRelease extends Record<string, string | undefined | RawArchive> {
  date: string;
  docs: string;
  stdDocs?: string;
  notes?: string;
}

interface ReleaseMeta {
  version: string;
  date: Date;
  docs: URL;
  stdDocs?: URL;
  notes?: URL;
}

interface Release {
  meta: ReleaseMeta;
  platforms: Record<PlatformName, Archive>;
}

type Releases = Record<PlatformName, Release>;

function releaseFromRaw(raw: RawRelease, version: string): Release {
  const { date, docs, stdDocs, notes } = raw;
  const meta = {
    version,
    date: new Date(date),
    docs: new URL(docs),
    stdDocs: stdDocs ? new URL(stdDocs) : undefined,
    notes: notes ? new URL(notes) : undefined,
  };
  const platforms = Object.fromEntries(
    Object.entries(raw)
      .filter((kv): kv is [PlatformName, RawArchive] => {
        const [key, value] = kv;
        return !Object.hasOwn(meta, key) && typeof value === "object";
      })
      .map((
        [platform, rawArchive],
      ) => [platform, archiveFromRaw(rawArchive, version, platform)]),
  );
  return {
    meta,
    platforms,
  };
}

async function downloadReleaseInfo(): Promise<Releases> {
  const response = await fetch("https://ziglang.org/download/index.json");
  const raw = await response.json() as Record<PlatformName, RawRelease>;
  return Object.fromEntries(
    Object.entries(raw)
      .map((
        [version, rawRelease],
      ) => [version, releaseFromRaw(rawRelease, version)]),
  );
}

type Json = unknown[] | Record<string, unknown>;

async function runZigToJson<T extends object = Json>(
  args: string[],
): Promise<T | undefined> {
  let process;
  try {
    process = Deno.run({
      cmd: ["zig", ...args],
      stdout: "piped",
    });
  } catch (e) {
    if (e.name === "NotFound") {
      return;
    } else {
      throw e;
    }
  }
  const stdoutBuffer = await process.output();
  const stdoutString = new TextDecoder().decode(stdoutBuffer);
  const json = JSON.parse(stdoutString);
  return json as T;
}

interface Platform {
  arch: string;
  os: string;
}

async function getCurrentPlatform(): Promise<Platform> {
  const targets = await runZigToJson<{
    native: {
      triple: string;
      cpu: {
        arch: string;
        name: string;
        features: string[];
      };
      os: string;
      abi: string;
    };
  }>(["targets"]);
  if (!targets) {
    return Deno.build;
  }
  const { native: { cpu: { arch }, os } } = targets;
  return { arch, os };
}

interface ZigEnv {
  zig_exe: string;
  lib_dir: string;
  std_dir: string;
  global_cache_dir: string;
  version: string;
}

async function getZigEnv(): Promise<ZigEnv | undefined> {
  return await runZigToJson<ZigEnv>(["env"]);
}

function getReleaseWithVersion(
  releases: Releases,
  version: string,
): Release {
  return version === "latest"
    ? Object.values(releases).filter((e) => e.meta.version !== "master")[0]
    : releases[version];
}

async function computeHash(
  buffer: BufferSource,
  algorithm: AlgorithmIdentifier,
): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, buffer);
  const hex = encodeToHex(new Uint8Array(digest));
  return new TextDecoder().decode(hex);
}

function checkIf<T>(
  log: boolean,
  what: string,
  expected: T,
  actual: T,
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
) {
  const isEq = eq(expected, actual);
  if (!isEq && log) {
    console.log(`${what} does not match: expecting ${expected}, got ${actual}`);
  }
  return isEq;
}

async function checkArchiveBuffer(
  download: Archive,
  buffer: BufferSource,
  { log }: { log: boolean } = { log: false },
): Promise<boolean> {
  return checkIf(log, "archive size", download.size, buffer.byteLength) &&
    checkIf(
      log,
      "archive shasum",
      download.shasum,
      await computeHash(buffer, "sha-256"),
    );
}

async function fetchArchive(
  archive: Archive,
): Promise<ArrayBuffer> {
  console.log(`downloading archive: ${archive.url.href}`);
  const response = await fetch(archive.url.href);
  const buffer = await response.arrayBuffer();
  assert(await checkArchiveBuffer(archive, buffer));
  return buffer;
}

async function saveArchive(archive: Archive) {
  let buffer;
  try {
    buffer = await Deno.readFile(archive.filePath);
  } catch {
    buffer = undefined;
  }
  if (buffer && checkArchiveBuffer(archive, buffer, { log: true })) {
    console.log(`archive already downloaded: ${archive.filePath}`);
    return;
  }
  buffer = await fetchArchive(archive);
  await Deno.writeFile(archive.filePath, new Uint8Array(buffer));
}

function quote(s: string): string {
  return s.includes(" ") ? `'${s}'` : s;
}

async function unpackArchive(archive: Archive) {
  let stats;
  try {
    stats = await Deno.stat(archive.dirPath);
  } catch {
    stats = undefined;
  }
  if (stats?.isDirectory) {
    console.log(`archive already unpacked: ${archive.dirPath}`);
    return;
  }
  const cmd = ["tar", "xf", archive.filePath];
  const cmdString = cmd.map(quote).join(" ");
  console.log(`unpacking archive: ${archive.filePath}`);
  console.log(`running: ${cmdString}`);
  const status = await Deno.run({
    cmd,
  }).status();
  if (!status.success) {
    throw new Error(`error running: ${cmdString}`);
  }
}

const currentLinkName = "current";

async function setArchiveToCurrent(archive: Archive) {
  let currentLink;
  try {
    currentLink = await Deno.readLink(currentLinkName);
  } catch {
    currentLink = undefined;
  }
  if (archive.dirPath === currentLink) {
    console.log(`version already set to ${archive.version}`);
  } else {
    console.log(`setting version to ${archive.version}`);
  }
  const tempPath = `${archive.dirPath}.${currentLinkName}`;
  await Deno.symlink(archive.dirPath, tempPath);
  await Deno.rename(tempPath, currentLinkName);
  const zigEnv = await getZigEnv();
  if (
    zigEnv?.zig_exe ===
      await Deno.realPath(pathLib.join(currentLinkName, "zig"))
  ) {
    // on path
  } else {
    const currentZigDir = pathLib.join(Deno.cwd(), currentLinkName);
    console.log(
      `add zig dir to $PATH: ${currentZigDir}\n` +
        `or zig binary to a dir on $PATH: ${
          pathLib.join(currentZigDir, "zig")
        }`,
    );
  }
}

async function updateArchive(archive: Archive) {
  await saveArchive(archive);
  await unpackArchive(archive);
}

async function removeArchive(archive: Archive) {
  await Deno.remove(archive.dirPath, { recursive: true });
  await Deno.remove(archive.filePath);
}

async function main() {
  const args = parse(Deno.args, {
    alias: {
      "rm": "remove",
      "delete": "remove",
    },
    default: {
      "version": "latest",
      "set": true,
    },
    boolean: ["remove", "set"],
  });
  console.log(args);
  const zigDir = args.dir ?? (() => {
    const homeDir = dir("home");
    if (!homeDir) {
      throw new Error(`can't find home directory`);
    }
    return pathLib.join(homeDir, ".zig");
  })();
  Deno.mkdir(zigDir, { recursive: true });
  console.log(`cd ${quote(zigDir)}`);
  Deno.chdir(zigDir);
  const releases = await downloadReleaseInfo();
  const platform = await getCurrentPlatform();
  const release = getReleaseWithVersion(releases, args.version);
  const archive = release.platforms[`${platform.arch}-${platform.os}`];
  if (args.remove) {
    await removeArchive(archive);
  } else {
    await updateArchive(archive);
    if (args.set) {
      await setArchiveToCurrent(archive);
    }
  }
}

await main();
